/**
 * AuthGuard unit tests.
 *
 * Source of truth: tasks.md §4.6; R1.8.
 *
 * The guard is a thin wrapper around the `req.user` slot populated by
 * `SessionCookieMiddleware`. Tests cover the two branches the guard
 * actually owns:
 *
 *   1. Unauthenticated request → throws
 *      `DomainException.unauthorized('auth.required')` so the global
 *      filter renders the canonical envelope (R1.8).
 *   2. Authenticated request   → returns `true`.
 *
 * We construct a hand-rolled `ExecutionContext` because the guard only
 * touches `context.switchToHttp().getRequest()`. Spinning up a full
 * `Test.createTestingModule` would obscure the contract under nest
 * boilerplate without exercising any extra code path.
 */

import { HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { User } from '@prisma/client';

import { DomainException, isDomainException } from '../common/errors';
import type { AuthenticatedRequest } from './auth.types';
import { AuthGuard } from './auth.guard';

/**
 * Build an `ExecutionContext` whose only meaningful behaviour is
 * exposing the supplied request via `switchToHttp().getRequest()`. Any
 * other access throws so an accidental dependency on additional context
 * surface fails the test loudly.
 *
 * Typed against `AuthenticatedRequest` (not raw `Request`) so the `user`
 * slot the guard inspects is a recognised property at the call site.
 */
function makeHttpContext(req: Partial<AuthenticatedRequest>): ExecutionContext {
  const httpContext = {
    getRequest: <T = AuthenticatedRequest>() => req as unknown as T,
    getResponse: () => {
      throw new Error('AuthGuard should not read the response');
    },
    getNext: () => {
      throw new Error('AuthGuard should not read next()');
    },
  };
  return {
    switchToHttp: () => httpContext,
    switchToRpc: () => {
      throw new Error('AuthGuard does not support RPC contexts');
    },
    switchToWs: () => {
      throw new Error('AuthGuard does not support WS contexts');
    },
    getArgByIndex: () => undefined,
    getArgs: () => [] as unknown[],
    getClass: () => class {},
    getHandler: () => () => undefined,
    getType: () => 'http',
  } as unknown as ExecutionContext;
}

/**
 * Minimal `User` fixture. We only construct the fields the guard
 * branches on, then cast to `User` to avoid duplicating the entire
 * Prisma row across every test.
 */
function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user_test',
    email: 'alice@example.com',
    password_hash: null,
    display_name: 'Alice',
    preferred_lang: 'en',
    is_admin: false,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as unknown as User;
}

describe('AuthGuard', () => {
  let guard: AuthGuard;

  beforeEach(() => {
    guard = new AuthGuard();
  });

  describe('unauthenticated request (R1.8)', () => {
    it('throws DomainException with code "auth.required" when req.user is undefined', () => {
      const ctx = makeHttpContext({});

      try {
        guard.canActivate(ctx);
        fail('expected guard to throw');
      } catch (err) {
        expect(isDomainException(err)).toBe(true);
        const e = err as DomainException;
        expect(e.code).toBe('auth.required');
      }
    });

    it('uses HTTP 401 (Unauthorized) for the missing-session case', () => {
      const ctx = makeHttpContext({});
      try {
        guard.canActivate(ctx);
        fail('expected guard to throw');
      } catch (err) {
        const e = err as DomainException;
        expect(e.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      }
    });

    it('emits the canonical "errors.auth.required" message_key', () => {
      const ctx = makeHttpContext({});
      try {
        guard.canActivate(ctx);
        fail('expected guard to throw');
      } catch (err) {
        const e = err as DomainException;
        expect((e.getResponse() as { message_key: string }).message_key).toBe(
          'errors.auth.required',
        );
      }
    });

    it('throws when req.user is explicitly null', () => {
      const ctx = makeHttpContext({ user: null as unknown as User });
      expect(() => guard.canActivate(ctx)).toThrow(DomainException);
    });
  });

  describe('authenticated request (happy path)', () => {
    it('returns true when req.user is a populated User row', () => {
      const ctx = makeHttpContext({ user: buildUser() });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('returns true regardless of the user\'s is_admin flag (admin gating belongs to AdminGuard)', () => {
      const adminCtx = makeHttpContext({ user: buildUser({ is_admin: true }) });
      const memberCtx = makeHttpContext({ user: buildUser({ is_admin: false }) });
      expect(guard.canActivate(adminCtx)).toBe(true);
      expect(guard.canActivate(memberCtx)).toBe(true);
    });

    it('does not mutate the request', () => {
      const user = buildUser();
      const req: Partial<AuthenticatedRequest> = { user };
      const ctx = makeHttpContext(req);
      guard.canActivate(ctx);
      // Identity preserved; the guard is a pure read.
      expect(req.user).toBe(user);
    });
  });
});
