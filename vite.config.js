import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import fs from 'node:fs'

// Strip Eitherway dev harness scripts from the prod `dist/` output.
// They're loaded dynamically from main.jsx only in DEV; the files
// themselves shouldn't ship to production assets.
function excludeDevScriptsPlugin() {
  return {
    name: 'predictflow:exclude-dev-scripts',
    closeBundle() {
      const target = path.resolve(__dirname, 'dist', 'scripts')
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true })
      }
    },
  }
}

// Dev-only mirror of functions/api/dflow-kyc-check.js — probes DFlow /order
// with a tiny canary trade for the given wallet and reports whether DFlow is
// willing to route. The canary outcome mint is cached in-process for 1 hour.
function dflowKycCheckDevPlugin({ upstream, orderUpstream, authHeaders }) {
  const KYC_KEYWORDS = ['kyc', 'not verified', 'verify', 'verification', 'identity', 'proof', 'unverified']
  const COMPLIANCE_KEYWORDS = ['jurisdiction', 'region', 'restricted', 'ineligible', 'geo', 'geoblock', 'blocked', 'country', 'not eligible']
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const PROBE_AMOUNT = 1_000_000
  const CACHE_TTL_MS = 3600 * 1000

  let canaryCache = null

  async function readJson(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    try { return raw ? JSON.parse(raw) : {} } catch { return {} }
  }

  async function getCanaryMint() {
    if (canaryCache && Date.now() - canaryCache.t < CACHE_TTL_MS) return canaryCache.mint
    const target = `${upstream.replace(/\/+$/, '')}/api/v1/markets?status=active&isInitialized=true&limit=20`
    const resp = await fetch(target, { headers: authHeaders || {} })
    if (!resp.ok) return null
    const payload = await resp.json().catch(() => null)
    const markets = Array.isArray(payload?.markets) ? payload.markets : (Array.isArray(payload) ? payload : [])
    for (const m of markets) {
      for (const acct of Object.values(m?.accounts || {})) {
        if (acct?.isInitialized && typeof acct?.yesMint === 'string' && acct.yesMint.length >= 32) {
          canaryCache = { t: Date.now(), mint: acct.yesMint }
          return acct.yesMint
        }
      }
    }
    return null
  }

  function classify(status, text) {
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch {}
    const haystack = (text + ' ' + (parsed?.message || '') + ' ' + (parsed?.error || '') + ' ' + (parsed?.code || '')).toLowerCase()
    const msg = (parsed?.message || parsed?.error || '').toString().trim()
    const kycHit = KYC_KEYWORDS.some(k => haystack.includes(k))
    const complianceHit = COMPLIANCE_KEYWORDS.some(k => haystack.includes(k))
    if (status === 401 || status === 403 || kycHit) return { kind: 'kyc', message: msg || 'Identity verification required to trade.' }
    if (status === 451 || complianceHit) return { kind: 'compliance', message: msg || 'Trading is not available in your region.' }
    return { kind: 'other', message: msg || `Order API ${status}` }
  }

  function isPlausibleSolanaAddress(s) {
    return typeof s === 'string' && s.length >= 32 && s.length <= 64 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s)
  }

  return {
    name: 'predictflow:dflow-kyc-check-dev',
    configureServer(server) {
      server.middlewares.use('/api/dflow-kyc-check', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end('Method Not Allowed')
        }
        const body = await readJson(req)
        const wallet = typeof body?.wallet === 'string' ? body.wallet.trim() : ''
        res.setHeader('content-type', 'application/json; charset=utf-8')
        if (!isPlausibleSolanaAddress(wallet)) {
          res.statusCode = 400
          return res.end(JSON.stringify({ verified: false, reason: 'wallet missing or malformed' }))
        }
        let canary
        try { canary = await getCanaryMint() } catch { canary = null }
        if (!canary) {
          res.statusCode = 502
          return res.end(JSON.stringify({ verified: false, reason: 'no canary market available', transient: true }))
        }
        const url = new URL(orderUpstream)
        url.searchParams.set('inputMint', USDC)
        url.searchParams.set('outputMint', canary)
        url.searchParams.set('amount', String(PROBE_AMOUNT))
        url.searchParams.set('userPublicKey', wallet)
        let resp
        try {
          resp = await fetch(url.toString(), { headers: authHeaders || {} })
        } catch (err) {
          res.statusCode = 502
          return res.end(JSON.stringify({ verified: false, reason: 'probe network error', transient: true }))
        }
        if (resp.ok) {
          res.statusCode = 200
          return res.end(JSON.stringify({ verified: true }))
        }
        const text = await resp.text().catch(() => '')
        const classified = classify(resp.status, text)
        if (classified.kind === 'kyc' || classified.kind === 'compliance') {
          res.statusCode = 200
          return res.end(JSON.stringify({ verified: false, reason: classified.message }))
        }
        res.statusCode = 502
        res.end(JSON.stringify({ verified: false, reason: classified.message, transient: true }))
      })
    },
  }
}

