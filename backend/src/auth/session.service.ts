/**
 * SessionService — issuance, lookup, sliding-window expiry, and revocation
 * for authenticated `Session` rows.
 *
 * Source of truth: tasks.md §4.4; design §"AuthService" / §"User and
 * authentication"; AGENTS.md → "Token Strategy" + "Backend Coding Rules".
 * Acceptance criteria: R1.2, R1.9.
 *
 * ## Wire format
 *
 * Authenticated requests carry the raw session token in either of:
 *   - the `bothsafe_session` cookie (browser flow), or
 *   - the `Authorization: Bearer <raw>` header (Telegram bot, internal
 *     S2S calls).
 *
 * The DB stores **only** the SHA-256 hash of that raw token in
 * `Session.token_hash` (R1.9). Raw values are returned exactly once at
 * issuance and never logged or persisted in plaintext.
 *
 * ## Sliding-window expiry
 *
 * R1.2 specifies a 24 h minimum lifetime; the design uses a sliding
 * window: every authenticated request that successfully resolves a
 * `Session` extends its `expires_at` by the configured TTL. The middleware
 * (`session.middleware.ts`) is the only caller of `slideExpiry(...)` so
 * background jobs and one-off lookups don't accidentally extend a
 * session's lifetime.
 *
 * ## Revocation semantics
 *
 * `Session.revoked_at` exists in the schema, but the simplest and safest
 * revocation path is a hard `DELETE` keyed on `token_hash`: the row is
 * gone, the unique index slot is freed, and any concurrent request still
 * holding the cookie sees the same "no active session" outcome the
 * AuthGuard reaches via `findActiveSession()` returning `null`. We
 * therefore use `delete` here. Should we ever need post-revocation audit
 * (e.g. distinguishing "logged out" from "expired"), the schema is ready
 * to switch to `update({ revoked_at: now() })` without a service-surface
 * change.
 *
 * ## What this service does NOT do
 *
 * - It does not authenticate the user; that is `AuthService` (task 4.1–
 *   4.3). `SessionService` only mints / looks up / revokes / extends
 *   `Session` rows.
 * - It does not write `AuthAttempt` rows; that is the rate limiter
 *   (task 4.5).
 * - It does not write to `cookie` headers; helpers in
 *   `session.middleware.ts` (`setSessionCookie` / `clearSessionCookie`)
 *   own that wire concern.
 *
 * Pure service surface: every method takes its inputs and a
 * (`PrismaService`-managed) connection and returns concrete data; no
 * module-level mutable state.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Session } from '@prisma/client';

import { generateRawToken, hashToken } from '../common/tokens';
import { PrismaService } from '../prisma';

/**
 * Optional request metadata captured at session issuance / use. Stored on
 * the `Session` row for forensics ("which IP minted this session?", "which
 * user-agent is currently active?") and never returned in user-facing
 * responses.
 *
 * Both fields are best-effort: they are populated by Express's
 * `req.ip` / `req.headers['user-agent']` resolution chain which depends on
 * trust-proxy configuration. Treat them as advisory.
 */
export interface SessionRequestMeta {
  /** Source IP. Stored in `Session.ip_inet` (Postgres `inet`). */
  ip?: string | null;
  /** `User-Agent` header. Stored verbatim in `Session.user_agent`. */
  userAgent?: string | null;
}

/**
 * Return shape of {@link SessionService.issueSession}.
 *
 * `rawToken` is the value the caller MUST place in `Set-Cookie` (and is
 * the same value the client will replay on subsequent requests). It is
 * returned exactly once — the database only stores its hash.
 */
export interface IssuedSession {
  /** Raw session token; treat as a credential and never log. */
  rawToken: string;
  /** The persisted `Session` row, including the computed `expires_at`. */
  sessionRow: Session;
}

