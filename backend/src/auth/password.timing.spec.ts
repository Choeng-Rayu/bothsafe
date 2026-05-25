/**
 * Argon2id round-trip and timing-safety tests (task 4.9).
 *
 * Validates: Requirements R1.4, R1.6, R1.9.
 *
 * Why this file exists alongside `password.spec.ts` and
 * `password.property.spec.ts`:
 *
 * - `password.spec.ts` covers the *parameter* contract and basic
 *   round-trip + length bounds at the example level (task 3.5).
 * - `password.property.spec.ts` covers fast-check generated coverage of
 *   the round-trip and length-bounds properties (task 3.11).
 * - This file covers task 4.9 — *deterministic, hand-written* stress and
 *   timing checks that are easier to debug when a regression appears in
 *   `AuthService.loginEmail`. fast-check is intentionally not used here
 *   so a failure dumps the explicit plaintext that broke the property.
 *
 * Why the timeout is 60s:
 * - We use the production Argon2id parameters (`m=64 MiB`, `t=3`,
 *   `p=4`, `hashLength=32`). On commodity dev hardware each
 *   `hash`/`verify` call costs roughly 150–300 ms of wall time; that is
 *   the *entire point* of an OWASP-recommended Argon2id configuration
 *   (R1.9, design "Password hashing"). The 25-sample round-trip stress
 *   plus 10 mismatch pairs plus warmup + 5 timing samples × 2 paths can
 *   easily reach 20–30 seconds even on a fast laptop, and a CI runner
 *   under load can be 2× slower. A 60-second budget gives comfortable
 *   headroom while still guaranteeing the suite terminates if argon2
 *   ever deadlocks.
 *
 * Why the timing assertion is statistical, not exact:
 * - Wall-clock measurements are noisy: GC pauses, libuv worker
 *   scheduling, and OS preemption all add jitter that easily reaches
 *   50–100 ms per call. Asserting `dummyMean ≈ realMean` exactly would
 *   flake constantly. Instead we assert `dummyMean >= 0.5 * realMean`,
 *   which is loose enough to absorb host noise but tight enough that a
 *   future regression downgrading `dummyVerify` to a no-op (e.g. an
 *   early-return that skips the throwaway argon2 verify) would drop the
 *   ratio to near zero and fail the test loudly. The contract we are
 *   guarding is "the unknown-user code path performs real Argon2id
 *   work", not "the two paths take identical time".
 */

import { randomBytes, randomInt } from 'crypto';

