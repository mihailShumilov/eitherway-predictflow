import { useSyncExternalStore, useCallback } from 'react'
import { parseHash, formatHash } from '../lib/route'

function getSnapshot() {
  return typeof window !== 'undefined' ? window.location.hash : ''
}

function getServerSnapshot() {
  return ''
}

function subscribe(callback) {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('hashchange', callback)
  return () => window.removeEventListener('hashchange', callback)
}

// useRoute reflects the current URL hash and exposes a `navigate(next)`
// helper. Setting `window.location.hash` pushes a history entry, so back/
// forward and shareable URLs work without any extra plumbing.
export function useRoute() {
  const hash = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const route = parseHash(hash)

  const navigate = useCallback((next) => {
    const target = formatHash(next)
    if (typeof window === 'undefined') return
    if (window.location.hash === target) return
    if (window.location.hash === '' && target === '#/') return
    window.location.hash = target
  }, [])

  return { ...route, navigate }
}
