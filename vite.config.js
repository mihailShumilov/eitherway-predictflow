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
  const env = loadEnv(mode, process.cwd(), '')
  const upstream = env.VITE_DFLOW_UPSTREAM || 'https://dev-prediction-markets-api.dflow.net'

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
        '/api/dflow': {
          target: upstream,
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/api\/dflow/, ''),
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
