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
