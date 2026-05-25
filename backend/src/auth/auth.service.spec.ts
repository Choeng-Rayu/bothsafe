/**
 * AuthService unit tests (tasks.md §4.1, §4.2).
 *
 * Coverage focus:
 *   - signupEmail happy path: user is persisted, identity row is created,
 *     audit row is written, session is issued, attempt is recorded.
 *   - signupEmail duplicate email → `auth.email_taken` (HTTP 409).
 *   - signupEmail rate-limit lockout short-circuits before hashing.
 *   - signupEmail RangeError from `hashPassword` → BadRequest envelope.
 *   - loginEmail happy path: returns session.
 *   - loginEmail wrong password → `auth.invalid_credentials` (HTTP 401),
 *     records a failed attempt.
 *   - loginEmail unknown email → still runs `dummyVerify` so we don't
 *     short-circuit, then 401.
 *
 * The PrismaService dependency is faked: we only model the delegates
 * AuthService touches (`user`, `externalIdentity`, and the transactional
 * shape of `runInTransaction`). `SessionService`, `AuthAttemptService`
 * and `AuditService` are stubbed with `jest.fn()` so each test asserts on
 * the calls made.
 */

import { HttpStatus } from '@nestjs/common';
import { Prisma, type Session, type User } from '@prisma/client';

import type { AuditService } from '../audit';
import { DomainException } from '../common/errors';
import type { PrismaService } from '../prisma';

import { AuthAttemptService } from './auth-attempt.service';
import { AuthService } from './auth.service';
// Import the password module so we can spy on `hashPassword` /
// `verifyPassword`. We cannot use jest.mock at the top level here
// without losing the real module's exported constants; spying lets us
// keep `dummyVerify` real (so it still consumes argon2id time the same
// way the service relies on) while controlling the deterministic
// surfaces.
import * as passwordModule from './password';
import { SessionService } from './session.service';

// Argon2id with m=64MiB is intentionally slow; keep the suite generous.
jest.setTimeout(30_000);

// -----------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------

interface FakePrismaState {
  users: User[];
  identities: Array<{ user_id: string; provider: string; external_id: string }>;
  /** Queue of errors `tx.user.create` should throw next. */
  userCreateErrors: Array<unknown>;
}

function makeFakePrisma(): { prisma: PrismaService; state: FakePrismaState } {
  const state: FakePrismaState = {
    users: [],
    identities: [],
    userCreateErrors: [],
  };

  let nextId = 1;
  const newId = () => `usr_${nextId++}`;

  // The transactional client only needs the delegates AuthService uses.
  const txClient = {
    user: {
      create: jest.fn(async (args: { data: Partial<User> }) => {
        const queued = state.userCreateErrors.shift();
        if (queued !== undefined) {
          throw queued;
        }
        const now = new Date();
        const row: User = {
          id: newId(),
          email: (args.data.email ?? null) as string | null,
          password_hash: (args.data.password_hash ?? null) as string | null,
          display_name: (args.data.display_name ?? null) as string | null,
          preferred_lang: (args.data.preferred_lang ?? 'en') as User['preferred_lang'],
          is_admin: false,
          created_at: now,
          updated_at: now,
        };
        state.users.push(row);
        return row;
      }),
    },
    externalIdentity: {
      create: jest.fn(async (args: { data: { user_id: string; provider: string; external_id: string } }) => {
        state.identities.push(args.data);
        return { id: 'eid', ...args.data, created_at: new Date() };
      }),
    },
    auditLogEntry: {
      create: jest.fn(async () => undefined),
    },
  };

  const runInTransaction = jest.fn(async <T,>(fn: (tx: typeof txClient) => Promise<T>): Promise<T> => {
    return fn(txClient);
  });

  const findUnique = jest.fn(async (args: { where: { email?: string; id?: string } }) => {
    if (args.where.email) {
      return state.users.find((u) => u.email === args.where.email) ?? null;
    }
    if (args.where.id) {
      return state.users.find((u) => u.id === args.where.id) ?? null;
    }
    return null;
  });

  const prisma = {
    runInTransaction,
    user: { findUnique },
  } as unknown as PrismaService;

  // Expose the inner txClient too for assertions that need it via state
  (prisma as unknown as { __tx: typeof txClient }).__tx = txClient;

  return { prisma, state };
}

