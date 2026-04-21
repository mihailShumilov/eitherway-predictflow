// Minimal cache-first service worker for hashed build assets.
// DO NOT cache any /api/* or wallet interactions.
const CACHE_NAME = 'predictflow-v1'

self.addEventListener('install', (event) => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // Never cache API, RPC, or cross-origin dynamic data.
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/scripts/')
  ) {
    return
  }

  // Hashed assets: cache first, then network.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME)
      const cached = await cache.match(req)
      if (cached) return cached
      try {
        const res = await fetch(req)
        if (res.ok) cache.put(req, res.clone())
        return res
      } catch (err) {
        return cached || Response.error()
      }
    })())
    return
  }

  // HTML / manifest / icons: network-first, fall back to cache.
  event.respondWith((async () => {
    try {
      const res = await fetch(req)
      const cache = await caches.open(CACHE_NAME)
      cache.put(req, res.clone())
      return res
    } catch {
      const cached = await caches.match(req)
      return cached || Response.error()
    }
  })())
})
