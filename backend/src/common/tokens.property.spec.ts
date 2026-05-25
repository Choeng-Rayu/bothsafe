/**
 * Property-based tests for `src/common/tokens.ts` (task 3.11).
 *
 * Property: `hashToken` determinism — for every string `x`,
 *   `hashToken(x) === hashToken(x)` (pure function, no hidden state).
 * Property: `compareTokenHashes` reflexivity — for every token `t`,
 *   `compareTokenHashes(hashToken(t), hashToken(t))` is `true`.
 * Property: `compareTokenHashes` distinguishes distinct tokens — for every
 *   pair of distinct cuid v2 tokens `(t1, t2)`,
 *   `compareTokenHashes(hashToken(t1), hashToken(t2))` is `false`.
 * Property: `verifyToken` ⇔ `compareTokenHashes(hashToken(raw), expected)` —
 *   `verifyToken(raw, expected)` returns the same boolean as
 *   `compareTokenHashes(hashToken(raw), expected)` when `raw` clears the
 *   `MIN_TOKEN_LENGTH` precheck (R2.9, R5.8, design "Token strategy").
 * Property: `hashToken` collision-free across distinct cuid v2 tokens —
 *   for any two distinct generated tokens, their hashes differ (sample
 *   property; covers R2.9 / R5.8 hashing storage discipline).
 *
 * Validates: Requirements 2.9, 5.8 (design "Token strategy").
 */

import * as fc from 'fast-check';
import {
  compareTokenHashes,
  generateRawToken,
  hashToken,
  MIN_TOKEN_LENGTH,
  verifyToken,
} from './tokens';

describe('tokens — property tests (task 3.11)', () => {
  describe('hashToken determinism (R2.9, R5.8)', () => {
    it('hashToken(x) equals hashToken(x) for every string x', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 256 }), (x) => {
          return hashToken(x) === hashToken(x);
        }),
        { numRuns: 500 },
      );
    });

    it('hashToken always returns a 64-char lowercase hex digest', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 256 }), (x) => {
          const h = hashToken(x);
          return h.length === 64 && /^[0-9a-f]{64}$/.test(h);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('compareTokenHashes — identity and inequality (R2.9, R5.8)', () => {
    it('returns true on identical hashes (a == a)', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 256 }), (x) => {
          const h = hashToken(x);
          return compareTokenHashes(h, h) === true;
        }),
        { numRuns: 500 },
      );
    });

    it('returns false for hashes of any two distinct cuid v2 tokens', () => {
      // Two cuid v2 calls in a row are always distinct in practice.
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 1_000_000 }), () => {
          const t1 = generateRawToken();
          const t2 = generateRawToken();
          if (t1 === t2) {
            // Defensive: the cuid generator returning the same value twice
            // would itself be a bug; skip rather than fail this property,
            // which is testing the comparator, not the generator.
            return true;
          }
          return compareTokenHashes(hashToken(t1), hashToken(t2)) === false;
        }),
        { numRuns: 200 },
      );
    });

    it('hashes of distinct cuid v2 tokens are themselves distinct (collision-free sample)', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 1_000_000 }), () => {
          const t1 = generateRawToken();
          const t2 = generateRawToken();
          if (t1 === t2) return true;
          return hashToken(t1) !== hashToken(t2);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('verifyToken ⇔ compareTokenHashes(hashToken(raw), expected)', () => {
    it('agrees with compareTokenHashes for raw tokens that clear MIN_TOKEN_LENGTH', () => {
      // Generate `raw` of valid length (≥ MIN_TOKEN_LENGTH) and either
      // (a) the hash of `raw` itself — verifyToken should be true, or
      // (b) the hash of an unrelated string — verifyToken should be false.
      const validRaw = fc.string({ minLength: MIN_TOKEN_LENGTH, maxLength: 64 });
      const otherRaw = fc.string({ minLength: 1, maxLength: 64 });

      fc.assert(
        fc.property(validRaw, otherRaw, (raw, other) => {
          const expectedSame = hashToken(raw);
          const expectedDifferent = hashToken(other);

          const verifySame = verifyToken(raw, expectedSame);
          const compareSame = compareTokenHashes(hashToken(raw), expectedSame);
          if (verifySame !== compareSame) return false;

          const verifyDifferent = verifyToken(raw, expectedDifferent);
          const compareDifferent = compareTokenHashes(
            hashToken(raw),
            expectedDifferent,
          );
          return verifyDifferent === compareDifferent;
        }),
        { numRuns: 300 },
      );
    });

    it('returns false for raw tokens shorter than MIN_TOKEN_LENGTH', () => {
      const shortRaw = fc.string({ minLength: 0, maxLength: MIN_TOKEN_LENGTH - 1 });
      fc.assert(
        fc.property(shortRaw, (raw) => {
          // Even when `expected` is a valid hash of `raw`, the length
          // precheck must reject before hashing.
          return verifyToken(raw, hashToken(raw)) === false;
        }),
        { numRuns: 200 },
      );
    });
  });
});
