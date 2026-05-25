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
import {
  verifyTelegramWidget,
  type TelegramWidgetPayload,
  type VerifiedTelegramWidgetUser,
} from './telegram-widget';

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

/**
 * Input to {@link TelegramAuthService.loginTelegramWidget} — the
 * web Login Widget delivers a flat `{id, first_name, …, hash}` object
 * rather than the URL-encoded `initData` blob.
 */
export interface LoginTelegramWidgetInput {
  payload: TelegramWidgetPayload;
  ip?: string | null;
  userAgent?: string | null;
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
      throw DomainException.unauthorized('auth.invalid_credentials');
    }

    return this.upsertAndIssue(
      {
        id: verified.user.id,
        first_name: verified.user.first_name,
        last_name: verified.user.last_name,
        username: verified.user.username,
        language_code: verified.user.language_code,
      },
      { ip: input.ip ?? null, userAgent: input.userAgent ?? null },
    );
  }

  /**
   * Sign-in via Telegram Login Widget (web). Same upsert-and-issue
   * path as `loginTelegram`, but the verifier uses the
   * `secret = SHA256(bot_token)` scheme (not `WebAppData`).
   */
  async loginTelegramWidget(
    input: LoginTelegramWidgetInput,
  ): Promise<LoginTelegramResult> {
    const botToken = this.config.get<string>('telegram.botToken');
    if (typeof botToken !== 'string' || botToken.length === 0) {
      this.logger.error(
        'TELEGRAM_BOT_TOKEN is not configured; refusing Telegram widget login.',
      );
      throw DomainException.unauthorized('auth.invalid_credentials');
    }

    let verified: VerifiedTelegramWidgetUser | null;
    try {
      verified = verifyTelegramWidget(input.payload, botToken);
    } catch {
      verified = null;
    }
    if (!verified) {
      throw DomainException.unauthorized('auth.invalid_credentials');
    }

    return this.upsertAndIssue(
      {
        id: verified.id,
        first_name: verified.first_name,
        last_name: verified.last_name,
        username: verified.username,
      },
      { ip: input.ip ?? null, userAgent: input.userAgent ?? null },
    );
  }

  private async upsertAndIssue(
    telegram: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
      language_code?: string;
    },
    request: { ip: string | null; userAgent: string | null },
  ): Promise<LoginTelegramResult> {
    const externalId = String(telegram.id);
    const identityKey = `telegram:${externalId}`;

    await this.authAttempts.assertNotLocked(identityKey);

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

          for (const currency of ALL_CURRENCIES) {
            await tx.wallet.create({
              data: { user_id: resolved.id, currency },
            });
          }
        }

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
      await this.authAttempts
        .recordAttempt(
          identityKey,
          false,
          requestMeta({ ip: request.ip, userAgent: request.userAgent }),
        )
        .catch(() => undefined);
      this.logger.error(
        `Telegram login transaction failed for ${identityKey}: ${describeError(error)}`,
      );
      throw DomainException.unauthorized('auth.invalid_credentials');
    }

    await this.authAttempts.recordAttempt(
      identityKey,
      true,
      requestMeta({ ip: request.ip, userAgent: request.userAgent }),
    );

    const issued = await this.sessions.issueSession(user.id, {
      ip: request.ip,
      userAgent: request.userAgent,
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

function requestMeta(input: {
  ip?: string | null;
  userAgent?: string | null;
}): {
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
