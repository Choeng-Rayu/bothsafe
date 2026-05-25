/**
 * AuthService — sign-up and login orchestration for the email/password
 * identity flow.
 *
 * Source of truth: tasks.md §4.1 (signupEmail) and §4.2 (loginEmail);
 * design §"AuthService" / §"User and authentication"; AGENTS.md →
 * "Backend Coding Rules".
 * Acceptance criteria: R1.1, R1.4, R1.5, R1.6, R1.7, R1.9.
 *
 * ## Responsibilities of THIS file
 *
 *   - `signupEmail(...)` — validate inputs (DTO already enforces format),
 *     guard against rate-limit lockout, hash the password with argon2id,
 *     create the `User` (+ `ExternalIdentity('email', email)` +
 *     `Wallet` rows) inside a single Prisma transaction, write the
 *     `EMAIL_SIGNUP` audit row in the same tx, then mint a fresh
 *     `Session` after the tx commits.
 *   - `loginEmail(...)` — guard against rate-limit lockout, look up the
 *     user, run a constant-time argon2id verify (with a `dummyVerify`
 *     fallback for the unknown-email branch so the response time does
 *     not leak account existence), record the success/failure attempt,
 *     and on success mint a fresh `Session`.
 *
 * Sibling tasks own complementary surfaces:
 *
 *   - Task 4.3 (`loginTelegram`, `loginGoogle`) — additional auth
 *     entrypoints. They reuse `AuthAttemptService.assertNotLocked /
 *     recordAttempt` and `SessionService.issueSession` exactly the same
 *     way this service does.
 *   - Task 4.4 (`SessionService`, `SessionCookieMiddleware`) — already
 *     landed; we depend on it via DI.
 *   - Task 4.5 (`AuthAttemptService`) — already landed; we depend on it
 *     via DI.
 *   - Task 4.7 (auth controller) — turns the service surface into HTTP
 *     routes and wires `setSessionCookie(...)`.
 *
 * ## Why the password hash lives behind argon2id and the helper module
 *
 * The argon2id wrapper (`src/auth/password.ts`) enforces the
 * 8–128-character bound (R1.4) by throwing `RangeError` and never logs
 * plaintext or hash material (R1.9). The DTO already enforces the same
 * bound — defence-in-depth.
 *
 * ## Why we run `dummyVerify` on unknown emails
 *
 * R1.6 / R1.9: an attacker SHOULD NOT be able to enumerate accounts via
 * timing. If we shortcut to `auth.invalid_credentials` on `user === null`
 * the response time would be measurably faster than the
 * argon2id-verify path. `dummyVerify` runs a real argon2id verify
 * against a random throwaway hash with the current parameters so the
 * unknown-email branch consumes the same wall-clock budget.
 *
 * ## Why `recordAttempt` runs on success too
 *
 * R1.7 specifies a sliding-window rate limit on FAILED attempts, but
 * forensics needs the full attempt history (logins from new IPs, geo
 * anomalies, etc.). `AuthAttemptService.countRecentFailures` filters by
 * `success = false`, so successful rows do NOT count against the
 * lockout — they're just there for the audit timeline. Persisting both
 * outcomes is also what the design's "Cross-Cutting Concerns → Rate
 * limiting" calls out explicitly.
 *
 * ## Why no Wallet creation for KHR/USD inside the signup tx?
 *
 * Design §"Wallet and ledger" specifies `Wallet` rows are created
 * lazily by `WalletService.getOrCreate(userId, currency)` on first
 * payment. A signup-time pre-allocation would be wasted work for users
 * who only act as buyers in one currency. We therefore do NOT create a
 * wallet here — the lazy path is the canonical entry point and lives in
 * task 6.1.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Session, type User } from '@prisma/client';

import { AuditService } from '../audit';
import { DomainException } from '../common/errors';
import { PrismaService } from '../prisma';
import { AuthAttemptService, type AuthAttemptMeta } from './auth-attempt.service';
import {
  dummyVerify,
  hashPassword,
  verifyPassword,
} from './password';
import { SessionService } from './session.service';

// -----------------------------------------------------------------------------
// Public surface
// -----------------------------------------------------------------------------

/**
 * Optional request metadata captured at signup / login time. Forwarded
 * into both the `AuthAttempt` row (for forensics) and the issued
 * `Session` row (`ip_inet`, `user_agent`).
 *
 * Both fields are best-effort: they reflect Express's `req.ip` /
 * `req.headers['user-agent']` resolution chain (which depends on
 * trust-proxy configuration). Treat as advisory.
 */
