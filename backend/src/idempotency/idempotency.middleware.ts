/**
 * IdempotencyMiddleware — HTTP-level replay protection for mutating
 * requests carrying an `Idempotency-Key` header.
 *
 * Source of truth: tasks.md §3.8; design §"Idempotency"; R13.2, R16.2,
 * R16.3, R18.11.
 *
 * ## Behaviour
 *
 * 1. **Skip rules** — the middleware no-ops (calls `next()` immediately)
 *    when any of the following hold:
 *      - HTTP method is not POST/PATCH/PUT (GET/HEAD/OPTIONS are already
 *        idempotent by HTTP semantics).
 *      - The `Idempotency-Key` header is absent, blank, or out of bounds.
 *      - No authenticated user is attached to the request. The schema
 *        requires `user_id` (FK to `user`) so we cannot persist a row
 *        without one. Anonymous endpoints don't need replay protection
 *        at this layer — the controllers that *do* need it sit behind an
 *        auth guard.
 *
 * 2. **First call** — compute `request_hash = sha256(method + url + body)`,
 *    insert a pending row keyed on `(scope, key, user_id)`, then run the
 *    handler. Once the handler responds, capture `(response_status,
 *    response_body)` onto the same row so subsequent retries replay the
 *    cached response verbatim.
 *
 * 3. **Retry with matching hash** — re-emit the cached response with the
 *    original status (defaulting to `200` when the original handler
 *    didn't set one explicitly).
 *
 * 4. **Retry with mismatching hash** — same `(scope, key, user_id)` but a
 *    different request fingerprint indicates the client reused the key
 *    against a different request. Respond `409 request.idempotency_conflict`
 *    with the canonical error envelope and DO NOT run the handler.
 *
 * 5. **TTL** — every row carries `expires_at = created_at + 24 h`. Rows
 *    past their expiry are treated as cache-miss on lookup and may be
 *    purged by a background job.
 *
 * ## Concurrency
 *
 * Two concurrent first-calls with the same `(scope, key, user_id)` race
 * to insert. The composite primary key collapses them: the loser hits a
 * unique-violation (Prisma `P2002`), the middleware re-reads the winner's
 * row, and treats the second call as a retry — replaying the cached
 * response if the winner has finished or returning `409 request.in_flight`
 * if the winner is still pending. Either way, the handler runs at most
 * once per `(scope, key, user_id)` triple.
 *
 * ## Why a middleware (not a guard or interceptor)
 *
 * - We need access to the *raw* request body to fingerprint it; that
 *   means running after `body-parser` (NestJS uses Express's `json()` by
 *   default) but before any guards. Middleware fits exactly there.
 * - Wrapping `res.json` / `res.send` to capture the response body is
 *   ergonomic in middleware and survives streaming-style handlers that
 *   bypass NestJS's interceptor chain.
 *
 * ## Logging
 *
 * The middleware logs cache hits / mismatches / writes at `debug` so
 * production logs stay focused on actionable problems. Errors (e.g. a
 * Prisma constraint violation that isn't `P2002`) propagate to
 * `GlobalExceptionFilter` which collapses them to `server.internal_error`
 * — we deliberately fail-closed rather than silently bypassing the cache
 * on error, because doing the latter would defeat the purpose of the
 * middleware on transient DB blips.
 */

import { createHash } from 'node:crypto';

