/**
 * SessionCookieMiddleware unit tests.
 *
 * Source of truth: tasks.md §4.4; design §"AuthService"; R1.2, R1.8.
 *
 * Tests the three observable contracts:
 *
 *   1. No-op when no credential is present.
 *   2. Cookie path resolves `req.user` / `req.session` / `req.sessionToken`.
 *   3. Bearer header path is honoured for bot/internal callers.
 *   4. Expired / revoked / unknown sessions cause a no-op (the guard,
 *      not this middleware, owns the rejection contract).
 */

import type { User, Session } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

import {
  SESSION_COOKIE_NAME,
  SessionCookieMiddleware,
  type SessionAuthenticatedRequest,
} from './session.middleware';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user_a',
    email: 'a@example.com',
    password_hash: null,
    display_name: null,
    preferred_lang: 'en' as User['preferred_lang'],
    is_admin: false,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as User;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date();
  return {
    id: 'sess_a',
    user_id: 'user_a',
    token_hash: 'hash_a',
    expires_at: new Date(now.getTime() + 60_000),
    revoked_at: null,
    created_at: now,
    user_agent: null,
    ip_inet: null,
    ...overrides,
  } as Session;
}

function makeFakeSessions(opts: {
  found?: Session | null;
  slide?: Session;
  err?: Error;
}) {
  return {
    findActiveSession: jest.fn(async (_token: string) => {
      if (opts.err) throw opts.err;
      return opts.found ?? null;
    }),
    slideExpiry: jest.fn(async (s: Session) => opts.slide ?? s),
  };
}

function makeFakePrisma(user: User | null) {
  return {
    user: {
      findUnique: jest.fn(async () => user),
    },
  };
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    cookies: {},
    ...overrides,
  } as Request;
}

function makeRes(): Response {
  return {} as Response;
}