export interface AuthRequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** Input shape for {@link AuthService.signupEmail}. */
export interface SignupEmailInput {
  email: string;
  password: string;
  displayName?: string | null;
  /** When omitted, the schema default `'en'` applies. */
  preferredLang?: 'km' | 'en' | 'zh' | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Input shape for {@link AuthService.loginEmail}. */
export interface LoginEmailInput {
  email: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Result of either authenticating flow.
 *
 * `rawSessionToken` is returned exactly once and MUST be placed in the
 * `bothsafe_session` cookie by the controller (`setSessionCookie`).
 * `session` carries `expires_at` so the controller can echo the value
 * back to the client (the design's standard auth response shape).
 */
export interface AuthResult {
  user: User;
  session: Session;
  rawSessionToken: string;
}

/**
 * Soft upper bound (in milliseconds) for the entire login flow per
 * R1.6. Exceeding it merely emits a warning log line — we never abort
 * a successful verify just because argon2id was slow on a contended
 * worker pool.
 */
const LOGIN_FLOW_BUDGET_MS = 2000;

/**
 * Audit `action_type` values produced by this service. Strings (not an
 * enum) for the same reason `audit_log_entry.action_type` is TEXT —
 * future codes can be added without a migration.
 */
const AUDIT_ACTION_EMAIL_SIGNUP = 'EMAIL_SIGNUP';
const AUDIT_ACTION_EMAIL_LOGIN = 'EMAIL_LOGIN';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authAttempts: AuthAttemptService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // signupEmail (task 4.1)
  // ---------------------------------------------------------------------------

  /**
   * Create a new email-backed `User`, link an `ExternalIdentity('email')`
   * row, write the audit entry, and mint a session.
   *
   * The `email` argument is expected to be already trimmed and
   * lowercased by the DTO; we re-normalise defensively so a programmatic
   * caller (e.g. the Telegram bot) cannot bypass the casing rule and
   * end up in a different rate-limit bucket. The DTO also enforces the
   * password length bounds; we let `hashPassword` re-enforce them as
   * defence-in-depth.
   *
   * On `email_taken` (Prisma `P2002` on `user_email_unique`) we map to
   * `DomainException.conflict('auth.email_taken')` so the global filter
   * emits the canonical envelope. The `User` row never lands when this
   * branch fires (the failure happens inside the same transaction that
   * creates it).
   *
   * Throws:
   *   - `DomainException.tooManyRequests('auth.rate_limited')` when the
   *     identity bucket is locked (R1.7).
   *   - `DomainException.badRequest('auth.invalid_password_length')`
   *     when `hashPassword` rejects the password (R1.4 defence-in-depth).
   *     The DTO is the primary gate; this catch handles the rare bypass.
   *   - `DomainException.conflict('auth.email_taken')` on duplicate email
   *     (R1.5 / unique constraint).
   */
  async signupEmail(input: SignupEmailInput): Promise<AuthResult> {
    const normalizedEmail = normaliseEmail(input.email);
    const identityKey = `email:${normalizedEmail}`;
    const meta = pickMeta(input);

    // 1. R1.7 — block locked buckets BEFORE hashing the password so we
    // do not burn argon2id cycles on a request that cannot succeed.
    await this.authAttempts.assertNotLocked(identityKey);

    // 2. Hash the password ahead of the transaction. Argon2id is CPU
    // bound — keeping it outside the DB transaction means we hold the
    // Postgres connection only for the actual writes, not for the
    // ~250 ms hashing window.
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(input.password);
    } catch (error) {
      // Map the documented `RangeError` from `hashPassword` to a
      // BadRequest envelope (R1.4 / R1.5). Any other error path is
      // unexpected and falls through to the global filter as
      // `server.internal_error`.
      if (
        error instanceof RangeError &&
        error.message === 'auth.invalid_password_length'
      ) {
        throw DomainException.badRequest('auth.invalid_password_length');
      }
      throw error;
    }

    // 3. Run the create + identity link + audit insert in a single tx
    // so a failure in any step rolls back the User row (R20.4).
    let createdUser: User;
    try {
      createdUser = await this.prisma.runInTransaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: normalizedEmail,
            password_hash: passwordHash,
            display_name: input.displayName?.trim() || null,
            ...(input.preferredLang
              ? { preferred_lang: input.preferredLang }
              : {}),
          },
        });