import {
  HttpStatus,
  Injectable,
  Logger,
  type NestMiddleware,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

import { buildErrorBody, type ErrorEnvelope } from '../common/errors';
import { PrismaService } from '../prisma';
import {
  DEFAULT_TTL_MS,
  IDEMPOTENCY_HEADER,
  IDEMPOTENT_METHODS,
  KEY_MAX_LENGTH,
  KEY_MIN_LENGTH,
  buildMiddlewareScope,
} from './idempotency.constants';

/**
 * Shape of the `idempotency_key` row we read back / write. Mirrors the
 * Prisma model fields the middleware uses (the row also carries `key`,
 * `scope`, `user_id`, `result_ref`, `created_at` but those are either
 * lookup keys or unused by the middleware path).
 */
interface CachedIdempotencyRow {
  request_hash: string | null;
  response_status: number | null;
  response_body: Prisma.JsonValue | null;
  expires_at: Date;
}

/**
 * Convenience: read the request body in a form suitable for hashing. We
 * accept whatever `body-parser` produced — usually a parsed JSON object,
 * sometimes a `Buffer` for `application/octet-stream`, sometimes
 * `undefined` for an empty body. We deliberately do NOT re-parse — the
 * goal is a deterministic fingerprint of what the handler will see, not a
 * canonical JSON form.
 */
function bodyToBytes(body: unknown): Buffer {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  // Plain object / array — JSON-serialise. JSON.stringify is
  // deterministic for objects produced by `body-parser` because it walks
  // own-enumerable keys in insertion order, and `body-parser` preserves
  // the order of the wire bytes. This is "good enough" for replay
  // protection: a client that re-sends the same payload will produce the
  // same byte sequence, hence the same parsed object, hence the same
  // serialisation.
  try {
    return Buffer.from(JSON.stringify(body), 'utf8');
  } catch {
    // Cyclic / non-serialisable body — collapse to an empty fingerprint.
    // The handler will likely fail validation anyway; we don't want the
    // middleware to crash the request before that signal reaches the
    // client.
    return Buffer.alloc(0);
  }
}

/**
 * Compute the SHA-256 (lowercase hex) request fingerprint:
 * `method + '\n' + url + '\n' + body`. Newline separators prevent
 * collisions between e.g. method=`POST`, url=`/x` and method=`POS`,
 * url=`T/x`.
 */
function computeRequestHash(req: Request): string {
  const hasher = createHash('sha256');
  hasher.update(req.method);
  hasher.update('\n');
  hasher.update(req.originalUrl ?? req.url ?? '');
  hasher.update('\n');
  hasher.update(bodyToBytes(req.body));
  return hasher.digest('hex');
}

/**
 * Best-effort extraction of the authenticated user id from the request.
 *
 * Auth wiring (task 4.4 / 4.6) attaches the resolved `User` to
 * `req.user`; some legacy paths attach `req.userId` directly. We accept
 * either shape so the middleware can land before the auth module is
 * fully wired without forcing a coordinated refactor later.
 *
 * Returns `null` when no user is attached — callers treat that as
 * "skip the middleware".
 */
function resolveUserId(req: Request): string | null {
  const candidate = req as Request & {
    user?: { id?: unknown } | string | null;
    userId?: unknown;
  };
  if (typeof candidate.userId === 'string' && candidate.userId.length > 0) {
    return candidate.userId;
  }
  const user = candidate.user;
  if (typeof user === 'string' && user.length > 0) return user;
  if (user && typeof user === 'object') {
    const id = (user as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

/**
 * Pick a stable route signature for the `scope` column.
 *
 * `req.route?.path` is set by Express only after the router has matched
 * the request — i.e. inside the route handler, not yet in a global
 * middleware. Falling back to the request path keeps the scope stable
 * for every concrete URL even when the framework doesn't expose the
 * pattern at this layer. Combined with the `(method, key, user_id)`
 * tuple, the scope still satisfies the uniqueness contract.
 */
function resolveRouteSignature(req: Request): string {
  const matched = (req as Request & { route?: { path?: unknown } }).route?.path;
  if (typeof matched === 'string' && matched.length > 0) return matched;
  return req.originalUrl?.split('?')[0] ?? req.url?.split('?')[0] ?? '/';
}

/**
 * Validate the `Idempotency-Key` header. Returns the trimmed value when
 * acceptable, `null` otherwise. We accept any RFC 7230 token-shaped
 * value bounded by `KEY_MIN_LENGTH..KEY_MAX_LENGTH`.
 */
function readKey(req: Request): string | null {
  const raw = req.headers[IDEMPOTENCY_HEADER];
  // Express normalises header values to `string | string[] | undefined`.
  // Only single-value headers are meaningful here; reject duplicates.
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < KEY_MIN_LENGTH) return null;
  if (trimmed.length > KEY_MAX_LENGTH) return null;
  return trimmed;
}

/**
 * Send a canonical error envelope without invoking the handler. Used for
 * the 409 mismatch / in-flight branches.
 */
function sendErrorEnvelope(
  res: Response,
  status: HttpStatus,
  envelope: ErrorEnvelope,
): void {
  if (res.headersSent) return;
  res.status(status).json(envelope);
}

@Injectable()
export class IdempotencyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(IdempotencyMiddleware.name);

  constructor(private readonly prisma: PrismaService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    // ---- Skip rules ---------------------------------------------------------
    if (!IDEMPOTENT_METHODS.has(req.method)) {
      return next();
    }
    const key = readKey(req);
    if (key === null) {
      return next();
    }
    const userId = resolveUserId(req);
    if (userId === null) {
      // No authenticated user → nothing to key on, and the schema would
      // reject the insert anyway (FK on user_id). Treating the request
      // as un-cached is safe: anonymous endpoints don't need replay
      // protection at this layer.
      return next();
    }

    // ---- Compute fingerprint + scope ----------------------------------------
    const requestHash = computeRequestHash(req);
    const route = resolveRouteSignature(req);
    const scope = buildMiddlewareScope(req.method, route);
    const now = Date.now();
    const expiresAt = new Date(now + DEFAULT_TTL_MS);

    // ---- Look up existing row -----------------------------------------------
    const existing = await this.findActiveRow(scope, key, userId, new Date(now));

    if (existing) {
      // Hash mismatch → client reused the key against a different
      // payload. Reject with the canonical 409 envelope.
      if (existing.request_hash !== null && existing.request_hash !== requestHash) {
        this.logger.debug(
          `[${req.method} ${route}] idempotency key reused with mismatching hash; rejecting`,
        );
        return sendErrorEnvelope(res, HttpStatus.CONFLICT, {
          error: buildErrorBody('request.idempotency_conflict'),
        });
      }

      // Cache hit with a captured response → replay verbatim.
      if (existing.response_status !== null) {
        this.logger.debug(
          `[${req.method} ${route}] idempotency cache hit; replaying status ${existing.response_status}`,
        );
        if (res.headersSent) return;
        res
          .status(existing.response_status ?? HttpStatus.OK)
          .json(existing.response_body ?? null);
        return;
      }

      // Row exists but the original handler hasn't completed yet — the
      // first call is still in flight. Reject the retry with 409 to keep
      // the at-most-once contract; the client should back off and retry.
      this.logger.debug(
        `[${req.method} ${route}] idempotency key in flight; rejecting concurrent retry`,
      );
      return sendErrorEnvelope(res, HttpStatus.CONFLICT, {
        error: buildErrorBody('request.idempotency_in_flight'),
      });
    }

    // ---- Reserve the slot ---------------------------------------------------
    try {
      await this.prisma.idempotencyKey.create({
        data: {
          scope,
          key,
          user_id: userId,
          request_hash: requestHash,
          route,
          expires_at: expiresAt,
        },
      });
    } catch (error) {
      // P2002 — another concurrent first-call won the race. Re-read its
      // row and treat the current request as a retry.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.findActiveRow(scope, key, userId, new Date(now));
        if (winner) {
          if (winner.request_hash !== null && winner.request_hash !== requestHash) {
            return sendErrorEnvelope(res, HttpStatus.CONFLICT, {
              error: buildErrorBody('request.idempotency_conflict'),
            });
          }
          if (winner.response_status !== null) {
            if (res.headersSent) return;
            res
              .status(winner.response_status ?? HttpStatus.OK)
              .json(winner.response_body ?? null);
            return;
          }
          return sendErrorEnvelope(res, HttpStatus.CONFLICT, {
            error: buildErrorBody('request.idempotency_in_flight'),
          });
        }
        // Race lost the row again (e.g. it expired between our two
        // queries). Fall through to handler — at worst we run the
        // handler twice across many minutes, which is the original
        // semantic for an expired key.
      } else {
        throw error;
      }
    }

    // ---- Wrap response capture ----------------------------------------------
    this.attachResponseCapture(req, res, scope, key, userId);

    return next();
  }

  /**
   * Read the active row for `(scope, key, user_id)`. "Active" = not yet
   * expired. Returns `null` when no row exists or the only row has
   * elapsed its TTL.
   *
   * Exposed as a helper (not inline) so the call site stays readable and
   * so unit tests can spy on it without re-implementing the query.
   */
  private async findActiveRow(
    scope: string,
    key: string,
    userId: string,
    asOf: Date,
  ): Promise<CachedIdempotencyRow | null> {
    const row = await this.prisma.idempotencyKey.findUnique({
      where: { scope_key_user_id: { scope, key, user_id: userId } },
      select: {
        request_hash: true,
        response_status: true,
        response_body: true,
        expires_at: true,
      },
    });
    if (!row) return null;
    if (row.expires_at.getTime() <= asOf.getTime()) return null;
    return row;
  }

  /**
   * Wrap `res.json` to capture the handler's response and persist it to
   * the cached row. Bound to a single `(scope, key, user_id)` triple so
   * we can update by primary key without re-resolving.
   *
   * `res.send` is not wrapped because every controller in this codebase
   * returns JSON via `res.json` (NestJS's default `ExpressAdapter`
   * pipeline) — wrapping `send` as well would also catch internal
   * 304 / 404 responses we don't want to cache.
   */
  private attachResponseCapture(
    req: Request,
    res: Response,
    scope: string,
    key: string,
    userId: string,
  ): void {
    const originalJson = res.json.bind(res);
    const persist = (body: unknown): void => {
      const status = res.statusCode || HttpStatus.OK;
      // Only cache successful + client-error responses; never cache 5xx.
      // A transient server error should not be replayed; the client
      // should retry against fresh state.
      if (status >= 500) return;
      // Fire-and-forget: a failure to persist the cached response must
      // not block the in-flight response. We log and move on.
      this.prisma.idempotencyKey
        .update({
          where: { scope_key_user_id: { scope, key, user_id: userId } },
          data: {
            response_status: status,
            // Prisma rejects raw `undefined` for Json columns; coerce to
            // null when the handler called `res.json()` with no body.
            response_body:
              body === undefined ? Prisma.JsonNull : (body as Prisma.InputJsonValue),
          },
        })
        .catch((err) => {
          this.logger.warn(
            `[${req.method} ${req.originalUrl ?? req.url}] failed to persist idempotency cache row: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    };

    res.json = ((body?: unknown) => {
      // Capture *before* we hand the body to the framework so a
      // transformation in `originalJson` doesn't change what we cache.
      persist(body);
      return originalJson(body);
    }) as typeof res.json;
  }
}
