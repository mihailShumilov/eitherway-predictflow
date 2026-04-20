import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react({ jsxRuntime: 'automatic' })],
  server: {
    watch: {
      usePolling: true,
      interval: 1000,
    },
    cors: true,
    allowedHosts: true,
    proxy: {
      '/api/dflow': {
        target: 'https://dev-prediction-markets-api.dflow.net',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/dflow/, ''),
      },
    },
  },
})
