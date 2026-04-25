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
