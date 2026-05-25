/**
 * AuthAttemptService — sliding-window rate limiter (5 fails / 15 min)
 * keyed on `identity_key`, backed by the `auth_attempt` table.
 *
 * Source of truth: tasks.md §4.5; design §"AuthService" / "Cross-Cutting
 * Concerns → Rate limiting"; R1.7.
 *
 * ## Why an identity-bucket throttler in addition to the IP throttler?
 *
 * `AppModule` already registers an IP-bucketed `auth_login` throttler via
 * `@nestjs/throttler` (5 req/min/IP). That bucket protects the API from
 * raw bursts — a single attacker hammering `/v1/auth/email/login` from
 * one IP is rate-limited at the HTTP layer.
 *
 * It does NOT protect a single user account from a slow, distributed
 * attacker. Five failures spread across five IPs in a minute would slip
 * past the throttler entirely while still being a credential-stuffing
 * attempt against one account.
 *
 * R1.7 closes that gap by requiring a per-identity sliding window:
 *
 *   "IF a User exceeds 5 failed authentication attempts within a rolling
 *    15-minute window, THEN THE Auth_Service SHALL reject further attempts
 *    from the same identity with an `auth.rate_limited` error until the
 *    window expires."
 *
 * The bucket key is the credential the caller offered, NOT the request IP,
 * so a distributed attack against `alice@example.com` accumulates failures
 * against the same `identity_key` regardless of which IP submitted them.
 *
 * The two throttlers are intentionally complementary, not redundant:
 *   - `auth_login` IP bucket   → blocks raw burst rate per source.
 *   - `AuthAttempt` identity   → blocks credential stuffing per account.
 *
 * ## `identity_key` convention
 *
 * The bucket is keyed off a stable string derived from the credential the
 * caller offered. AuthService callers MUST normalise the key consistently
 * so retries match the same bucket:
 *
 *   - Email/password login → `email:${normalizedEmail}` where
 *     `normalizedEmail = email.trim().toLowerCase()`.
 *   - Telegram login       → `telegram:${telegram_user_id}` (the numeric
 *     id from the verified `initData` `user.id` field).
 *   - Google OAuth login   → `google:${sub}` (the verified `id_token` `sub`).
 *
 * The identity key is stored verbatim in `auth_attempt.identity_key` so
 * the composite `(identity_key, attempted_at)` index from task 2.3
 * answers the "≥ 5 failures in last 15 min?" query in O(log n + k).
 *
 * ## Integration contract for AuthService (tasks 4.1, 4.2, 4.3)
 *
 * Every authentication code path — `signupEmail`, `loginEmail`,
 * `loginTelegram`, `loginGoogle` — MUST do, in order:
 *
 *   1. Compute `identityKey` per the convention above.
 *   2. `await assertNotLocked(identityKey)` BEFORE running any
 *      credential verification (argon2id, HMAC, id_token verify). This
 *      ensures we don't burn argon2id cycles on an already-locked bucket
 *      and never reveal account existence to a locked-out attacker.
 *   3. Run the credential check; capture the success boolean.
 *   4. `await recordAttempt(identityKey, success, meta?)` AFTER the
 *      verification completes, regardless of outcome. Both successful and
 *      failed attempts are recorded so the dashboard / forensics can
 *      reconstruct the full attempt history; only failed attempts count
 *      toward the lockout threshold (`countRecentFailures`).
 *
 * Steps 2 and 4 wrap the credential check so the rate-limit decision and
 * the audit trail can never go out of sync.
 *
 * ## Persistence notes
 *
 * The current `auth_attempt` schema (task 2.3) has columns
 * `id, identity_key, attempted_at, success`. The `meta` parameter on
 * `recordAttempt` accepts `{ ip?, user_agent? }` as a forward-compatible
 * hook — those fields are documented in the spec for future forensics —
 * but are intentionally NOT persisted until the schema gains the
 * corresponding columns. Dropping them silently here keeps the service
 * additive and lets sibling agents add the columns without breaking this
 * module's call sites.
 */

import { Injectable } from '@nestjs/common';

import {
  AUTH_LOGIN_MAX_FAILS,
  AUTH_LOGIN_WINDOW_MS,
} from '../common/constants';
import { DomainException } from '../common/errors';
import { PrismaService } from '../prisma';

/**
 * Optional context metadata for an authentication attempt. Reserved for
 * forensics; only persisted when the underlying schema supports it (see
 * file-level "Persistence notes").
 */
export interface AuthAttemptMeta {
  ip?: string;
  user_agent?: string;
}

@Injectable()
export class AuthAttemptService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Insert one row recording the outcome of an authentication attempt.
   *
   * Called by AuthService after every credential check, regardless of
   * outcome (R1.7 forensics). The row anchors the per-identity sliding
   * window used by `countRecentFailures` / `assertNotLocked`.
   *
   * `meta` is accepted for forward compatibility — see file-level
   * "Persistence notes" — but currently dropped because the
   * `auth_attempt` schema (task 2.3) does not yet have `ip` /
   * `user_agent` columns.
   */
  async recordAttempt(
    identityKey: string,
    success: boolean,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    meta?: AuthAttemptMeta,
  ): Promise<void> {
    await this.prisma.authAttempt.create({
      data: {
        identity_key: identityKey,
        success,
      },
    });
  }

  /**
   * Count failed authentication attempts for `identityKey` within the
   * trailing `windowMs` (default `AUTH_LOGIN_WINDOW_MS`, 15 minutes).
   *
   * Returns the number of rows where `success = false` and
   * `attempted_at ∈ [now - windowMs, now]`. Successful attempts do NOT
   * reset the window — R1.7 specifies a sliding fail-count, not a
   * fail-streak — so a successful login mid-window does not unlock a
   * bucket that has already accumulated 5 failures.
   *
   * The composite `(identity_key, attempted_at)` index on `auth_attempt`
   * makes this query a bounded index scan even when the table grows.
   */
  async countRecentFailures(
    identityKey: string,
    windowMs: number = AUTH_LOGIN_WINDOW_MS,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - windowMs);
    return this.prisma.authAttempt.count({
      where: {
        identity_key: identityKey,
        success: false,
        attempted_at: { gte: cutoff },
      },
    });
  }

  /**
   * Throws `DomainException.tooManyRequests('auth.rate_limited')` when
   * the bucket for `identityKey` has accumulated `AUTH_LOGIN_MAX_FAILS`
   * (5) or more failed attempts in the trailing `AUTH_LOGIN_WINDOW_MS`
   * (15 min). Otherwise resolves normally.
   *
   * AuthService MUST call this BEFORE running any credential check so we
   * never burn argon2id cycles (or reveal timing information) on a
   * locked bucket. The error message_key (`errors.auth.rate_limited`) is
   * the canonical key the frontend renders for R1.7.
   *
   * The `details.retry_after_seconds` hint surfaces the worst-case time
   * until the oldest counted failure ages out of the window. It is a
   * conservative upper bound — actual unlock may happen sooner once
   * older failures expire — but it gives the frontend something concrete
   * to render in the lockout banner without leaking precise timestamps.
   */
  async assertNotLocked(
    identityKey: string,
    windowMs: number = AUTH_LOGIN_WINDOW_MS,
    maxFails: number = AUTH_LOGIN_MAX_FAILS,
  ): Promise<void> {
    const failures = await this.countRecentFailures(identityKey, windowMs);
    if (failures >= maxFails) {
      throw DomainException.tooManyRequests('auth.rate_limited', {
        details: {
          retry_after_seconds: Math.ceil(windowMs / 1000),
        },
      });
    }
  }
}
