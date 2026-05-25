/**
 * AuthController unit tests (tasks.md §4.7).
 *
 * Covers the four observable contracts the task spells out:
 *
 *   1. Signup happy path → returns the user envelope and writes a
 *      `Set-Cookie: bothsafe_session=...` header via `setSessionCookie`.
 *   2. Login wrong password → 401 envelope, cookie NOT set.
 *   3. Logout → calls `SessionService.revokeSession` with the same raw
 *      token the middleware attached to `req.sessionToken`, then clears
 *      the cookie.
 *   4. `GET /auth/me` → returns the current `User` via `@CurrentUser()`
 *      when the guard has populated `req.user`.
 *
 * The controller is unit-tested in isolation: every collaborator
 * (`AuthService`, `TelegramAuthService`, `GoogleAuthService`,
 * `SessionService`) is hand-faked. We don't spin up a Nest application
 * — the controller is a thin orchestrator and the service-layer specs
 * already cover the underlying logic.
 */

import { HttpStatus } from '@nestjs/common';
import type { Session, User } from '@prisma/client';
import type { Request, Response } from 'express';

import { DomainException } from '../common/errors';

import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { GoogleAuthService } from './google-auth.service';
import {
  SESSION_COOKIE_NAME,
} from './session.middleware';
import type { SessionService } from './session.service';
import type { TelegramAuthService } from './telegram-auth.service';

// -----------------------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------------------

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'usr_alice',
    email: 'alice@example.com',
    password_hash: 'argon2id$secret',
    display_name: 'Alice',
    preferred_lang: 'en' as User['preferred_lang'],
    is_admin: false,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as User;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date('2026-02-01T00:00:00Z');
  return {
    id: 'sess_alice',
    user_id: 'usr_alice',
    token_hash: 'hash',
    expires_at: new Date(now.getTime() + SESSION_TTL_MS),
    revoked_at: null,
    created_at: now,
    user_agent: null,
    ip_inet: null,
    ...overrides,
  } as Session;
}

interface CookieRecord {
  name: string;
  value: string;
  options?: Record<string, unknown>;
}

interface FakeResponse extends Response {
  __cookies: CookieRecord[];
  __cleared: Array<{ name: string; options?: Record<string, unknown> }>;
}

function makeRes(): FakeResponse {
  const cookies: CookieRecord[] = [];
  const cleared: Array<{ name: string; options?: Record<string, unknown> }> = [];
  const res = {
    cookie(name: string, value: string, options?: Record<string, unknown>) {
      cookies.push({ name, value, options });
      return this;
    },
    clearCookie(name: string, options?: Record<string, unknown>) {
      cleared.push({ name, options });
      return this;
    },
  } as Partial<Response> as FakeResponse;
  res.__cookies = cookies;
  res.__cleared = cleared;
  return res;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    ip: '203.0.113.7',
    headers: { 'user-agent': 'jest-controller' },
    socket: { remoteAddress: '203.0.113.7' } as unknown as Request['socket'],
    ...overrides,
  } as Request;
}

function makeAuthService(): AuthService {
  return {
    signupEmail: jest.fn(),
    loginEmail: jest.fn(),
  } as unknown as AuthService;
}

function makeTelegramAuth(): TelegramAuthService {
  return {
    loginTelegram: jest.fn(),
  } as unknown as TelegramAuthService;
}

function makeGoogleAuth(): GoogleAuthService {
  return {
    loginGoogle: jest.fn(),
  } as unknown as GoogleAuthService;
}

function makeSessions(): SessionService {
  return {
    sessionTtlMs: SESSION_TTL_MS,
    revokeSession: jest.fn(async () => true),
  } as unknown as SessionService;
}

function buildController(): {
  controller: AuthController;
  authService: AuthService;
  telegramAuth: TelegramAuthService;
  googleAuth: GoogleAuthService;
  sessions: SessionService;
} {
  const authService = makeAuthService();
  const telegramAuth = makeTelegramAuth();
  const googleAuth = makeGoogleAuth();
  const sessions = makeSessions();
  const controller = new AuthController(
    authService,
    telegramAuth,
    googleAuth,
    sessions,
  );
  return { controller, authService, telegramAuth, googleAuth, sessions };
}

// -----------------------------------------------------------------------------
// Specs
// -----------------------------------------------------------------------------