        await tx.externalIdentity.create({
          data: {
            user_id: user.id,
            provider: 'email',
            external_id: normalizedEmail,
          },
        });

        await this.audit.record(
          {
            action_type: AUDIT_ACTION_EMAIL_SIGNUP,
            actor_user_id: user.id,
            metadata: {
              identity: 'email',
              ip: meta.ip ?? null,
              user_agent: meta.userAgent ?? null,
            },
          },
          tx,
        );

        return user;
      });
    } catch (error) {
      // Translate a Prisma unique-violation on `user.email` (or on the
      // `(provider, external_id)` index of `external_identity`) into the
      // canonical `auth.email_taken` envelope. Recording a failed
      // attempt here is intentional: it mirrors the dual outcome we use
      // on login so the per-identity history is complete.
      if (isUniqueViolation(error)) {
        await this.safelyRecordAttempt(identityKey, false, meta);
        throw DomainException.conflict('auth.email_taken');
      }
      throw error;
    }

    // 4. Record the successful attempt + mint the session AFTER the
    // signup transaction commits. A failure here does not roll back the
    // user — they exist and can simply log in next time. We log loudly
    // if the session issuance fails so the operator notices.
    await this.safelyRecordAttempt(identityKey, true, meta);

    const issued = await this.sessions.issueSession(createdUser.id, {
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      user: createdUser,
      session: issued.sessionRow,
      rawSessionToken: issued.rawToken,
    };
  }

  // ---------------------------------------------------------------------------
  // loginEmail (task 4.2)
  // ---------------------------------------------------------------------------

  /**
   * Authenticate an existing email-backed user.
   *
   * Flow:
   *   1. Compute `identityKey`, normalise email.
   *   2. `assertNotLocked(identityKey)` (R1.7).
   *   3. Look up `User` by email. On a miss, run `dummyVerify` so the
   *      response time matches the wrong-password branch (R1.6 / R1.9
   *      timing parity), then record + throw `auth.invalid_credentials`.
   *   4. On a hit, `verifyPassword(stored_hash, input)`. On false, record
   *      + throw `auth.invalid_credentials`.
   *   5. On true, record success and `sessions.issueSession`.
   *
   * The 2-second upper bound (R1.6) is enforced as a soft warning, not
   * a hard abort: a successful verify that happens to take 2.05 s on a
   * contended worker is still preferable to a false negative.
   */
  async loginEmail(input: LoginEmailInput): Promise<AuthResult> {
    const startedAt = Date.now();
    const normalizedEmail = normaliseEmail(input.email);
    const identityKey = `email:${normalizedEmail}`;
    const meta = pickMeta(input);

    // R1.7 — block locked buckets before any DB lookup or argon2id call.
    await this.authAttempts.assertNotLocked(identityKey);

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    let verified = false;

    if (user === null || user.password_hash === null) {
      // Unknown email or email-only-via-OAuth user. Burn the same
      // argon2id budget as a real verify so timing doesn't reveal the
      // distinction (R1.6 / R1.9).
      await dummyVerify(input.password);
    } else {
      verified = await verifyPassword(user.password_hash, input.password);
    }

    if (!verified) {
      await this.safelyRecordAttempt(identityKey, false, meta);
      this.logElapsedIfOverBudget(startedAt, 'failed');
      throw DomainException.unauthorized('auth.invalid_credentials');
    }

    // From here on `user` is non-null (verified === true requires a
    // user with a stored hash).
    const authenticatedUser = user!;

    // Record the successful attempt outside the session-issuance path
    // so a brief DB blip on the rate-limit table never poisons the
    // login itself.
    await this.safelyRecordAttempt(identityKey, true, meta);

    const issued = await this.sessions.issueSession(authenticatedUser.id, {
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    // R20.x — login is also auditable. We write the row outside a
    // transaction because there is no other DML to bind to: the session
    // INSERT already happened, and a failure here does not roll back
    // the cookie the controller is about to send. We therefore wrap the
    // audit call in its own tiny tx so the AuditService contract
    // (`tx is required`) is honoured.
    try {
      await this.prisma.runInTransaction(async (tx) => {
        await this.audit.record(
          {
            action_type: AUDIT_ACTION_EMAIL_LOGIN,
            actor_user_id: authenticatedUser.id,
            metadata: {
              identity: 'email',
              ip: meta.ip ?? null,
              user_agent: meta.userAgent ?? null,
            },
          },
          tx,
        );
      });
    } catch (error) {
      // A bookkeeping audit failure must not break login; log and move
      // on. The session was already issued.
      this.logger.warn(
        `EMAIL_LOGIN audit insert failed for user=${authenticatedUser.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    this.logElapsedIfOverBudget(startedAt, 'succeeded');

    return {
      user: authenticatedUser,
      session: issued.sessionRow,
      rawSessionToken: issued.rawToken,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Wrap `recordAttempt` so a transient DB error in the rate-limit
   * audit path does not eclipse the original auth outcome we want to
   * surface to the caller. We log loudly and continue.
   */
  private async safelyRecordAttempt(
    identityKey: string,
    success: boolean,
    meta: { ip: string | undefined; userAgent: string | undefined },
  ): Promise<void> {
    try {
      await this.authAttempts.recordAttempt(identityKey, success, {
        ip: meta.ip,
        user_agent: meta.userAgent,
      } satisfies AuthAttemptMeta);
    } catch (error) {
      this.logger.warn(
        `recordAttempt failed (identityKey=${identityKey}, success=${success}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * R1.6 — surface a warning when the login flow exceeds the 2-second
   * upper bound. Never aborts the request; argon2id with m=64 MiB is
   * intentionally slow and a contended host can briefly exceed the
   * budget without the response being broken.
   */
  private logElapsedIfOverBudget(
    startedAt: number,
    outcome: 'succeeded' | 'failed',
  ): void {
    const elapsed = Date.now() - startedAt;
    if (elapsed > LOGIN_FLOW_BUDGET_MS) {
      this.logger.warn(
        `loginEmail ${outcome} in ${elapsed} ms (> ${LOGIN_FLOW_BUDGET_MS} ms budget)`,
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Module-private helpers
// -----------------------------------------------------------------------------

/**
 * Normalise an email into the canonical lowercase trimmed form used as
 * both the storage key and the rate-limiter bucket key. The DTO already
 * runs the same transform; we re-apply it here so programmatic callers
 * (services calling services) cannot bypass the contract.
 */
function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Extract the optional request metadata fields shared by signup/login. */
function pickMeta(input: { ip?: string | null; userAgent?: string | null }): {
  ip: string | undefined;
  userAgent: string | undefined;
} {
  return {
    ip: input.ip ?? undefined,
    userAgent: input.userAgent ?? undefined,
  };
}

/**
 * Type guard for Prisma's `P2002` (unique constraint violation). Matches
 * both via `instanceof` and a structural fallback because the Prisma 7
 * driver-adapter setup occasionally surfaces errors that don't quite
 * pass the public `instanceof` check.
 */
function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2002';
  }
  if (typeof error !== 'object' || error === null) return false;
  const maybe = error as { code?: unknown; name?: unknown };
  return (
    maybe.code === 'P2002' && maybe.name === 'PrismaClientKnownRequestError'
  );
}
