/**
 * Property-based tests for `src/auth/password.ts` (task 3.11).
 *
 * Property: hash → verify round-trip — for every plaintext string `p` whose
 *   length is in `[PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]`,
 *   `verifyPassword(await hashPassword(p), p)` resolves to `true` (R1.4,
 *   R1.9, design "Password hashing").
 * Property: hash → verify rejects mismatched plaintexts — for any
 *   in-range plaintext `p` and any in-range `q !== p`,
 *   `verifyPassword(await hashPassword(p), q)` resolves to `false`.
 * Property: hash rejects out-of-range plaintexts — for every plaintext
 *   string whose length falls outside `[PASSWORD_MIN_LENGTH,
 *   PASSWORD_MAX_LENGTH]`, `hashPassword` throws
 *   `auth.invalid_password_length` and `verifyPassword` resolves to
 *   `false` (R1.4).
 *
 * Validates: Requirements 1.4, 1.9 (design "Password hashing").
 *
 * Note on cost: argon2id with `m=64MiB, t=3, p=4` is intentionally slow
 * (~hundreds of ms per call). We keep `numRuns` small per property and
 * raise the Jest timeout so a cold worker doesn't flake on the first
 * hash call.
 */

import * as fc from 'fast-check';
import {
  hashPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
} from './password';

jest.setTimeout(120_000);

describe('password — property tests (task 3.11)', () => {
  describe('hash → verify round-trip (R1.4, R1.9)', () => {
    it('verifyPassword(hashPassword(p), p) is true for any in-range plaintext', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({
            minLength: PASSWORD_MIN_LENGTH,
            maxLength: Math.min(64, PASSWORD_MAX_LENGTH),
          }),
          async (plain) => {
            // fast-check string arbitraries can produce strings whose
            // length in code points is in range but whose UTF-16 length
            // (what `password.ts` measures) is out of range. Skip those
            // samples — the in-range round-trip property is what we care
            // about; the length boundary is exercised separately below.
            if (
              plain.length < PASSWORD_MIN_LENGTH ||
              plain.length > PASSWORD_MAX_LENGTH
            ) {
              return true;
            }
            const hash = await hashPassword(plain);
            return (await verifyPassword(hash, plain)) === true;
          },
        ),
        { numRuns: 5 },
      );
    });

    it('verifyPassword(hashPassword(p), q) is false for any in-range q !== p', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({
            minLength: PASSWORD_MIN_LENGTH,
            maxLength: Math.min(32, PASSWORD_MAX_LENGTH),
          }),
          fc.string({
            minLength: PASSWORD_MIN_LENGTH,
            maxLength: Math.min(32, PASSWORD_MAX_LENGTH),
          }),
          async (p, q) => {
            if (
              p.length < PASSWORD_MIN_LENGTH ||
              p.length > PASSWORD_MAX_LENGTH ||
              q.length < PASSWORD_MIN_LENGTH ||
              q.length > PASSWORD_MAX_LENGTH
            ) {
              return true;
            }
            if (p === q) return true;
            const hash = await hashPassword(p);
            return (await verifyPassword(hash, q)) === false;
          },
        ),
        { numRuns: 3 },
      );
    });
  });

  describe('out-of-range plaintexts are rejected (R1.4)', () => {
    it('hashPassword throws auth.invalid_password_length for short inputs', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: PASSWORD_MIN_LENGTH - 1 }),
          async (len) => {
            const plain = 'a'.repeat(len);
            try {
              await hashPassword(plain);
              return false;
            } catch (err) {
              return (
                err instanceof RangeError &&
                err.message === 'auth.invalid_password_length'
              );
            }
          },
        ),
        { numRuns: 8 },
      );
    });

    it('hashPassword throws auth.invalid_password_length for over-long inputs', async () => {
      // Cap test length at MAX+8 to avoid generating multi-MB strings.
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: PASSWORD_MAX_LENGTH + 1, max: PASSWORD_MAX_LENGTH + 8 }),
          async (len) => {
            const plain = 'a'.repeat(len);
            try {
              await hashPassword(plain);
              return false;
            } catch (err) {
              return (
                err instanceof RangeError &&
                err.message === 'auth.invalid_password_length'
              );
            }
          },
        ),
        { numRuns: 4 },
      );
    });

    it('verifyPassword returns false for out-of-range plaintexts even against a valid hash', async () => {
      // Hash one in-range password up front so each property iteration
      // only pays for a `verifyPassword` call, not another `hashPassword`.
      const validHash = await hashPassword('correct horse battery');
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc
              .integer({ min: 0, max: PASSWORD_MIN_LENGTH - 1 })
              .map((n) => 'a'.repeat(n)),
            fc
              .integer({ min: PASSWORD_MAX_LENGTH + 1, max: PASSWORD_MAX_LENGTH + 8 })
              .map((n) => 'a'.repeat(n)),
          ),
          async (plain) => {
            return (await verifyPassword(validHash, plain)) === false;
          },
        ),
        { numRuns: 6 },
      );
    });
  });
});