describe('AuthController.signupEmail', () => {
  it('returns the sanitised user envelope and sets the session cookie', async () => {
    const { controller, authService } = buildController();
    const user = makeUser();
    const session = makeSession();
    (authService.signupEmail as jest.Mock).mockResolvedValueOnce({
      user,
      session,
      rawSessionToken: 'raw-session-abc',
    });

    const req = makeReq();
    const res = makeRes();

    const result = await controller.signupEmail(
      {
        email: 'alice@example.com',
        password: 'correct horse battery',
        displayName: 'Alice',
        preferredLang: 'en',
      },
      req,
      res,
    );

    // Service called with normalised inputs and request metadata.
    expect((authService.signupEmail as jest.Mock)).toHaveBeenCalledWith({
      email: 'alice@example.com',
      password: 'correct horse battery',
      displayName: 'Alice',
      preferredLang: 'en',
      ip: '203.0.113.7',
      userAgent: 'jest-controller',
    });

    // Cookie was written with the issued raw token and the configured TTL.
    expect(res.__cookies).toHaveLength(1);
    expect(res.__cookies[0].name).toBe(SESSION_COOKIE_NAME);
    expect(res.__cookies[0].value).toBe('raw-session-abc');
    expect(res.__cookies[0].options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS,
    });

    // The wire envelope contains exactly the public fields and the
    // session expiry as ISO-8601 — no `password_hash`, `created_at`,
    // `updated_at`, etc.
    expect(result).toEqual({
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        preferred_lang: user.preferred_lang,
        is_admin: user.is_admin,
      },
      expires_at: session.expires_at.toISOString(),
    });
    expect(result.user as object).not.toHaveProperty('password_hash');
    expect(result.user as object).not.toHaveProperty('created_at');
    expect(result.user as object).not.toHaveProperty('updated_at');
  });
});

describe('AuthController.loginEmail', () => {
  it('returns the user envelope on success', async () => {
    const { controller, authService } = buildController();
    const user = makeUser();
    const session = makeSession();
    (authService.loginEmail as jest.Mock).mockResolvedValueOnce({
      user,
      session,
      rawSessionToken: 'raw-login-token',
    });

    const res = makeRes();
    const result = await controller.loginEmail(
      { email: 'alice@example.com', password: 'correct horse battery' },
      makeReq(),
      res,
    );

    expect(result.user.id).toBe(user.id);
    expect(res.__cookies[0]?.value).toBe('raw-login-token');
  });

  it('propagates auth.invalid_credentials on a wrong password and does not set a cookie', async () => {
    const { controller, authService } = buildController();
    (authService.loginEmail as jest.Mock).mockRejectedValueOnce(
      DomainException.unauthorized('auth.invalid_credentials'),
    );

    const res = makeRes();

    const promise = controller.loginEmail(
      { email: 'alice@example.com', password: 'totally wrong password' },
      makeReq(),
      res,
    );

    await expect(promise).rejects.toBeInstanceOf(DomainException);
    await promise.catch((e: DomainException) => {
      expect(e.code).toBe('auth.invalid_credentials');
      expect(e.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      expect((e.getResponse() as { message_key: string }).message_key).toBe(
        'errors.auth.invalid_credentials',
      );
    });

    expect(res.__cookies).toHaveLength(0);
  });
});

describe('AuthController.logout', () => {
  it('revokes the active session and clears the cookie', async () => {
    const { controller, sessions } = buildController();
    const res = makeRes();

    // Simulate the SessionCookieMiddleware having attached the raw
    // token onto the request. In production this is the same token the
    // middleware already validated; the controller MUST forward it as-
    // is.
    const req = makeReq({
      // SessionCookieMiddleware contract — `sessionToken` slot.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    (req as unknown as { sessionToken: string }).sessionToken =
      'raw-current-token';

    const result = await controller.logout(req, res);

    expect((sessions.revokeSession as jest.Mock)).toHaveBeenCalledWith(
      'raw-current-token',
    );
    expect(res.__cleared).toHaveLength(1);
    expect(res.__cleared[0].name).toBe(SESSION_COOKIE_NAME);
    expect(res.__cleared[0].options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
    expect(result).toEqual({ ok: true });
  });

  it('still clears the cookie when no session token is attached (idempotent)', async () => {
    const { controller, sessions } = buildController();
    const res = makeRes();

    const result = await controller.logout(makeReq(), res);

    // No revoke call because we have no token to revoke.
    expect((sessions.revokeSession as jest.Mock)).not.toHaveBeenCalled();
    // Cookie is still cleared so a stale browser cookie cannot
    // reauthenticate against a future session row.
    expect(res.__cleared).toHaveLength(1);
    expect(result).toEqual({ ok: true });
  });
});

describe('AuthController.me', () => {
  it('returns the sanitised current user when the guard has populated req.user', () => {
    const { controller } = buildController();
    const user = makeUser({ display_name: 'Alice C.' });

    const result = controller.me(user);

    expect(result).toEqual({
      user: {
        id: user.id,
        email: user.email,
        display_name: 'Alice C.',
        preferred_lang: user.preferred_lang,
        is_admin: user.is_admin,
      },
    });
    expect(result.user as object).not.toHaveProperty('password_hash');
  });

  it('throws a contract-violation error when the guard is bypassed', () => {
    const { controller } = buildController();
    expect(() => controller.me(undefined)).toThrow(
      /AuthGuard contract violation/,
    );
  });
});
