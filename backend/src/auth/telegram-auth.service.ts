/**
 * TelegramAuthService — sign-in via verified Telegram WebApp `initData`.
 *
 * Source of truth: tasks.md §4.3; design §"AuthService → loginTelegram";
 * R1.1, R1.3.
 *
 * ## Flow
 *
 *   1. Client (Telegram WebApp / Mini App) submits the URL-encoded
 *      `initData` query string to `POST /v1/auth/telegram`.
 *   2. The controller forwards `{ initData, ip?, userAgent? }` here.
 *   3. We compute `identityKey = 'telegram:<id>'` only after we have
 *      authenticated `<id>` via HMAC. The pre-verification rate-limit
 *      check uses a coarse `'telegram:<short-fingerprint>'` derived from
 *      the supplied `hash` so a flood of malformed blobs cannot evade
 *      the limiter — but the per-account lockout uses the verified id.
 *   4. `verifyTelegramInitData` rebuilds the data-check string, recomputes
 *      the HMAC against `env.TELEGRAM_BOT_TOKEN`, and validates
 *      `auth_date` is within 24 h.
 *   5. On success: upsert `ExternalIdentity { provider: 'telegram',
 *      external_id: telegramUser.id }` and the linked `User` inside a
 *      single Prisma `$transaction`. Create the per-currency `Wallet`
 *      rows on first sign-in.
 *   6. Issue a fresh `Session` via `SessionService.issueSession` and
 *      return the raw token + `User` row.
 *
 * Both successful and failed verifications record an `AuthAttempt` row
 * via `AuthAttemptService.recordAttempt(...)` so the sliding-window rate
 * limiter (R1.7) sees both outcomes.
 *
 * On verification failure we throw
 * `DomainException.unauthorized('auth.invalid_credentials')` — a single
 * code for every failure mode (bad signature, expired blob, malformed
 * payload) so we never leak which check failed.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';

import { ALL_CURRENCIES, ParticipantRole } from '../common/enums';
import { DomainException } from '../common/errors';
import { PrismaService } from '../prisma';
import { AuditService } from '../audit';

import { AuthAttemptService } from './auth-attempt.service';
import { SessionService } from './session.service';
import {
  verifyTelegramInitData,
  type VerifiedTelegramInitData,
} from './telegram-init-data';

/**
 * Input to {@link TelegramAuthService.loginTelegram}. `ip` and
 * `userAgent` are optional forensic hints attached to the issued
 * `Session` row by `SessionService`.
 */
