/**
 * GoogleAuthService — sign-in via verified Google OAuth `id_token`.
 *
 * Source of truth: tasks.md §4.3; design §"AuthService → loginGoogle";
 * R1.1, R1.3.
 *
 * ## Flow
 *
 *   1. Client (Google Identity Services widget) submits the JWT to
 *      `POST /v1/auth/google` as `{ id_token }`.
 *   2. Controller forwards `{ idToken, ip?, userAgent? }` here.
 *   3. `verifyGoogleIdToken` (`google-auth-library`) verifies signature,
 *      issuer, audience (= `env.GOOGLE_CLIENT_ID`), and expiry. Failure
 *      modes return `null`.
 *   4. We compute `identityKey = 'google:<sub>'` and call
 *      `authAttempts.assertNotLocked(...)` (R1.7).
 *   5. Upsert `ExternalIdentity { provider: 'google', external_id: sub }`
 *      and the linked `User` inside a single Prisma `$transaction`.
 *      Create the per-currency `Wallet` rows on first sign-in. Backfill
 *      `User.email` from the verified `email` claim when the local row
 *      doesn't yet have one.
 *   6. Issue a fresh `Session` via `SessionService.issueSession` and
 *      return the raw token + `User` row.
 *
 * Both successful and failed verifications record an `AuthAttempt` row.
 *
 * Verification failures collapse to
 * `DomainException.unauthorized('auth.invalid_credentials')` (R1.6 timing
 * parity with the email path) — never a more specific code, so the
 * server cannot leak which check failed.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type User } from '@prisma/client';

import { ALL_CURRENCIES, ParticipantRole } from '../common/enums';
import { DomainException } from '../common/errors';
import { PrismaService } from '../prisma';
import { AuditService } from '../audit';

import { AuthAttemptService } from './auth-attempt.service';
import { SessionService } from './session.service';
import { verifyGoogleIdToken, type GoogleClaims } from './google-id-token';

export interface LoginGoogleInput {
  idToken: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface LoginGoogleResult {
  user: User;
  rawSessionToken: string;
  sessionExpiresAt: Date;
}

@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly authAttempts: AuthAttemptService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async loginGoogle(input: LoginGoogleInput): Promise<LoginGoogleResult> {
    const audience = this.config.get<string>('google.clientId');
    if (typeof audience !== 'string' || audience.length === 0) {
      this.logger.error(
        'GOOGLE_CLIENT_ID is not configured; refusing Google login.',
      );
      throw DomainException.unauthorized('auth.invalid_credentials');
    }

    // ── Verify the id_token ──────────────────────────────────────────────
    let claims: GoogleClaims | null;
    try {
      claims = await verifyGoogleIdToken(input.idToken, audience);
    } catch {
      claims = null;
    }

    if (!claims) {
      throw DomainException.unauthorized('auth.invalid_credentials');
    }

    const identityKey = `google:${claims.sub}`;
    await this.authAttempts.assertNotLocked(identityKey);

    // ── Upsert ExternalIdentity + User + Wallets in a single tx ──────────
    let user: User;
    try {
      user = await this.prisma.runInTransaction(async (tx) => {
        const existing = await tx.externalIdentity.findUnique({
          where: {
            provider_external_id: {
              provider: 'google',
              external_id: claims.sub,
            },
          },
          include: { user: true },
        });

        let resolved: User;
        if (existing) {
          resolved = existing.user;
          // Backfill email when the local row was created before we
          // knew it (e.g. user signed up via Telegram first, then
          // linked Google). Best-effort: ignore unique-collision if
          // some other account already owns the address.
          if (!resolved.email && typeof claims.email === 'string') {
            try {
              resolved = await tx.user.update({
                where: { id: resolved.id },
                data: { email: claims.email },
              });
            } catch (error) {
              if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
              ) {
                // Another `User` already owns this email; leave the
                // existing row's email column null. The Google account
                // is still linked via `ExternalIdentity`.
                this.logger.warn(
                  `Google email backfill skipped for user ${resolved.id}: address already in use.`,
                );
              } else {
                throw error;
              }
            }
          }
        } else {
          // First-time sign-in. Try to attach to an existing
          // email-only `User` row when the verified Google email matches
          // (R1.3 dedup) — otherwise create a brand-new user.
          if (
            typeof claims.email === 'string' &&
            claims.email_verified !== false
          ) {
            const byEmail = await tx.user.findUnique({
              where: { email: claims.email },
            });
            if (byEmail) {
              resolved = byEmail;
            } else {
              resolved = await tx.user.create({
                data: {
                  email: claims.email,
                  display_name: claims.name ?? null,
                },
              });
            }
          } else {
            resolved = await tx.user.create({
              data: {
                display_name: claims.name ?? null,
              },
            });
          }

          await tx.externalIdentity.create({
            data: {
              user_id: resolved.id,
              provider: 'google',
              external_id: claims.sub,
            },
          });

          // Create per-currency wallets on first sign-in. Skip rows
          // that already exist (e.g. when we attached to a pre-existing
          // email-only user) to keep the upsert idempotent.
          for (const currency of ALL_CURRENCIES) {
            await tx.wallet.upsert({
              where: {
                user_id_currency: { user_id: resolved.id, currency },
              },
              create: {
                user_id: resolved.id,
                currency,
              },
              update: {},
            });
          }
        }

        await this.audit.record(
          {
            action_type: 'AUTH_LOGIN_GOOGLE',
            actor_user_id: resolved.id,
            actor_role: ParticipantRole.buyer,
            metadata: {
              provider: 'google',
              external_id: claims.sub,
              first_sign_in: !existing,
              email_verified: claims.email_verified ?? null,
            },
          },
          tx,
        );

        return resolved;
      });
    } catch (error) {
      await this.authAttempts
        .recordAttempt(identityKey, false, requestMeta(input))
        .catch(() => undefined);
      this.logger.error(
        `Google login transaction failed for ${identityKey}: ${describeError(error)}`,
      );
      throw DomainException.unauthorized('auth.invalid_credentials');
    }

    await this.authAttempts.recordAttempt(identityKey, true, requestMeta(input));

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

function requestMeta(input: LoginGoogleInput): {
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

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return '<unstringifiable>';
  }
}