function makeFakeSessions(): SessionService {
  const issueSession = jest.fn(async (userId: string) => {
    const sessionRow = {
      id: `sess_${userId}`,
      user_id: userId,
      token_hash: 'hash',
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      revoked_at: null,
      created_at: new Date(),
      user_agent: null,
      ip_inet: null,
    } as Session;
    return { rawToken: `raw_${userId}`, sessionRow };
  });
  return {
    issueSession,
    sessionTtlMs: 24 * 60 * 60 * 1000,
  } as unknown as SessionService;
}

function makeFakeAttempts(): AuthAttemptService {
  return {
    assertNotLocked: jest.fn(async () => undefined),
    recordAttempt: jest.fn(async () => undefined),
    countRecentFailures: jest.fn(async () => 0),
  } as unknown as AuthAttemptService;
}

function makeFakeAudit(): AuditService {
  return {
    record: jest.fn(async () => undefined),
  } as unknown as AuditService;
}

function buildService(overrides: {
  prisma?: PrismaService;
  sessions?: SessionService;
  attempts?: AuthAttemptService;
  audit?: AuditService;
} = {}): {
  service: AuthService;
  prisma: PrismaService;
  state: FakePrismaState;
  sessions: SessionService;
  attempts: AuthAttemptService;
  audit: AuditService;
} {
  const { prisma, state } = overrides.prisma
    ? { prisma: overrides.prisma, state: { users: [], identities: [], userCreateErrors: [] } }
    : makeFakePrisma();
  const sessions = overrides.sessions ?? makeFakeSessions();
  const attempts = overrides.attempts ?? makeFakeAttempts();
  const audit = overrides.audit ?? makeFakeAudit();

  const service = new AuthService(prisma, attempts, sessions, audit);
  return { service, prisma, state, sessions, attempts, audit };
}

// -----------------------------------------------------------------------------
// signupEmail
// -----------------------------------------------------------------------------

