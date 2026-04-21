// Utilities for scrubbing PII before shipping it to observability / analytics.
// A wallet address is technically public, but correlating wallet → errors/
// analytics without the user's consent is sketchy. Hash or truncate.

function toHex(buffer) {
  const bytes = new Uint8Array(buffer)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}

// Short + non-reversible identifier for a wallet. 8 chars of SHA-256 is
// plenty to correlate a single user's events without being reversible.
export async function hashWallet(address) {
  if (!address) return null
  try {
    const enc = new TextEncoder().encode(`predictflow:${address}`)
    const digest = await globalThis.crypto.subtle.digest('SHA-256', enc)
    return `wallet-${toHex(digest).slice(0, 16)}`
  } catch {
    // Fallback: mask address so we never report the raw form.
    return `wallet-${address.slice(0, 4)}…${address.slice(-4)}`
  }
}

// Synchronous mask for contexts where we can't await (most error reports).
export function maskWallet(address) {
  if (!address || typeof address !== 'string') return null
  if (address.length <= 10) return address
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}
