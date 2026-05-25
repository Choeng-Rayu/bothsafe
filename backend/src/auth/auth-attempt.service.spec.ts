/**
 * AuthAttemptService unit tests.
 *
 * Source of truth: tasks.md §4.5; R1.7.
 *
 * The service has a single dependency, `PrismaService`, and only touches
 * the `auth_attempt` delegate. We stand up a minimal in-memory fake of
 * that delegate so the tests exercise the service's logic — the sliding
 * window, the threshold check, the `DomainException` it raises — without
 * spinning up a database. Schema correctness is covered by the Prisma
 * migration tests; this file owns the service contract.
 */

import { HttpStatus } from '@nestjs/common';

import {
  AUTH_LOGIN_MAX_FAILS,
  AUTH_LOGIN_WINDOW_MS,
} from '../common/constants';
import { DomainException } from '../common/errors';
import type { PrismaService } from '../prisma';

import { AuthAttemptService } from './auth-attempt.service';

interface FakeAuthAttemptRow {
  id: string;
  identity_key: string;
  attempted_at: Date;
  success: boolean;
}

/**
 * Minimal stand-in for `PrismaService.authAttempt`. Implements only the
 * two delegate methods the service consumes — `create` and `count` —
 * with the same Prisma argument shapes so the tests double as a contract
 * check on the service's queries.
 */
function makeFakePrisma(): {
  prisma: PrismaService;
  rows: FakeAuthAttemptRow[];
  /** Force `Date.now` for the duration of `fn`. */
  withClock<T>(now: number, fn: () => Promise<T>): Promise<T>;
} {
  const rows: FakeAuthAttemptRow[] = [];
  let nextId = 1;

  const create = async (args: {
    data: { identity_key: string; success: boolean; attempted_at?: Date };
  }) => {
    const row: FakeAuthAttemptRow = {
      id: `att_${nextId++}`,
      identity_key: args.data.identity_key,
      // `attempted_at` defaults to `now()` at the DB level; the service
      // never sets it explicitly, so we mirror that here.
      attempted_at: args.data.attempted_at ?? new Date(),
      success: args.data.success,
    };
    rows.push(row);
    return row;
  };

  const count = async (args: {
    where: {
      identity_key: string;
      success: boolean;
      attempted_at: { gte: Date };
    };
  }) => {
    const { identity_key, success, attempted_at } = args.where;
    return rows.filter(
      (r) =>
        r.identity_key === identity_key &&
        r.success === success &&
        r.attempted_at.getTime() >= attempted_at.gte.getTime(),
    ).length;
  };

  const fakePrisma = {
    authAttempt: { create, count },
  } as unknown as PrismaService;

  const realDateNow = Date.now.bind(Date);
  const withClock = async <T,>(now: number, fn: () => Promise<T>): Promise<T> => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      return await fn();
    } finally {
      spy.mockRestore();
      // Defensive — restore original even if `mockRestore` no-ops.
      Date.now = realDateNow;
    }
  };

  return { prisma: fakePrisma, rows, withClock };
}

/**
 * Test helper: insert a pre-aged `auth_attempt` row at a specific instant
 * relative to `now`. We bypass the service's `recordAttempt` here because
 * `recordAttempt` always stamps `attempted_at = now()`, which is exactly
 * what we want to override for window-correctness assertions.
 */
function seedFailure(
  rows: FakeAuthAttemptRow[],
  identityKey: string,
  attemptedAt: Date,
  success = false,
): void {
  rows.push({
    id: `seed_${rows.length + 1}`,
    identity_key: identityKey,
    attempted_at: attemptedAt,
    success,
  });
}