/**
 * SessionService — see file-level docstring for the full contract.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  /**
   * Cached session TTL in milliseconds, derived from `SESSION_TTL_DAYS`.
   * `R1.2` requires at least 24 h; the env validator enforces a positive
   * integer of days, so the floor is one day. Pre-multiplied here so we
   * don't redo the conversion on every request.
   */
  private readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const days = config.get<number>('session.ttlDays') ?? 1;
    // Defensive clamp: even if a future config edit drops the validator,
    // `SessionService` will never mint a session with a non-positive TTL
    // — that would silently disable auth.
    const safeDays = Number.isFinite(days) && days > 0 ? days : 1;
    this.ttlMs = safeDays * 24 * 60 * 60 * 1000;
  }

  /**
   * Lifetime of every freshly issued or slid session, in milliseconds.
   * Exposed for the cookie-helper (`setSessionCookie`) so the cookie's
   * `Max-Age` matches the row's `expires_at`.
   */
  get sessionTtlMs(): number {
    return this.ttlMs;
  }

  /**
   * Mint a fresh session for `userId`.
   *
   * Generates a raw cuid v2 token, hashes it with SHA-256 (R1.9), and
   * persists a `Session` row with `expires_at = now() + ttlMs`. The raw
   * token is returned to the caller exactly once.
   *
   * Caller is responsible for placing the raw token in `Set-Cookie`
   * (`setSessionCookie` helper in `session.middleware.ts`).
   *
   * The very low-probability case that two concurrent issuances generate
   * a colliding `token_hash` (cuid v2 + SHA-256 ≈ 122 bits) is detected
   * by the UNIQUE index and surfaces as a Prisma `P2002` to the caller.
   * No retry logic is added here because such a collision indicates
   * either a broken RNG or a deliberate attack and is best surfaced
   * loudly.
   */
  async issueSession(
    userId: string,
    requestMeta: SessionRequestMeta = {},
  ): Promise<IssuedSession> {
    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + this.ttlMs);

    const sessionRow = await this.prisma.session.create({
      data: {
        user_id: userId,
        token_hash: tokenHash,
        expires_at: expiresAt,
        user_agent: clampUserAgent(requestMeta.userAgent),
        // `Session.ip_inet` is a Postgres `inet` column; Prisma maps it
        // to a String. We pass a normalised value (or null) — invalid
        // strings would surface as Postgres `invalid_text_representation`.
        ip_inet: normaliseIp(requestMeta.ip),
      },
    });

    return { rawToken, sessionRow };
  }

  /**
   * Resolve an active `Session` row for the candidate `rawToken`, or
   * return `null` when no such row exists.
   *
   * "Active" = the stored row exists, `expires_at > now()`, and
   * `revoked_at IS NULL`. Each guard is checked at the database layer so
   * a stale row never accidentally authenticates a request even between
   * the lookup and the request handler running.
   *
   * Returns `null` (not throws) for every failure mode — empty input,
   * malformed input, expired session, revoked session — so the caller
   * (the middleware) can collapse all of them into a uniform
   * "no resolved user" signal without timing or message side channels.
   */
  async findActiveSession(rawToken: string): Promise<Session | null> {
    if (typeof rawToken !== 'string' || rawToken.length === 0) {
      return null;
    }
    const tokenHash = hashToken(rawToken);
    const row = await this.prisma.session.findUnique({
      where: { token_hash: tokenHash },
    });
    if (!row) return null;
    if (row.revoked_at !== null) return null;
    if (row.expires_at.getTime() <= Date.now()) return null;
    return row;
  }

  /**
   * Extend the lifetime of `session` by the configured TTL (sliding
   * window). Idempotent and safe to call on an already-expired session
   * — the update goes through unconditionally. Callers should typically
   * resolve an active session via {@link findActiveSession} first.
   *
   * Returns the updated row so the middleware can attach the fresh
   * `expires_at` to subsequent telemetry.
   */
  async slideExpiry(session: Session): Promise<Session> {
    const newExpiresAt = new Date(Date.now() + this.ttlMs);
    return this.prisma.session.update({
      where: { id: session.id },
      data: { expires_at: newExpiresAt },
    });
  }

  /**
   * Revoke the session whose raw token is `rawToken`. Hard-deletes the
   * row keyed on `token_hash`.
   *
   * Returns `true` when a row was deleted (the caller's "logout" call
   * was meaningful), `false` when no row matched (already-revoked or
   * unknown token — still a no-op success from the user's perspective).
   *
   * Never throws on a missing row — a logout request against an already
   * dead session should not 500.
   */
  async revokeSession(rawToken: string): Promise<boolean> {
    if (typeof rawToken !== 'string' || rawToken.length === 0) {
      return false;
    }
    const tokenHash = hashToken(rawToken);
    try {
      await this.prisma.session.delete({ where: { token_hash: tokenHash } });
      return true;
    } catch (error) {
      // P2025 = "Record to delete does not exist". Treat as a no-op.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        return false;
      }
      // Anything else is a real failure — let it propagate so the global
      // exception filter can map it.
      throw error;
    }
  }
}

// -----------------------------------------------------------------------------
// Local helpers (file-private). Kept out of the class so they're trivially
// unit-testable in isolation if/when needed.
// -----------------------------------------------------------------------------

/**
 * `Session.user_agent` is a free-form TEXT column. We cap stored values at
 * 512 chars so a malicious client cannot bloat the table by replaying an
 * absurdly long header. 512 is well over the de-facto UA length seen in
 * the wild (~256) and stays comfortably within Postgres TEXT bounds.
 */
const USER_AGENT_MAX_LENGTH = 512;

function clampUserAgent(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length > USER_AGENT_MAX_LENGTH
    ? value.slice(0, USER_AGENT_MAX_LENGTH)
    : value;
}

/**
 * Best-effort normalisation of an IP string for the Postgres `inet`
 * column. We don't validate exhaustively — Postgres will reject malformed
 * values — but we strip IPv6-mapped-IPv4 prefixes (`::ffff:1.2.3.4` →
 * `1.2.3.4`) so the same physical client doesn't appear under two
 * representations.
 *
 * Returns `null` for empty / non-string inputs.
 */
function normaliseIp(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice('::ffff:'.length);
  }
  return trimmed;
}
