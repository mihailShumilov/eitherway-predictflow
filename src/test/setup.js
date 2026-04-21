import '@testing-library/jest-dom/vitest'

// Silence the noisy "Not implemented" errors jsdom prints when components
// touch unsupported APIs during import.
const originalError = console.error
console.error = (...args) => {
  const msg = args[0]?.toString?.() || ''
  if (msg.includes('Not implemented: HTMLCanvasElement')) return
  if (msg.includes('Not implemented: navigation')) return
  originalError(...args)
}

// Always give us a fresh localStorage between tests.
beforeEach(() => {
  try { localStorage.clear() } catch { /* ignore */ }
})