import {
  ARGON2ID_PARAMS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  dummyVerify,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password';

jest.setTimeout(60_000);

/**
 * Sample an in-range plaintext that is safe to feed to argon2 (no NUL
 * bytes; ASCII only so `String.length` matches the byte length the
 * wrapper guards). We deliberately keep the upper bound modest so the
 * 25-sample stress test stays inside the 60s budget on slower CI.
 */
function randomInRangePlaintext(): string {
  const minLen = PASSWORD_MIN_LENGTH;
  const maxLen = Math.min(32, PASSWORD_MAX_LENGTH);
  const len = randomInt(minLen, maxLen + 1);
  // Base64 of N bytes is ⌈4N/3⌉ chars; slicing gets us an exact length.
  return randomBytes(maxLen).toString('base64').slice(0, len);
}

function nowMs(): number {
  // hrtime gives sub-ms precision so a sub-100ms regression is still
  // visible against a ~250ms baseline.
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function mean(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s;
  return sum / samples.length;
}

describe('password — argon2id round-trip and timing safety (task 4.9)', () => {
  describe('round-trip stress (R1.4, R1.9)', () => {
    it('verifies true for 25 random in-range plaintexts and produces 25 unique $argon2id$ hashes', async () => {
      const samples = Array.from({ length: 25 }, () =>
        randomInRangePlaintext(),
      );
      const hashes = new Set<string>();

      for (const plain of samples) {
        const hash = await hashPassword(plain);
        expect(hash.startsWith('$argon2id$')).toBe(true);
        // Embed parameters check: hash should also include current memory
        // and time costs. We only check the prefix so a future param bump
        // doesn't silently leave this assertion stale.
        expect(hash).toMatch(/^\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$/);
        await expect(verifyPassword(hash, plain)).resolves.toBe(true);
        hashes.add(hash);
      }

      // Random per-call salt means collisions are astronomically
      // unlikely; this asserts salts are actually being randomised.
      expect(hashes.size).toBe(samples.length);
    });
  });

  describe('mismatch round-trip (R1.6, R1.9)', () => {
    it('verifies false for 10 random distinct pairs (p, q) — wrong password never authenticates', async () => {
      for (let i = 0; i < 10; i += 1) {
        const p = randomInRangePlaintext();
        let q = randomInRangePlaintext();
        // Vanishingly unlikely, but guarantee distinctness so the
        // assertion is meaningful.
        while (q === p) {
          q = randomInRangePlaintext();
        }
        const hash = await hashPassword(p);
        await expect(verifyPassword(hash, q)).resolves.toBe(false);
      }
    });
  });

  describe('timing-safety statistical check (R1.6, R1.9)', () => {
    it('dummyVerify takes at least 50% of real verify wall-time (regression guard against no-op dummyVerify)', async () => {
      // Warmup: prime libargon2's worker pool and force the dummyHash
      // promise to resolve so neither sampled path pays init cost.
      const warmupHash = await hashPassword('warmup-password-aaa');
      await verifyPassword(warmupHash, 'warmup-password-aaa');
      await dummyVerify('warmup');
      await dummyVerify('warmup');

      const realHash = await hashPassword('correct horse battery');
      const correctPassword = 'correct horse battery';

      const SAMPLE_COUNT = 5;
      const realSamples: number[] = [];
      const dummySamples: number[] = [];

      // Interleave samples so any background CPU contention affects
      // both paths roughly equally. If we ran all real samples first,
      // a brief load spike during that window would inflate the real
      // mean and make the 50% bar trivially pass.
      for (let i = 0; i < SAMPLE_COUNT; i += 1) {
        const realStart = nowMs();
        await verifyPassword(realHash, correctPassword);
        realSamples.push(nowMs() - realStart);

        const dummyStart = nowMs();
        await dummyVerify('x');
        dummySamples.push(nowMs() - dummyStart);
      }

      const realMean = mean(realSamples);
      const dummyMean = mean(dummySamples);

      // Sanity: argon2id with m=64MiB cannot complete in <1ms on any
      // realistic machine. If it does, ARGON2ID_PARAMS got weakened.
      expect(realMean).toBeGreaterThan(1);

      // The actual contract: dummyVerify must be doing real argon2id
      // work, so it cannot be more than ~2× faster than verifyPassword.
      // See file-header comment for why exact equality is not asserted.
      expect(dummyMean).toBeGreaterThanOrEqual(0.5 * realMean);

      // Reference ARGON2ID_PARAMS so an accidental import-prune leaves a
      // failing test instead of silently disabling the regression guard.
      expect(ARGON2ID_PARAMS.memoryCost).toBeGreaterThanOrEqual(65536);
    });
  });

  describe('malformed-input safety (R1.6, R1.9)', () => {
    it('verifyPassword returns false (never throws) for malformed hash', async () => {
      await expect(
        verifyPassword('not-a-real-hash', 'pw'),
      ).resolves.toBe(false);
    });

    it('verifyPassword returns false for empty hash', async () => {
      await expect(verifyPassword('', 'pw')).resolves.toBe(false);
    });

    it('verifyPassword returns false for malformed hash with an in-range plaintext (exercises catch path)', async () => {
      // Length check passes, so this actually reaches argon2.verify and
      // confirms the try/catch swallows decode errors instead of leaking
      // them as `auth.internal_error`.
      await expect(
        verifyPassword('$argon2id$totally-bogus-payload', 'in-range-pw'),
      ).resolves.toBe(false);
    });

    it('dummyVerify resolves false for empty and undefined inputs', async () => {
      await expect(dummyVerify('')).resolves.toBe(false);
      await expect(dummyVerify(undefined as unknown as string)).resolves.toBe(
        false,
      );
    });
  });

  describe('needsRehash rotation signal (R1.9)', () => {
    it('returns false for a fresh hash produced with current ARGON2ID_PARAMS', async () => {
      const hash = await hashPassword('correct horse battery');
      expect(needsRehash(hash)).toBe(false);
    });

    it('returns true for empty or malformed hashes (rotation on next login)', () => {
      expect(needsRehash('')).toBe(true);
      expect(needsRehash('not-a-real-hash')).toBe(true);
      expect(needsRehash('$argon2id$totally-bogus-payload')).toBe(true);
    });
  });
});