describe('AuthAttemptService', () => {
  const KEY = 'email:alice@example.com';
  const NOW = Date.UTC(2026, 5, 15, 12, 0, 0); // arbitrary fixed instant

  describe('recordAttempt', () => {
    it('inserts a single row for each call (success or failure)', async () => {
      const { prisma, rows } = makeFakePrisma();
      const service = new AuthAttemptService(prisma);

      await service.recordAttempt(KEY, false);
      await service.recordAttempt(KEY, true);

      expect(rows).toHaveLength(2);
      expect(rows[0].identity_key).toBe(KEY);
      expect(rows[0].success).toBe(false);
      expect(rows[1].identity_key).toBe(KEY);
      expect(rows[1].success).toBe(true);
    });

    it('accepts and ignores forward-compat meta (ip / user_agent)', async () => {
      // The schema (task 2.3) does not yet have ip / user_agent columns.
      // The service accepts them so call sites in tasks 4.1–4.3 can pass
      // them today and the schema can grow later without churn.
      const { prisma, rows } = makeFakePrisma();
      const service = new AuthAttemptService(prisma);

      await service.recordAttempt(KEY, false, {
        ip: '203.0.113.7',
        user_agent: 'Mozilla/5.0',
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].identity_key).toBe(KEY);
      expect(rows[0].success).toBe(false);
    });
  });

  describe('countRecentFailures (R1.7 — window correctness)', () => {
    it('counts only failures inside the trailing window', async () => {
      const { prisma, rows, withClock } = makeFakePrisma();
      const service = new AuthAttemptService(prisma);

      // Two failures inside the window, one failure aged just outside.
      seedFailure(rows, KEY, new Date(NOW - 1_000));               // 1s ago — IN
      seedFailure(rows, KEY, new Date(NOW - 5 * 60_000));          // 5m ago — IN
      seedFailure(rows, KEY, new Date(NOW - AUTH_LOGIN_WINDOW_MS - 1)); // 15m+1ms ago — OUT

      const failures = await withClock(NOW, () =>
        service.countRecentFailures(KEY),
      );
      expect(failures).toBe(2);
    });

    it('does not count successful attempts toward the failure tally', async () => {
      const { prisma, rows, withClock } = makeFakePrisma();
      const service = new AuthAttemptService(prisma);

      seedFailure(rows, KEY, new Date(NOW - 1_000), false);
      seedFailure(rows, KEY, new Date(NOW - 1_000), true); // success → ignored
      seedFailure(rows, KEY, new Date(NOW - 1_000), true); // success → ignored

      const failures = await withClock(NOW, () =>
        service.countRecentFailures(KEY),
      );
      expect(failures).toBe(1);
    });

    it('isolates buckets by identity_key', async () => {
      const { prisma, rows, withClock } = makeFakePrisma();
      const service = new AuthAttemptService(prisma);

      seedFailure(rows, KEY, new Date(NOW - 1_000));
      seedFailure(rows, 'email:bob@example.com', new Date(NOW - 1_000));
      seedFailure(rows, 'telegram:42', new Date(NOW - 1_000));

      const aliceFails = await withClock(NOW, () =>
        service.countRecentFailures(KEY),
      );
      expect(aliceFails).toBe(1);
    });

    it('honors a custom windowMs override', async () => {
      const { prisma, rows, withClock } = makeFakePrisma();
      const service = new AuthAttemptService(prisma);

      seedFailure(rows, KEY, new Date(NOW - 30_000)); // 30s ago

      const within = await withClock(NOW, () =>
        service.countRecentFailures(KEY, 60_000),
      );
      const outside = await withClock(NOW, () =>
        service.countRecentFailures(KEY, 10_000),
      );

      expect(within).toBe(1);
      expect(outside).toBe(0);
    });
  });

  describe('assertNotLocked (R1.7 — threshold)', () => {
    it('passes when failures count is below the threshold (4 of 5)', async () => {
      const { prisma, rows, withClock } = makeFakePrisma();
      const service = new AuthAttemptService(prisma);

      for (let i = 0; i < AUTH_LOGIN_MAX_FAILS - 1; i++) {
        seedFailure(rows, KEY, new Date(NOW - (i + 1) * 1_000));
      }

      await expect(
        withClock(NOW, () => service.assertNotLocked(KEY)),
      ).resolves.toBeUndefined();
    });

    it('passes at exactly 5 failures spread across the window when one ages out', async () => {
      // The "exactly-5-fails passes" guarantee from the task description
      // applies to the boundary between counted and uncounted failures:
      // when 5 failures have been recorded but one has aged outside the
      // window, only 4 are counted and the bucket is NOT locked.
      const { prisma, rows, withClock } = makeFakePrisma();
      const service = new AuthAttemptService(prisma);

      // 4 failures inside the window + 1 failure aged just outside.
      seedFailure(rows, KEY, new Date(NOW - 1_000));
      seedFailure(rows, KEY, new Date(NOW - 2_000));
      seedFailure(rows, KEY, new Date(NOW - 3_000));
      seedFailure(rows, KEY, new Date(NOW - 4_000));
      seedFailure(rows, KEY, new Date(NOW - AUTH_LOGIN_WINDOW_MS - 1)); // OUT

      await expect(
        withClock(NOW, () => service.assertNotLocked(KEY)),
      ).resolves.toBeUndefined();
    });

    it('throws auth.rate_limited on the 6th failure inside the window', async () => {
      const { prisma, rows, withClock } = makeFakePrisma();
      const service = new AuthAttemptService(prisma);

      // 6 failures all inside the window — the 6th attempt is the one
      // that should be blocked.
      for (let i = 0; i < AUTH_LOGIN_MAX_FAILS + 1; i++) {
        seedFailure(rows, KEY, new Date(NOW - (i + 1) * 1_000));
      }

      const guarded = withClock(NOW, () => service.assertNotLocked(KEY));
      await expect(guarded).rejects.toBeInstanceOf(DomainException);
      await expect(guarded).rejects.toMatchObject({
        code: 'auth.rate_limited',
      });
    });

    it('returns 429 with retry_after_seconds in details when locked', async () => {
      const { prisma, rows, withClock } = makeFakePrisma();
      const service = new AuthAttemptService(prisma);

      for (let i = 0; i < AUTH_LOGIN_MAX_FAILS; i++) {
        seedFailure(rows, KEY, new Date(NOW - (i + 1) * 1_000));
      }

      try {
        await withClock(NOW, () => service.assertNotLocked(KEY));
        fail('expected assertNotLocked to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(DomainException);
        const err = e as DomainException;
        expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        expect(err.code).toBe('auth.rate_limited');
        expect(err.details).toEqual({
          retry_after_seconds: Math.ceil(AUTH_LOGIN_WINDOW_MS / 1000),
        });
      }
    });

    it('locks exactly at the 5-failure threshold (>= AUTH_LOGIN_MAX_FAILS)', async () => {
      const { prisma, rows, withClock } = makeFakePrisma();
      const service = new AuthAttemptService(prisma);

      for (let i = 0; i < AUTH_LOGIN_MAX_FAILS; i++) {
        seedFailure(rows, KEY, new Date(NOW - (i + 1) * 1_000));
      }

      await expect(
        withClock(NOW, () => service.assertNotLocked(KEY)),
      ).rejects.toMatchObject({ code: 'auth.rate_limited' });
    });

    it('does not lock when previous failures pre-date the window even if there are many', async () => {
      const { prisma, rows, withClock } = makeFakePrisma();
      const service = new AuthAttemptService(prisma);

      // 20 ancient failures, none inside the window.
      for (let i = 0; i < 20; i++) {
        seedFailure(
          rows,
          KEY,
          new Date(NOW - AUTH_LOGIN_WINDOW_MS - 1 - i * 60_000),
        );
      }

      await expect(
        withClock(NOW, () => service.assertNotLocked(KEY)),
      ).resolves.toBeUndefined();
    });
  });
});