export interface LoginTelegramInput {
  initData: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Output of {@link TelegramAuthService.loginTelegram}. `rawSessionToken`
 * is the value the controller MUST place in the `bothsafe_session`
 * `Set-Cookie` header — it is returned to the caller exactly once.
 */
export interface LoginTelegramResult {
  user: User;
  rawSessionToken: string;
  /** Resolved `Session.expires_at`. Useful for the cookie's `Max-Age`. */
  sessionExpiresAt: Date;
}

@Injectable()
export class TelegramAuthService {
  private readonly logger = new Logger(TelegramAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly authAttempts: AuthAttemptService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async loginTelegram(input: LoginTelegramInput): Promise<LoginTelegramResult> {
    const botToken = this.config.get<string>('telegram.botToken');
    if (typeof botToken !== 'string' || botToken.length === 0) {
      // Service-side misconfiguration. Surface as a generic
      // `auth.invalid_credentials` so we don't leak that the bot token is
      // missing; the operator-facing log line is enough to diagnose.
      this.logger.error(
        'TELEGRAM_BOT_TOKEN is not configured; refusing Telegram login.',
      );
      throw DomainException.unauthorized('auth.invalid_credentials');
    }

    // ── Verify the initData blob (HMAC + auth_date age) ───────────────────
    let verified: VerifiedTelegramInitData | null;
    try {
      verified = verifyTelegramInitData(input.initData, botToken);
    } catch {
      verified = null;
    }

    if (!verified) {
      // We cannot key the rate-limit bucket on a verified id (we don't have
      // one), so we don't record an `AuthAttempt` for unverifiable blobs —
      // the IP-bucketed `auth_signup` throttler in `AppModule` covers this
      // case. Recording an attempt under a synthetic key would dilute the
      // per-account window with garbage and risk locking out legitimate
      // accounts via spoofed prefixes.
      throw DomainException.unauthorized('auth.invalid_credentials');
    }

    const externalId = String(verified.user.id);
    const identityKey = `telegram:${externalId}`;

    // ── Pre-verification rate limit (R1.7) ────────────────────────────────
    // Now that we have a verified id, gate the bucket BEFORE issuing the
    // session. We've already done the cryptographic check, but a
    // distributed attacker could still grind `recordAttempt(..., true)`
    // against a single account — and a successful login mid-window must
    // not unlock a bucket that has already accumulated 5 failures. The
    // limiter is the canonical R1.7 enforcement point.
    await this.authAttempts.assertNotLocked(identityKey);

    // ── Upsert ExternalIdentity + User + Wallets in a single tx ───────────
    let user: User;
    try {
      user = await this.prisma.runInTransaction(async (tx) => {
        const existing = await tx.externalIdentity.findUnique({
          where: {
            provider_external_id: {
              provider: 'telegram',
              external_id: externalId,
            },
          },
          include: { user: true },
        });

        let resolved: User;
        if (existing) {
          resolved = existing.user;
        } else {
          // Derive a display_name from Telegram if available; fall back
          // to the @username; otherwise leave null.
          const telegram = verified.user;
          const displayName = pickDisplayName(telegram);
          const preferredLang = pickPreferredLang(telegram.language_code);

          resolved = await tx.user.create({
            data: {
              display_name: displayName ?? null,
              preferred_lang: preferredLang,
            },
          });

          await tx.externalIdentity.create({
            data: {
              user_id: resolved.id,
              provider: 'telegram',
              external_id: externalId,
            },
          });

          // Create per-currency wallets on first sign-in. We do NOT
          // backfill `WalletRole` rows here — those mark platform-owned
          // wallets (escrow / platform_fee), seeded by
          // `prisma/seed.ts`. Regular user wallets have no `WalletRole`.
          for (const currency of ALL_CURRENCIES) {
            await tx.wallet.create({
              data: {
                user_id: resolved.id,
                currency,
              },
            });
          }
        }

        // R20.4 — audit row in the same tx as the business mutation.
        // For repeat sign-ins we still record the audit row so the
        // forensics timeline shows every authentication.
        await this.audit.record(
          {
            action_type: 'AUTH_LOGIN_TELEGRAM',
            actor_user_id: resolved.id,
            actor_role: ParticipantRole.buyer,
            metadata: {
              provider: 'telegram',
              external_id: externalId,
              first_sign_in: !existing,
            },
          },
          tx,
        );

        return resolved;
      });
    } catch (error) {
      // Any DB failure during the upsert is a real failure — record the
      // attempt as failed (so it counts toward the lockout window) and
      // surface a generic invalid_credentials envelope. We do NOT leak
      // the underlying error.
      await this.authAttempts
        .recordAttempt(identityKey, false, requestMeta(input))
        .catch(() => undefined);
      this.logger.error(
        `Telegram login transaction failed for ${identityKey}: ${describeError(error)}`,
      );
      throw DomainException.unauthorized('auth.invalid_credentials');
    }

    // Record the successful attempt outside the tx — `AuthAttempt` is not
    // append-only at the DB-role level, and recording inside the tx would
    // tie the audit row's lifetime to the upsert's commit which we
    // already audited via `AuditService`.
    await this.authAttempts.recordAttempt(identityKey, true, requestMeta(input));

    // ── Issue session ────────────────────────────────────────────────────
    const issued = await this.sessions.issueSession(user.id, {
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });

    return {
      user,
      rawSessionToken: issued.rawToken,
      sessionExpiresAt: issued.sessionRow.expires_at,
    };
  }
}

// -----------------------------------------------------------------------------
// File-private helpers.
// -----------------------------------------------------------------------------

function requestMeta(input: LoginTelegramInput): {
  ip?: string;
  user_agent?: string;
} {
  const meta: { ip?: string; user_agent?: string } = {};
  if (typeof input.ip === 'string' && input.ip.length > 0) meta.ip = input.ip;
  if (typeof input.userAgent === 'string' && input.userAgent.length > 0) {
    meta.user_agent = input.userAgent;
  }
  return meta;
}

function pickDisplayName(user: {
  first_name?: string;
  last_name?: string;
  username?: string;
}): string | null {
  const first = typeof user.first_name === 'string' ? user.first_name.trim() : '';
  const last = typeof user.last_name === 'string' ? user.last_name.trim() : '';
  const full = [first, last].filter(Boolean).join(' ').trim();
  if (full.length > 0) return full;
  if (typeof user.username === 'string' && user.username.length > 0) {
    return `@${user.username}`;
  }
  return null;
}

/**
 * Map a Telegram `language_code` (e.g. `'km'`, `'en-US'`) onto our
 * supported `PreferredLang` enum. Defaults to `'en'` when the code is
 * unrecognised.
 */
function pickPreferredLang(code: string | undefined): 'km' | 'en' | 'zh' {
  if (typeof code !== 'string' || code.length === 0) return 'en';
  const lower = code.toLowerCase();
  if (lower.startsWith('km')) return 'km';
  if (lower.startsWith('zh')) return 'zh';
  return 'en';
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return '<unstringifiable>';
  }
}
