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

export { getTzLabel }
