/**
 * SessionCookieMiddleware — resolves an authenticated `User` from either
 * the `bothsafe_session` cookie or an `Authorization: Bearer <token>`
 * header and attaches it to the Express `Request`.
 *
 * Source of truth: tasks.md §4.4; design §"AuthService"; AGENTS.md →
 * "Token Strategy" + "Backend Coding Rules". Acceptance criteria: R1.2,
 * R1.8.
 *
 * ## Behaviour
 *
 *  1. Read the candidate raw token from `req.cookies.bothsafe_session` if
 *     present, otherwise from the `Authorization: Bearer …` header.
 *     Bot/internal callers use the header path because they can't carry a
 *     browser cookie.
 *  2. If neither source yields a token, **no-op** and call `next()`. The
 *     middleware deliberately does not gate access — that is the
 *     responsibility of `AuthGuard` (task 4.6) which rejects with
 *     `auth.required` only on routes that demand authentication.
 *  3. Otherwise, look up an active session via
 *     {@link SessionService.findActiveSession}. On a miss (unknown,
 *     expired, or revoked token) the middleware no-ops — same reasoning
 *     as above; the guard owns the rejection contract.
 *  4. On a hit, load the related `User`, attach
 *     `req.user`, `req.session`, and `req.sessionToken` to the request,
 *     extend the session's `expires_at` (sliding window per design), and
 *     call `next()`.
 *
 * ## Why we don't refresh the cookie here
 *
 * Sliding the DB row is enough to keep the session alive for the next
 * 24 h. Re-issuing the cookie on every request would require
 * `setSessionCookie(...)` on the response — but middleware runs before
 * the controller, so we'd send `Set-Cookie` even on responses the
 * controller chose to abort. That's noisy and surprises tests. Browsers
 * already preserve cookie lifetimes via the original `Max-Age`, so the
 * extra header buys nothing for the cookie path. The bot/header path
 * doesn't use cookies at all.
 *
 * ## Helpers
 *
 *   - `setSessionCookie(res, rawToken)` — called by `AuthService`'s
 *     login/signup paths after `SessionService.issueSession`.
 *   - `clearSessionCookie(res)` — called by `AuthService.logout`.
 *
 * Both helpers honour the cookie attribute set documented in tasks.md
 * §4.4: `httpOnly: true`, `secure: NODE_ENV !== 'development'`,
 * `sameSite: 'lax'`, `path: '/'`, and `maxAge` matching the configured
 * `SESSION_TTL_DAYS`.
 *
 * ## What this middleware does NOT do
 *
 *  - It does not write `AuthAttempt` rows; that is the rate limiter
 *    (task 4.5).
 *  - It does not enforce `is_admin`; that is `AdminGuard` (task 4.6).
 *  - It does not throw on malformed input — every malformed signal
 *    collapses to "no user" so timing/error-shape don't leak whether a
 *    cookie / header was structurally valid.
 */

import {
  Injectable,
  Logger,
  type NestMiddleware,
} from '@nestjs/common';
import type { User, Session } from '@prisma/client';
import type { CookieOptions, NextFunction, Request, Response } from 'express';

import { PrismaService } from '../prisma';
import { SessionService } from './session.service';

// -----------------------------------------------------------------------------
// Public augmentations
// -----------------------------------------------------------------------------

/**
 * Cookie name carried on every browser-originated authenticated request.
 *
 * Matches the spec wording in tasks.md §4.4 ("Reads `bothsafe_session`
 * cookie"). Note that design.md §"Password hashing" sketch uses
 * `bs_session` informally — tasks.md is the authoritative name and is the
 * one observable to the frontend, so we follow it.
 */
export const SESSION_COOKIE_NAME = 'bothsafe_session';

/**
 * Bearer-token scheme used by Telegram bot / internal S2S calls. Lower-cased
 * comparison happens at parse time so callers may use any case.
 */
const BEARER_SCHEME = 'bearer';

/**
 * Augmented `Request` shape exposed to downstream handlers / guards.
 *
 * Built by combining the canonical `AuthenticatedRequest` from
 * `auth.types.ts` (which contributes `user`) with the session-scoped
 * slots written by this middleware (`session`, `sessionToken`).
 *
 * Every field is optional because the middleware no-ops on missing /
 * invalid credentials; consumers MUST treat the absence of `req.user`
 * as "anonymous".
 */
export interface SessionAuthenticatedRequest extends Request {
  /** Resolved `User` for this request, or `undefined` when anonymous. */
  user?: User;
  /** Resolved `Session` row, or `undefined` when anonymous. */
  session?: Session;
  /**
   * Raw session token used by this request. Held on the request so audit
   * writers can reference the session that authorised the action; never
   * logged. Removed before responses by NestJS's response pipeline (we
   * never assign it to a `res.locals` slot that would serialise back to
   * the wire).
   */
  sessionToken?: string;
}

// -----------------------------------------------------------------------------
// Cookie helpers
// -----------------------------------------------------------------------------

