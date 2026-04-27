// Parse the comma-separated ALLOWED_ORIGIN env var and resolve a request's
// Origin header against the allowlist. Used by the CORS middleware and by
// SIWS challenge issuance — both must agree on which origin the request
// belongs to so the wallet's signed message and the browser-enforced ACAO
// header reference the same host.

export function parseAllowlist(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// Returns the request's Origin header iff it's in the allowlist; null otherwise.
export function matchAllowedOrigin(
  origin: string | undefined,
  allowList: string[],
): string | null {
  if (!origin) return null
  return allowList.includes(origin) ? origin : null
}