function makeNext(): NextFunction & { calls: number } {
  const calls = { count: 0 };
  const fn = (() => {
    calls.count += 1;
  }) as NextFunction & { calls: number };
  Object.defineProperty(fn, 'calls', {
    get: () => calls.count,
  });
  return fn;
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

describe('SessionCookieMiddleware', () => {
  it('no-ops when neither cookie nor authorization header is present', async () => {
    const sessions = makeFakeSessions({});
    const prisma = makeFakePrisma(null);
    const mw = new SessionCookieMiddleware(sessions as never, prisma as never);

    const req = makeReq();
    const next = makeNext();

    await mw.use(req, makeRes(), next);

    expect(next.calls).toBe(1);
    expect(sessions.findActiveSession).not.toHaveBeenCalled();
    expect((req as SessionAuthenticatedRequest).user).toBeUndefined();
  });

  it('attaches user / session / sessionToken when the cookie resolves', async () => {
    const session = makeSession();
    const user = makeUser();
    const sessions = makeFakeSessions({ found: session });
    const prisma = makeFakePrisma(user);
    const mw = new SessionCookieMiddleware(sessions as never, prisma as never);

    const req = makeReq({
      cookies: { [SESSION_COOKIE_NAME]: 'raw-token-abc' },
    } as Partial<Request>);
    const next = makeNext();

    await mw.use(req, makeRes(), next);

    const authReq = req as SessionAuthenticatedRequest;
    expect(authReq.user).toBe(user);
    expect(authReq.session).toBe(session);
    expect(authReq.sessionToken).toBe('raw-token-abc');
    expect(next.calls).toBe(1);
  });

  it('falls back to Authorization: Bearer <token> when no cookie present', async () => {
    const session = makeSession();
    const user = makeUser();
    const sessions = makeFakeSessions({ found: session });
    const prisma = makeFakePrisma(user);
    const mw = new SessionCookieMiddleware(sessions as never, prisma as never);

    const req = makeReq({
      headers: { authorization: 'Bearer bot-token-xyz' },
    });
    const next = makeNext();

    await mw.use(req, makeRes(), next);

    expect(sessions.findActiveSession).toHaveBeenCalledWith('bot-token-xyz');
    expect((req as SessionAuthenticatedRequest).user).toBe(user);
    expect(next.calls).toBe(1);
  });

  it('prefers cookie over bearer when both are present', async () => {
    const sessions = makeFakeSessions({ found: makeSession() });
    const prisma = makeFakePrisma(makeUser());
    const mw = new SessionCookieMiddleware(sessions as never, prisma as never);

    const req = makeReq({
      cookies: { [SESSION_COOKIE_NAME]: 'cookie-token' },
      headers: { authorization: 'Bearer header-token' },
    } as Partial<Request>);

    await mw.use(req, makeRes(), makeNext());

    expect(sessions.findActiveSession).toHaveBeenCalledTimes(1);
    expect(sessions.findActiveSession).toHaveBeenCalledWith('cookie-token');
  });

  it('no-ops when findActiveSession returns null (expired / revoked / unknown)', async () => {
    const sessions = makeFakeSessions({ found: null });
    const prisma = makeFakePrisma(null);
    const mw = new SessionCookieMiddleware(sessions as never, prisma as never);

    const req = makeReq({
      cookies: { [SESSION_COOKIE_NAME]: 'stale-token' },
    } as Partial<Request>);
    const next = makeNext();

    await mw.use(req, makeRes(), next);

    expect((req as SessionAuthenticatedRequest).user).toBeUndefined();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(next.calls).toBe(1);
  });

  it('no-ops when the user row no longer exists', async () => {
    const sessions = makeFakeSessions({ found: makeSession() });
    const prisma = makeFakePrisma(null);
    const mw = new SessionCookieMiddleware(sessions as never, prisma as never);

    const req = makeReq({
      cookies: { [SESSION_COOKIE_NAME]: 'orphan-token' },
    } as Partial<Request>);
    const next = makeNext();

    await mw.use(req, makeRes(), next);

    expect((req as SessionAuthenticatedRequest).user).toBeUndefined();
    expect(next.calls).toBe(1);
  });

  it('continues as anonymous when findActiveSession throws (DB blip)', async () => {
    const sessions = makeFakeSessions({ err: new Error('db down') });
    const prisma = makeFakePrisma(makeUser());
    const mw = new SessionCookieMiddleware(sessions as never, prisma as never);

    const req = makeReq({
      cookies: { [SESSION_COOKIE_NAME]: 'any-token' },
    } as Partial<Request>);
    const next = makeNext();

    await mw.use(req, makeRes(), next);

    expect((req as SessionAuthenticatedRequest).user).toBeUndefined();
    expect(next.calls).toBe(1);
  });

  it('rejects malformed bearer header without invoking lookup', async () => {
    const sessions = makeFakeSessions({});
    const prisma = makeFakePrisma(null);
    const mw = new SessionCookieMiddleware(sessions as never, prisma as never);

    const req = makeReq({ headers: { authorization: 'NotBearer foo' } });
    await mw.use(req, makeRes(), makeNext());

    expect(sessions.findActiveSession).not.toHaveBeenCalled();
  });

  it('rejects an empty bearer token without invoking lookup', async () => {
    const sessions = makeFakeSessions({});
    const prisma = makeFakePrisma(null);
    const mw = new SessionCookieMiddleware(sessions as never, prisma as never);

    const req = makeReq({ headers: { authorization: 'Bearer   ' } });
    await mw.use(req, makeRes(), makeNext());

    expect(sessions.findActiveSession).not.toHaveBeenCalled();
  });

  it('slides the session expiry on a successful resolve (best-effort)', async () => {
    const session = makeSession();
    const sessions = makeFakeSessions({ found: session });
    const prisma = makeFakePrisma(makeUser());
    const mw = new SessionCookieMiddleware(sessions as never, prisma as never);

    const req = makeReq({
      cookies: { [SESSION_COOKIE_NAME]: 'live-token' },
    } as Partial<Request>);

    await mw.use(req, makeRes(), makeNext());
    // The slide is fire-and-forget; flush the microtask queue.
    await Promise.resolve();

    expect(sessions.slideExpiry).toHaveBeenCalledWith(session);
  });
});