function isProductionLike(): boolean {
  // `secure: true` would cause browsers to drop the cookie when the
  // backend serves over plain HTTP in dev. We therefore only flip the
  // `Secure` attribute on outside development. The string compare is
  // intentional — Joi normalises NODE_ENV to one of {development,
  // production, test}; we treat anything else as production-like to
  // err on the side of stricter cookies.
  return (process.env.NODE_ENV ?? 'development') !== 'development';
}

function buildBaseCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProductionLike(),
    sameSite: 'lax',
    path: '/',
  };
}

/**
 * Set the `bothsafe_session` cookie with the canonical attributes (R1.2,
 * tasks.md §4.4). `maxAgeMs` is the cookie's `Max-Age` in milliseconds —
 * pass it from `SessionService.sessionTtlMs` so the cookie matches the
 * `Session.expires_at` clock the server enforces.
 *
 * Callers MUST NOT log `rawToken`. Express's `res.cookie` handles header
 * encoding and quoting.
 */
export function setSessionCookie(
  res: Response,
  rawToken: string,
  options: { maxAgeMs: number },
): void {
  res.cookie(SESSION_COOKIE_NAME, rawToken, {
    ...buildBaseCookieOptions(),
    maxAge: options.maxAgeMs,
  });
}

/**
 * Clear the `bothsafe_session` cookie. Used by `AuthService.logout`.
 *
 * Express's `clearCookie` requires the same path/domain attributes as the
 * original cookie to delete it cleanly across browsers — we mirror them
 * via {@link buildBaseCookieOptions}.
 */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, buildBaseCookieOptions());
}

// -----------------------------------------------------------------------------
// Middleware implementation
// -----------------------------------------------------------------------------

@Injectable()
export class SessionCookieMiddleware implements NestMiddleware {
  private readonly logger = new Logger(SessionCookieMiddleware.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const rawToken = readCandidateToken(req);
    if (rawToken === null) {
      return next();
    }

    let session: Session | null;
    try {
      session = await this.sessions.findActiveSession(rawToken);
    } catch (error) {
      // A DB blip on session resolution should not crash an otherwise
      // anonymous-friendly request. Log and continue as anonymous; the
      // AuthGuard will reject any route that actually requires auth.
      this.logger.warn(
        `findActiveSession failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return next();
    }
    if (session === null) {
      return next();
    }

    let user: User | null;
    try {
      user = await this.prisma.user.findUnique({ where: { id: session.user_id } });
    } catch (error) {
      this.logger.warn(
        `user lookup failed for session.user_id=${session.user_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return next();
    }
    if (user === null) {
      // The session row points to a user that no longer exists — treat
      // the session as dead. The schema cascades on user delete, but a
      // race between read and concurrent delete is still possible.
      return next();
    }

    const authReq = req as SessionAuthenticatedRequest;
    authReq.user = user;
    authReq.session = session;
    authReq.sessionToken = rawToken;

    // Sliding window per design. We deliberately do not await the slide
    // — a fresh request only needs to know "this session was active";
    // extending the row is best-effort. We still log failures so a
    // chronically broken update path is visible. Errors must not bubble
    // to `next()` because the request itself is still valid.
    this.sessions.slideExpiry(session).catch((error) => {
      this.logger.warn(
        `slideExpiry failed for session=${session!.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    return next();
  }
}

// -----------------------------------------------------------------------------
// Token extraction (file-private). Exported via the middleware's behaviour
// only; tests cover the same surface via the middleware itself.
// -----------------------------------------------------------------------------

/**
 * Pull the candidate raw token off the request, preferring the cookie
 * over the bearer header so a stale `Authorization` value can't shadow a
 * fresh cookie. Returns `null` for any malformed / missing input.
 */
function readCandidateToken(req: Request): string | null {
  const cookieToken = readCookieToken(req);
  if (cookieToken !== null) return cookieToken;
  return readBearerToken(req);
}

function readCookieToken(req: Request): string | null {
  // `cookie-parser` populates `req.cookies` on the Express request. When
  // the parser hasn't run (e.g. unit tests bypassing `app.use(cookieParser())`)
  // the property is undefined; treat it the same as "no cookie".
  const cookies = (req as Request & { cookies?: Record<string, unknown> }).cookies;
  if (!cookies || typeof cookies !== 'object') return null;
  const value = cookies[SESSION_COOKIE_NAME];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBearerToken(req: Request): string | null {
  const header = req.headers['authorization'] ?? req.headers['Authorization'];
  if (typeof header !== 'string') return null;
  // RFC 7235: `<scheme> <token>` separated by single space. We split on
  // the first run of whitespace to be liberal with formatting.
  const trimmed = header.trim();
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx <= 0) return null;
  const scheme = trimmed.slice(0, spaceIdx).toLowerCase();
  if (scheme !== BEARER_SCHEME) return null;
  const value = trimmed.slice(spaceIdx + 1).trim();
  return value.length > 0 ? value : null;
}