describe('AuthService.signupEmail', () => {
  it('persists the user, links the email identity, audits, and issues a session', async () => {
    const { service, state, sessions, attempts, audit } = buildService();

    const result = await service.signupEmail({
      email: '  Alice@Example.COM ',
      password: 'correct horse battery',
      displayName: 'Alice',
      preferredLang: 'en',
      ip: '127.0.0.1',
      userAgent: 'jest',
    });

    // Email is normalised
    expect(state.users).toHaveLength(1);
    expect(state.users[0].email).toBe('alice@example.com');
    // password is hashed (argon2id encoded)
    expect(state.users[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(state.users[0].display_name).toBe('Alice');

    // ExternalIdentity is created
    expect(state.identities).toHaveLength(1);
    expect(state.identities[0]).toMatchObject({
      provider: 'email',
      external_id: 'alice@example.com',
    });

    // Audit, attempt, session
    expect((audit.record as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((audit.record as jest.Mock).mock.calls[0][0]).toMatchObject({
      action_type: 'EMAIL_SIGNUP',
      actor_user_id: result.user.id,
    });
    expect((attempts.assertNotLocked as jest.Mock)).toHaveBeenCalledWith('email:alice@example.com');
    expect((attempts.recordAttempt as jest.Mock)).toHaveBeenCalledWith(
      'email:alice@example.com',
      true,
      expect.objectContaining({ ip: '127.0.0.1', user_agent: 'jest' }),
    );
    expect((sessions.issueSession as jest.Mock)).toHaveBeenCalledWith(
      result.user.id,
      expect.objectContaining({ ip: '127.0.0.1', userAgent: 'jest' }),
    );
    expect(result.rawSessionToken).toBe(`raw_${result.user.id}`);
  });

  it('maps a P2002 unique-violation on email to a 409 auth.email_taken envelope', async () => {
    const { service, prisma, state, attempts } = buildService();

    // Force tx.user.create to throw the Prisma duplicate-email error
    const dupErr = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`email`)',
      { code: 'P2002', clientVersion: 'test', meta: { target: ['email'] } },
    );
    state.userCreateErrors.push(dupErr);

    const promise = service.signupEmail({
      email: 'alice@example.com',
      password: 'correct horse battery',
    });

    await expect(promise).rejects.toBeInstanceOf(DomainException);
    await promise.catch((e: DomainException) => {
      expect(e.code).toBe('auth.email_taken');
      expect(e.getStatus()).toBe(HttpStatus.CONFLICT);
    });

    // No user row should have landed (the tx rolls back through the throw)
    expect(state.users).toHaveLength(0);
    // Failure attempt was recorded for forensics
    expect((attempts.recordAttempt as jest.Mock)).toHaveBeenCalledWith(
      'email:alice@example.com',
      false,
      expect.any(Object),
    );
  });

  it('refuses an already-locked identity bucket without hashing the password', async () => {
    const attempts = makeFakeAttempts();
    (attempts.assertNotLocked as jest.Mock).mockImplementationOnce(async () => {
      throw DomainException.tooManyRequests('auth.rate_limited');
    });

    const hashSpy = jest.spyOn(passwordModule, 'hashPassword');
    const { service } = buildService({ attempts });

    await expect(
      service.signupEmail({ email: 'alice@example.com', password: 'correct horse battery' }),
    ).rejects.toMatchObject({ code: 'auth.rate_limited' });

    expect(hashSpy).not.toHaveBeenCalled();
    hashSpy.mockRestore();
  });

  it('translates a RangeError from hashPassword into 400 auth.invalid_password_length', async () => {
    const hashSpy = jest
      .spyOn(passwordModule, 'hashPassword')
      .mockRejectedValueOnce(new RangeError('auth.invalid_password_length'));

    const { service } = buildService();

    const promise = service.signupEmail({
      email: 'alice@example.com',
      // The DTO would normally catch this — we assert defence-in-depth
      // by bypassing the DTO and forcing the helper to reject.
      password: 'correct horse battery',
    });

    await expect(promise).rejects.toBeInstanceOf(DomainException);
    await promise.catch((e: DomainException) => {
      expect(e.code).toBe('auth.invalid_password_length');
      expect(e.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    });
    hashSpy.mockRestore();
  });
});

// -----------------------------------------------------------------------------
// loginEmail
// -----------------------------------------------------------------------------

describe('AuthService.loginEmail', () => {
  it('issues a session on a correct email/password pair', async () => {
    const { service, state, sessions, attempts } = buildService();

    // Seed a real user by signing up first
    await service.signupEmail({
      email: 'bob@example.com',
      password: 'correct horse battery',
    });

    const before = state.users.length;
    const result = await service.loginEmail({
      email: 'BOB@example.com',
      password: 'correct horse battery',
    });

    expect(state.users.length).toBe(before);
    expect(result.user.email).toBe('bob@example.com');
    expect(result.rawSessionToken).toBe(`raw_${result.user.id}`);
    expect((sessions.issueSession as jest.Mock)).toHaveBeenLastCalledWith(
      result.user.id,
      expect.any(Object),
    );
    expect((attempts.recordAttempt as jest.Mock)).toHaveBeenLastCalledWith(
      'email:bob@example.com',
      true,
      expect.any(Object),
    );
  });

  it('rejects a wrong password with 401 auth.invalid_credentials and records a failure', async () => {
    const { service, attempts } = buildService();
    await service.signupEmail({
      email: 'carol@example.com',
      password: 'correct horse battery',
    });

    const promise = service.loginEmail({
      email: 'carol@example.com',
      password: 'this is the wrong password',
    });

    await expect(promise).rejects.toBeInstanceOf(DomainException);
    await promise.catch((e: DomainException) => {
      expect(e.code).toBe('auth.invalid_credentials');
      expect(e.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    });

    // Last recordAttempt should be a failure
    const calls = (attempts.recordAttempt as jest.Mock).mock.calls;
    expect(calls[calls.length - 1]).toEqual([
      'email:carol@example.com',
      false,
      expect.any(Object),
    ]);
  });

  it('runs a real argon2id verify on unknown emails (no short-circuit) and returns 401', async () => {
    const { service } = buildService();
    const dummyVerifySpy = jest.spyOn(passwordModule, 'dummyVerify');

    const promise = service.loginEmail({
      email: 'noone@example.com',
      password: 'correct horse battery',
    });

    await expect(promise).rejects.toBeInstanceOf(DomainException);
    await promise.catch((e: DomainException) => {
      expect(e.code).toBe('auth.invalid_credentials');
    });
    expect(dummyVerifySpy).toHaveBeenCalledTimes(1);
    dummyVerifySpy.mockRestore();
  });

  it('refuses an already-locked identity bucket before hitting the DB', async () => {
    const attempts = makeFakeAttempts();
    (attempts.assertNotLocked as jest.Mock).mockImplementationOnce(async () => {
      throw DomainException.tooManyRequests('auth.rate_limited');
    });

    const { service, prisma } = buildService({ attempts });

    await expect(
      service.loginEmail({ email: 'eve@example.com', password: 'whatever-pw' }),
    ).rejects.toMatchObject({ code: 'auth.rate_limited' });

    // findUnique must not have been called
    expect((prisma.user.findUnique as unknown as jest.Mock)).not.toHaveBeenCalled();
  });
});