// Dev-only mirror of functions/api/rpc.js — proxies POSTs to the configured
// Solana RPC (HELIUS_RPC_URL) so the browser hits a same-origin path. Lets
// us use Helius keys that have an Origin allowlist (you can't allowlist
// localhost from their dashboard) and keeps the api-key out of the bundle.
function solanaRpcDevPlugin({ rpcUrl }) {
  return {
    name: 'predictflow:solana-rpc-dev',
    configureServer(server) {
      server.middlewares.use('/api/rpc', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end('Method Not Allowed')
        }
        if (!rpcUrl) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json; charset=utf-8')
          return res.end(JSON.stringify({ error: 'HELIUS_RPC_URL not set in env' }))
        }
        const chunks = []
        for await (const ch of req) chunks.push(ch)
        const body = Buffer.concat(chunks)
        try {
          const upstream = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          })
          const buf = Buffer.from(await upstream.arrayBuffer())
          res.statusCode = upstream.status
          res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json')
          res.end(buf)
        } catch (err) {
          res.statusCode = 502
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'upstream failed', detail: String(err?.message || err) }))
        }
      })
    },
  }
}

// Dev-only mirror of functions/api/dflow-series-categories.js — fetches the
// heavy upstream /api/v1/series once per process and serves the slim
// ticker→category lookup. In prod the Cloudflare Pages Function handles this.
function dflowSeriesCategoriesDevPlugin({ upstream, authHeaders }) {
  let cache = null
  const cacheTtlMs = 3600 * 1000

  async function load() {
    if (cache && Date.now() - cache.t < cacheTtlMs) return cache.body
    const target = `${upstream.replace(/\/+$/, '')}/api/v1/series`
    const resp = await fetch(target, { headers: authHeaders || {} })
    if (!resp.ok) throw new Error(`upstream ${resp.status}`)
    const body = await resp.json()
    const series = Array.isArray(body) ? body : body?.series || []
    const lookup = {}
    for (const s of series) {
      if (!s?.ticker || !s?.category) continue
      const tags = Array.isArray(s.tags) ? s.tags : []
      lookup[s.ticker] = [s.category, ...tags]
    }
    cache = { t: Date.now(), body: lookup }
    return lookup
  }

  return {
    name: 'predictflow:dflow-series-categories-dev',
    configureServer(server) {
      server.middlewares.use('/api/dflow-series-categories', async (req, res) => {
        try {
          const lookup = await load()
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'public, max-age=3600')
          res.end(JSON.stringify(lookup))
        } catch (err) {
          res.statusCode = 502
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'upstream failed', detail: String(err?.message || err) }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Dev proxy targets read with `loadEnv(mode, cwd, '')` so non-VITE keys are
  // available. Same names as the Cloudflare Pages dashboard so .env stays
  // 1:1 with prod, and these never end up in the browser bundle.
  const env = loadEnv(mode, process.cwd(), '')
  const upstream = env.DFLOW_UPSTREAM || 'https://dev-prediction-markets-api.dflow.net'
  const quoteUpstream = env.DFLOW_QUOTE_UPSTREAM || 'https://dev-quote-api.dflow.net/quote'
  const orderUpstream = env.DFLOW_ORDER_UPSTREAM || 'https://dev-quote-api.dflow.net/order'

  // Mirror the Cloudflare Pages Function: when DFLOW_API_KEY is set, attach
  // it server-side so the dev path matches prod. Default header is
  // `Authorization: Bearer <key>`; set DFLOW_API_KEY_HEADER (e.g. `x-api-key`)
  // to send the raw key under a different header.
  const authHeaders = (() => {
    const apiKey = env.DFLOW_API_KEY
    if (!apiKey) return undefined
    const headerName = env.DFLOW_API_KEY_HEADER || 'Authorization'
    const value = headerName.toLowerCase() === 'authorization'
      ? `Bearer ${apiKey}`
      : apiKey
    return { [headerName]: value }
  })()

  return {
    plugins: [
      react({ jsxRuntime: 'automatic' }),
      excludeDevScriptsPlugin(),
      dflowSeriesCategoriesDevPlugin({ upstream, authHeaders }),
      dflowKycCheckDevPlugin({ upstream, orderUpstream, authHeaders }),
      solanaRpcDevPlugin({ rpcUrl: env.HELIUS_RPC_URL || env.SOLANA_RPC_URL }),
    ],
    server: {
      watch: {
        usePolling: true,
        interval: 1000,
      },
      cors: true,
      allowedHosts: true,
      proxy: {
        // Order-before-prefix matters: longer/more specific paths first.
        '/api/dflow-quote': {
          target: quoteUpstream,
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/api\/dflow-quote/, ''),
          headers: authHeaders,
        },
        '/api/dflow-order': {
          target: orderUpstream,
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/api\/dflow-order/, ''),
          headers: authHeaders,
        },
        '/api/dflow': {
          target: upstream,
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/api\/dflow/, ''),
          headers: authHeaders,
        },
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            // Isolate heavy vendor libs into a shared chunk so they can be
            // cached separately from app code.
            solana: ['@solana/web3.js'],
          },
        },
      },
    },
  }
})
