// Lightweight cached fetcher for the keeper's /config endpoint.
// /config publishes the executor pubkey that the approval flow targets in
// its spl-token approve. We cache it for the lifetime of the page; rotation
// requires a hard refresh, which is acceptable since rotation is a manual
// op and not silent.

import { useEffect, useState } from 'react'
import { getConfig, isKeeperConfigured } from '../lib/keeperApi'

export function useKeeperConfig() {
  const [config, setConfig] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    if (!isKeeperConfigured()) return
    getConfig({ refresh: false })
      .then((c) => { if (!cancelled) setConfig(c) })
      .catch((err) => { if (!cancelled) setError(err.message || 'Failed to load config') })
    return () => { cancelled = true }
  }, [])

  return { config, error }
}
