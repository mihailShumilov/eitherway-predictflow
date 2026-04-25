import { format } from 'date-fns'

// User-timezone abbreviation (e.g. "PST", "GMT+1"). Falls back to UTC offset
// when Intl doesn't provide a short name.
function getTzLabel(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZoneName: 'short',
    }).formatToParts(date)
    const tz = parts.find(p => p.type === 'timeZoneName')?.value
    if (tz) return tz
  } catch {
    // fall through
  }
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${(abs % 60).toString().padStart(2, '0')}` : ''}`
}

export function formatMarketClose(iso, pattern = 'MMM d, HH:mm') {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${format(d, pattern)} ${getTzLabel(d)}`
}

export function formatMarketCloseFull(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${format(d, 'MMM d, yyyy HH:mm')} ${getTzLabel(d)}`
}

// DFlow expresses market close times as Unix seconds (10-digit numbers); JS
// `new Date()` expects milliseconds or an ISO string. Normalize whatever we
// get into ISO so every downstream `new Date(closeTime)` works the same.
// Returns null when the input is missing or unparseable — callers must guard.
export function toCloseTimeIso(value) {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : (/^\d+$/.test(String(value).trim()) ? Number(value) : NaN)
  if (Number.isFinite(n)) {
    const ms = n < 1e12 ? n * 1000 : n
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export { getTzLabel }
