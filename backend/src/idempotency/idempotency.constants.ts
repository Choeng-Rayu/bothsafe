/**
 * Constants and configuration for the HTTP-level `IdempotencyMiddleware`
 * (tasks.md §3.8).
 *
 * Keeping these in their own file lets unit tests assert against the same
 * values the middleware uses without reaching into private members, and
 * lets future migrations (e.g. swapping the header name to a configurable
 * value) happen in exactly one place.
 *
 * Pure module — no I/O, no NestJS context.
 */

/** Canonical request header carrying the client-supplied dedup key. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * HTTP methods the middleware applies to. Per design §"Idempotency" and
 * the task brief, only mutating methods need replay protection — `GET`,
 * `HEAD`, and `OPTIONS` are already idempotent by HTTP semantics.
 */
export const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  'POST',
  'PATCH',
  'PUT',
]);

/**
 * Default TTL applied to a cached row when no override is supplied via
 * config: 24 hours, per the task brief.
 *
 * Held as the millisecond constant rather than a `Duration` object so
 * arithmetic against `Date.now()` stays trivially auditable.
 */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Lower / upper bounds on the `Idempotency-Key` header value. The lower
 * bound rejects empty / whitespace headers; the upper bound is generous
 * enough to accept a UUID, a CUID v2, or a server-derived composite key
 * (e.g. `${chatId}:${conversation_id}` for the Telegram bot, design
 * §"Idempotency") while preventing pathological 16 KB payloads from
 * being persisted.
 */
export const KEY_MIN_LENGTH = 1;
export const KEY_MAX_LENGTH = 255;

/**
 * The scope value the middleware writes into `idempotency_key.scope`.
 * Service-level callers (design §"Idempotency") use scopes like
 * `'confirm_received'`; the middleware uses a stable derivation of the
 * route signature so a single key cannot collide between unrelated
 * endpoints.
 *
 * Format: `${METHOD}:${routePathOrUrl}` — e.g.
 * `'POST:/v1/deals/:publicId/confirm-received'` when the framework
 * exposes a route pattern, or the raw URL path otherwise.
 */
export function buildMiddlewareScope(method: string, routeOrPath: string): string {
  return `${method.toUpperCase()}:${routeOrPath}`;
}
