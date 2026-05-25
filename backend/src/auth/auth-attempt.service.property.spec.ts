/**
 * AuthAttemptService — property-based tests for sliding-window correctness.
 *
 * Source of truth: tasks.md §4.8; design.md §"Property-based testing
 * hooks"; R1.7 ("IF a User exceeds 5 failed authentication attempts within
 * a rolling 15-minute window, THEN THE Auth_Service SHALL reject further
 * attempts from the same identity with an `auth.rate_limited` error
 * until the window expires.").
 *
 * The unit spec at `auth-attempt.service.spec.ts` covers hand-picked
 * boundary cases (exactly 4 failures, exactly 5, ancient failures,
 * etc.). This file fuzzes the same surface with `fast-check` to catch
 * window-arithmetic mistakes the unit cases didn't anticipate.
 *
 * ## Properties asserted
 *
 *   1. **Window characterisation.** For any list of `(timestamp, success)`
 *      attempts and any `now`, `countRecentFailures(key, windowMs)` equals
 *      the count of `success === false` rows with
 *      `attempted_at ≥ now - windowMs`.
 *   2. **Threshold equivalence.** `assertNotLocked` throws
 *      `auth.rate_limited` iff `countRecentFailures ≥ AUTH_LOGIN_MAX_FAILS`.
 *   3. **Identity-key isolation.** Failures recorded under one
 *      `identity_key` never affect counts under any other key.
 *   4. **Window monotonicity.** For a fixed history, advancing `now`
 *      monotonically (older → newer) produces a non-increasing failure
 *      count — older failures age out, none re-enter.
 *   5. **Success rows never count.** Adding any number of successful
 *      attempts at any timestamps leaves the failure tally unchanged.
 *
 * ## Test strategy
 *
 * The service has a single I/O dependency, `PrismaService.authAttempt`,
 * and only consumes its `create` and `count` methods. We stand up an
 * in-memory fake of that delegate (the same shape the unit spec uses) so
 * the properties exercise the service's filter logic directly without a
 * Postgres roundtrip. Schema-level invariants are owned by the migration
 * and integration suites; this file owns the service's algorithmic
 * contract against the spec.
 *
 * `Date.now` is mocked per sample with `jest.spyOn` so each property
 * iteration runs against a deterministic clock. The mock is restored
 * after every iteration so `fast-check` shrinking is not polluted by
 * cross-sample state.
 *
 * Validates: Requirements 1.7.
 */

import * as fc from 'fast-check';

import {
  AUTH_LOGIN_MAX_FAILS,
  AUTH_LOGIN_WINDOW_MS,
} from '../common/constants';
import { DomainException } from '../common/errors';
import type { PrismaService } from '../prisma';

import { AuthAttemptService } from './auth-attempt.service';

// -----------------------------------------------------------------------------
// In-memory `auth_attempt` fake.
//
// Same shape as the one in `auth-attempt.service.spec.ts`, factored into
// helpers tuned for property-based use:
//   - `seed` admits arbitrary `attempted_at` so we can fuzz timestamps,
//     unlike `recordAttempt` which always stamps `now()`.
//   - `withClock` pins `Date.now()` for the duration of a callback so
//     each property iteration runs against a deterministic clock without
//     leaking state between samples.
// -----------------------------------------------------------------------------

interface FakeAuthAttemptRow {
  id: string;
  identity_key: string;
  attempted_at: Date;
  success: boolean;
}

