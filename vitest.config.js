import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react({ jsxRuntime: 'automatic' })],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    css: false,
    restoreMocks: true,
    // Worker has its own vitest config + runtime; don't sweep its tests
    // into the jsdom-targeted frontend run.
    exclude: ['**/node_modules/**', 'worker/**'],
  },
})
