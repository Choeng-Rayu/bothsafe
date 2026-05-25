/**
 * AdminGuard unit tests.
 *
 * Source of truth: tasks.md §4.6; R16.6, R16.8.
 *
 * Three branches to verify:
 *
 *   1. `is_admin: true`  → `canActivate` returns `true`.
 *   2. `is_admin: false` → throws
 *      `DomainException.forbidden('auth.admin_required')` (R16.8).
 *   3. `req.user` missing → throws
 *      `DomainException.unauthorized('auth.required')` (defence-in-depth
 *      for routes mounted without `AuthGuard`).
 *
 * As with `auth.guard.spec.ts`, we hand-roll a minimal
 * `ExecutionContext` instead of pulling in `Test.createTestingModule`.
 * The guard only reads `context.switchToHttp().getRequest()` so that is
 * the entire surface worth simulating.
 */

import { HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { User } from '@prisma/client';

import { DomainException, isDomainException } from '../common/errors';
import { AdminGuard } from './admin.guard';
import type { AuthenticatedRequest } from './auth.types';

function makeHttpContext(req: Partial<AuthenticatedRequest>): ExecutionContext {
  const httpContext = {
    getRequest: <T = AuthenticatedRequest>() => req as unknown as T,
    getResponse: () => {
      throw new Error('AdminGuard should not read the response');
    },
    getNext: () => {
      throw new Error('AdminGuard should not read next()');
    },
  };
  return {
    switchToHttp: () => httpContext,
    switchToRpc: () => {
      throw new Error('AdminGuard does not support RPC contexts');
    },
    switchToWs: () => {
      throw new Error('AdminGuard does not support WS contexts');
    },
    getArgByIndex: () => undefined,
    getArgs: () => [] as unknown[],
    getClass: () => class {},
    getHandler: () => () => undefined,
    getType: () => 'http',
  } as unknown as ExecutionContext;
}

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user_test',
    email: 'admin@example.com',
    password_hash: null,
    display_name: 'Admin',
    preferred_lang: 'en',
    is_admin: false,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as unknown as User;
}

describe('AdminGuard', () => {
  let guard: AdminGuard;

  beforeEach(() => {
    guard = new AdminGuard();
  });

  describe('is_admin: true (happy path, R16.6)', () => {
    it('returns true for an admin user', () => {
      const ctx = makeHttpContext({ user: buildUser({ is_admin: true }) });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('does not mutate the request on success', () => {
      const user = buildUser({ is_admin: true });
      const req: Partial<AuthenticatedRequest> = { user };
      guard.canActivate(makeHttpContext(req));
      expect(req.user).toBe(user);
    });
  });

  describe('is_admin: false (R16.8)', () => {
    it('throws DomainException with code "auth.admin_required"', () => {
      const ctx = makeHttpContext({ user: buildUser({ is_admin: false }) });
      try {
        guard.canActivate(ctx);
        fail('expected guard to throw');
      } catch (err) {
        expect(isDomainException(err)).toBe(true);
        const e = err as DomainException;
        expect(e.code).toBe('auth.admin_required');
      }
    });

    it('uses HTTP 403 (Forbidden) for non-admin users', () => {
      const ctx = makeHttpContext({ user: buildUser({ is_admin: false }) });
      try {
        guard.canActivate(ctx);
        fail('expected guard to throw');
      } catch (err) {
        const e = err as DomainException;
        expect(e.getStatus()).toBe(HttpStatus.FORBIDDEN);
      }
    });

    it('emits the canonical "errors.auth.admin_required" message_key', () => {
      const ctx = makeHttpContext({ user: buildUser({ is_admin: false }) });
      try {
        guard.canActivate(ctx);
        fail('expected guard to throw');
      } catch (err) {
        const e = err as DomainException;
        expect((e.getResponse() as { message_key: string }).message_key).toBe(
          'errors.auth.admin_required',
        );
      }
    });

    it('treats truthy-but-not-true is_admin values (e.g. 1) as non-admin (strict equality)', () => {
      // Defends the `!== true` check: only the boolean literal `true`
      // should pass. A misconfigured deserialiser handing back `1`
      // should be rejected, not silently elevated.
      const ctx = makeHttpContext({
        user: buildUser({ is_admin: 1 as unknown as boolean }),
      });
      try {
        guard.canActivate(ctx);
        fail('expected guard to throw');
      } catch (err) {
        const e = err as DomainException;
        expect(e.code).toBe('auth.admin_required');
      }
    });
  });

  describe('missing req.user (defence-in-depth)', () => {
    it('throws "auth.required" when req.user is undefined', () => {
      const ctx = makeHttpContext({});
      try {
        guard.canActivate(ctx);
        fail('expected guard to throw');
      } catch (err) {
        expect(isDomainException(err)).toBe(true);
        const e = err as DomainException;
        // We reject as `auth.required` (not `auth.admin_required`) so
        // the response shape matches what `AuthGuard` would have
        // emitted in the canonical composition order.
        expect(e.code).toBe('auth.required');
        expect(e.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      }
    });

    it('throws "auth.required" when req.user is explicitly null', () => {
      const ctx = makeHttpContext({ user: null as unknown as User });
      try {
        guard.canActivate(ctx);
        fail('expected guard to throw');
      } catch (err) {
        const e = err as DomainException;
        expect(e.code).toBe('auth.required');
      }
    });
  });
});