function makeFakePrisma(): {
  prisma: PrismaService;
  rows: FakeAuthAttemptRow[];
  seed: (
    identityKey: string,
    attemptedAtMs: number,
    success: boolean,
  ) => void;
  withClock<T>(nowMs: number, fn: () => Promise<T>): Promise<T>;
} {
  const rows: FakeAuthAttemptRow[] = [];
  let nextId = 1;

  const create = async (args: {
    data: { identity_key: string; success: boolean; attempted_at?: Date };
  }) => {
    const row: FakeAuthAttemptRow = {
      id: `att_${nextId++}`,
      identity_key: args.data.identity_key,
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

  const seed = (
    identityKey: string,
    attemptedAtMs: number,
    success: boolean,
  ): void => {
    rows.push({
      id: `seed_${nextId++}`,
      identity_key: identityKey,
      attempted_at: new Date(attemptedAtMs),
      success,
    });
  };

  const realDateNow = Date.now.bind(Date);
  const withClock = async <T,>(
    nowMs: number,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    try {
      return await fn();
    } finally {
      spy.mockRestore();
      // Defensive — restore original even if `mockRestore` no-ops.
      Date.now = realDateNow;
    }
  };

  return { prisma: fakePrisma, rows, seed, withClock };
}

// -----------------------------------------------------------------------------
// Reference implementation — the spec, expressed in TypeScript.
//
// Returns the count of failure rows whose `attempted_at` falls in the
// closed interval `[now - windowMs, now]`. The service implementation
// uses an open-ended `>= cutoff` filter; constraining sample timestamps
// to the past (which is what the production system can ever observe)
// makes the two definitions agree exactly.
// -----------------------------------------------------------------------------

interface Attempt {
  attemptedAtMs: number;
  success: boolean;
}

function referenceCount(
  attempts: readonly Attempt[],
  nowMs: number,
  windowMs: number,
): number {
  const cutoff = nowMs - windowMs;
  return attempts.filter(
    (a) => a.success === false && a.attemptedAtMs >= cutoff,
  ).length;
}

// -----------------------------------------------------------------------------
// Arbitraries.
//
// Anchor every generated timestamp to `NOW_ANCHOR` so samples land in a
// realistic range without overflowing 53-bit safe-integer arithmetic on
// the date math.
// -----------------------------------------------------------------------------

const NOW_ANCHOR = Date.UTC(2026, 5, 15, 12, 0, 0);

/**
 * Yields a millisecond timestamp in `[NOW_ANCHOR - 4 * windowMs, NOW_ANCHOR]`
 * — far enough back that some samples age out of every reasonable
 * window, near enough to `now` that some land inside.
 */
const arbAttemptedAtMs = fc.integer({
  min: NOW_ANCHOR - 4 * AUTH_LOGIN_WINDOW_MS,
  max: NOW_ANCHOR,
});

const arbAttempt: fc.Arbitrary<Attempt> = fc.record({
  attemptedAtMs: arbAttemptedAtMs,
  success: fc.boolean(),
});

const arbAttemptList: fc.Arbitrary<Attempt[]> = fc.array(arbAttempt, {
  minLength: 0,
  maxLength: 30,
});

/**
 * Identity keys mimic the `email:` / `telegram:` / `google:` convention
 * documented in `auth-attempt.service.ts` so isolation samples look
 * realistic without the test having to encode the prefix rules.
 */
const arbIdentityKey: fc.Arbitrary<string> = fc.oneof(
  fc.string({ minLength: 1, maxLength: 24 }).map((s) => `email:${s}`),
  fc.integer({ min: 1, max: 10_000 }).map((n) => `telegram:${n}`),
  fc.string({ minLength: 1, maxLength: 24 }).map((s) => `google:${s}`),
);

// -----------------------------------------------------------------------------

describe('AuthAttemptService — property tests (R1.7)', () => {
  describe('window characterisation (R1.7)', () => {
    // Property: countRecentFailures(key, windowMs) === |{ a in attempts |
    //   a.identity_key === key && a.success === false &&
    //   a.attemptedAtMs >= now - windowMs }|
    it('countRecentFailures matches a reference filter for any history and any now', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbAttemptList,
          arbIdentityKey,
          arbAttemptedAtMs, // reuse: any timestamp in the realistic range serves as `now`
          fc.integer({ min: 1, max: 4 * AUTH_LOGIN_WINDOW_MS }),
          async (attempts, key, nowMs, windowMs) => {
            const { prisma, seed, withClock } = makeFakePrisma();
            const service = new AuthAttemptService(prisma);

            // All attempts are recorded under `key` so the reference and
            // the service see the same bucket. Identity-key isolation is
            // exercised separately below.
            //
            // Constrain seeded timestamps to `<= nowMs` so the test
            // mirrors production (rows can never be inserted "in the
            // future" of the wall clock). Both reference and service
            // would agree on future-dated rows in any case — neither
            // imposes an upper bound — but the constraint keeps the
            // property aligned with R1.7's intended `[now - 15min, now]`
            // semantics rather than with an implementation quirk.
            const past = attempts.filter((a) => a.attemptedAtMs <= nowMs);
            for (const a of past) {
              seed(key, a.attemptedAtMs, a.success);
            }

            const expected = referenceCount(past, nowMs, windowMs);

            const actual = await withClock(nowMs, () =>
              service.countRecentFailures(key, windowMs),
            );

            return actual === expected;
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('threshold equivalence (R1.7)', () => {
    // Property: assertNotLocked throws iff countRecentFailures >=
    // AUTH_LOGIN_MAX_FAILS for the same (key, now, windowMs).
    it('assertNotLocked throws iff countRecentFailures >= AUTH_LOGIN_MAX_FAILS', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Bias the failure count toward the threshold so we exercise
          // both the locked and unlocked branches roughly evenly. Pure
          // failures here — successes are exercised in the success-row
          // property below.
          fc.array(
            arbAttemptedAtMs.map((ms) => ({ attemptedAtMs: ms, success: false })),
            { minLength: 0, maxLength: 12 },
          ),
          arbIdentityKey,
          arbAttemptedAtMs,
          async (failures, key, nowMs) => {
            const { prisma, seed, withClock } = makeFakePrisma();
            const service = new AuthAttemptService(prisma);

            for (const f of failures) {
              seed(key, f.attemptedAtMs, false);
            }

            const expectedLocked =
              referenceCount(failures, nowMs, AUTH_LOGIN_WINDOW_MS) >=
              AUTH_LOGIN_MAX_FAILS;

            let threw = false;
            let thrown: unknown;
            try {
              await withClock(nowMs, () => service.assertNotLocked(key));
            } catch (e) {
              threw = true;
              thrown = e;
            }

            if (threw !== expectedLocked) return false;
            if (threw) {
              return (
                thrown instanceof DomainException &&
                (thrown as DomainException).code === 'auth.rate_limited'
              );
            }
            return true;
          },
        ),
        { numRuns: 150 },
      );
    });
  });

  describe('identity-key isolation (R1.7)', () => {
    // Property: failures under `keyA` never affect the failure count
    // under any other `keyB !== keyA`.
    it('failures under one identity key do not affect counts under another', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbAttemptList,
          arbAttemptList,
          arbIdentityKey,
          arbIdentityKey,
          arbAttemptedAtMs,
          async (attemptsA, attemptsB, keyA, keyB, nowMs) => {
            // Skip degenerate samples where the two keys collide — the
            // property is vacuous when keyA === keyB.
            if (keyA === keyB) return true;

            const { prisma, seed, withClock } = makeFakePrisma();
            const service = new AuthAttemptService(prisma);

            for (const a of attemptsA) seed(keyA, a.attemptedAtMs, a.success);
            for (const b of attemptsB) seed(keyB, b.attemptedAtMs, b.success);

            // Count for `keyA` should match a reference that ignores
            // every row recorded under `keyB`.
            const expectedA = referenceCount(
              attemptsA,
              nowMs,
              AUTH_LOGIN_WINDOW_MS,
            );
            const actualA = await withClock(nowMs, () =>
              service.countRecentFailures(keyA),
            );
            if (actualA !== expectedA) return false;

            const expectedB = referenceCount(
              attemptsB,
              nowMs,
              AUTH_LOGIN_WINDOW_MS,
            );
            const actualB = await withClock(nowMs, () =>
              service.countRecentFailures(keyB),
            );
            return actualB === expectedB;
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('window monotonicity (R1.7)', () => {
    // Property: for any fixed history, advancing `now` monotonically
    // produces a non-increasing failure count — older failures age out,
    // none re-enter.
    it('failure count is non-increasing as now advances over a fixed history', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbAttemptList,
          arbIdentityKey,
          // Two `now` values; we order them so `nowEarly <= nowLate` per
          // sample so the property holds independently of the order
          // fast-check produced them in.
          arbAttemptedAtMs,
          arbAttemptedAtMs,
          async (attempts, key, t1, t2) => {
            const nowEarly = Math.min(t1, t2);
            const nowLate = Math.max(t1, t2);

            const { prisma, seed, withClock } = makeFakePrisma();
            const service = new AuthAttemptService(prisma);
            for (const a of attempts) {
              seed(key, a.attemptedAtMs, a.success);
            }

            const countEarly = await withClock(nowEarly, () =>
              service.countRecentFailures(key),
            );
            const countLate = await withClock(nowLate, () =>
              service.countRecentFailures(key),
            );

            return countLate <= countEarly;
          },
        ),
        { numRuns: 150 },
      );
    });
  });

  describe('successes never count toward the failure tally (R1.7)', () => {
    // Property: adding any number of successful attempts at any
    // timestamps leaves the failure count unchanged. Equivalently,
    // countRecentFailures(history) === countRecentFailures(history ∪ S)
    // for every set S of success rows.
    it('adding success rows does not change countRecentFailures', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbAttemptList,
          fc.array(arbAttemptedAtMs, { minLength: 0, maxLength: 30 }),
          arbIdentityKey,
          arbAttemptedAtMs,
          async (mixed, successTimestamps, key, nowMs) => {
            // Baseline: only the original mixed history.
            const { prisma: p1, seed: seed1, withClock: clock1 } =
              makeFakePrisma();
            const svc1 = new AuthAttemptService(p1);
            for (const a of mixed) seed1(key, a.attemptedAtMs, a.success);
            const baseline = await clock1(nowMs, () =>
              svc1.countRecentFailures(key),
            );

            // Augmented: the same history plus a pile of successes.
            const { prisma: p2, seed: seed2, withClock: clock2 } =
              makeFakePrisma();
            const svc2 = new AuthAttemptService(p2);
            for (const a of mixed) seed2(key, a.attemptedAtMs, a.success);
            for (const ts of successTimestamps) seed2(key, ts, true);
            const augmented = await clock2(nowMs, () =>
              svc2.countRecentFailures(key),
            );

            return baseline === augmented;
          },
        ),
        { numRuns: 100 },
      );
    });

    // Property: assertNotLocked is unaffected by success rows under the
    // same key. If a bucket is locked under the failure history, it
    // remains locked when arbitrary successes are added; if it is not
    // locked, it remains not locked.
    it('assertNotLocked decision is unaffected by success rows', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            arbAttemptedAtMs.map((ms) => ({ attemptedAtMs: ms, success: false })),
            { minLength: 0, maxLength: 12 },
          ),
          fc.array(arbAttemptedAtMs, { minLength: 0, maxLength: 12 }),
          arbIdentityKey,
          arbAttemptedAtMs,
          async (failures, successTimestamps, key, nowMs) => {
            const measure = async (
              attempts: { attemptedAtMs: number; success: boolean }[],
            ): Promise<boolean> => {
              const { prisma, seed, withClock } = makeFakePrisma();
              const service = new AuthAttemptService(prisma);
              for (const a of attempts) seed(key, a.attemptedAtMs, a.success);
              try {
                await withClock(nowMs, () => service.assertNotLocked(key));
                return false;
              } catch (e) {
                return (
                  e instanceof DomainException &&
                  (e as DomainException).code === 'auth.rate_limited'
                );
              }
            };

            const lockedFailuresOnly = await measure(failures);
            const lockedWithSuccesses = await measure([
              ...failures,
              ...successTimestamps.map((ts) => ({
                attemptedAtMs: ts,
                success: true,
              })),
            ]);

            return lockedFailuresOnly === lockedWithSuccesses;
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
