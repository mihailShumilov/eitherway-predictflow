// Sanitize an Error/string before displaying it to the user.
// Rejects anything that looks like HTML/script injection in server-supplied text.

const MAX_LEN = 300

export function safeErrorMessage(err, fallback = 'Something went wrong. Please try again.') {
  let raw = ''
  if (!err) return fallback
  if (typeof err === 'string') raw = err
  else if (err instanceof Error) raw = err.message || fallback
  else raw = String(err)

  // Strip HTML tags and angle brackets defensively. React already escapes text
  // nodes, but this guards against someone doing dangerouslySetInnerHTML later.
  const stripped = raw.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f]/g, '').trim()
  if (!stripped) return fallback
  if (stripped.length > MAX_LEN) return stripped.slice(0, MAX_LEN - 1) + '…'
  return stripped
}
