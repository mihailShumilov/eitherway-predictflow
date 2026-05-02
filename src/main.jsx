// `@solana/spl-token` (and parts of `@solana/web3.js`) reference Node's
// `Buffer` at module-eval time. Vite externalizes the `buffer` builtin in
// the browser, so we have to expose the polyfill globally before any
// module that touches spl-token is loaded — otherwise lazy chunks like
// MarketDetail crash with `ReferenceError: Buffer is not defined`.
import { Buffer } from 'buffer'
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { runMigrations } from './lib/storage'

// Bring any client-side schemas up to the current version before any
// component reads from localStorage.
runMigrations()

// Register service worker in prod only. Dev HMR + SW caching collide.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* ignore */ })
  })
}

// Eitherway host-platform dev harness — only inject in development. In a
// production build these scripts have no host frame to postMessage to and
// would 404 anyway, so we skip them entirely.
if (import.meta.env.DEV) {
  const devScripts = [
    '/scripts/runtime-error-reporter.js',
    '/scripts/vite-error-monitor.js',
    '/scripts/component-inspector.js',
  ]
  for (const src of devScripts) {
    const s = document.createElement('script')
    s.src = src
    s.async = false
    document.head.appendChild(s)
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
