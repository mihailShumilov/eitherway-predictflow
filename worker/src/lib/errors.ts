// Shared error-response helper. Every keeper endpoint produces the same
// JSON shape:
//
//   { "error": "<code>", "detail": <any?>, "requestId": "<id>" }
//
// `error` is always a stable machine-readable code (snake_case). `detail`
// is human-readable text or a small structured object — useful in
// development; safe to log; never includes secrets.
//
// `requestId` is plumbed from the request-id middleware so a user
// reporting a failure can quote the id from their network tab and ops
// can grep audit_log for the matching trail.

import type { Context } from 'hono'
import type { Env, AppVariables } from '../env'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>

export function apiError(
  c: AppContext,
  status: ContentfulStatusCode,
  code: string,
  detail?: unknown,
) {
  return c.json(
    {
      error: code,
      ...(detail !== undefined ? { detail } : {}),
      requestId: c.var.requestId,
    },
    status,
  )
}
