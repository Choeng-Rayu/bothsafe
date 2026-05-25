/**
 * Property-based tests for `src/common/money.ts` (task 3.11).
 *
 * Property: parse/format round-trip — `parseMoney(formatMoney(x))` is
 *   numerically equal to `x` for every 2-decimal Decimal in
 *   [MIN_DEAL_AMOUNT, MAX_DEAL_AMOUNT] (R2.1, R3.1, R7.1, R14.1, R15.1).
 * Property: commutativity of `add` — `add(a, b).eq(add(b, a))` for every
 *   pair of valid 2-decimal monetary values (R14.1).
 * Property: associativity of `add` — `add(add(a, b), c).eq(add(a, add(b, c)))`
 *   exactly, since decimal.js addition over 2dp values produces an exact
 *   2dp result (no rounding error).
 * Property: `assertSameCurrency` symmetry — for every pair `(a, b)` of
 *   `Currency` values, `assertSameCurrency(a, b)` throws iff
 *   `assertSameCurrency(b, a)` throws (R9.6).
 * Property: `assertValidDealAmount` bounds — accepts every value in
 *   `[MIN_DEAL_AMOUNT, MAX_DEAL_AMOUNT]` and rejects every value strictly
 *   outside that range with `money.out_of_range` (R2.1, R3.1).
 *
 * Validates: Requirements 2.1, 3.1, 7.1, 9.6, 14.1, 15.1.
 */

import * as fc from 'fast-check';
import Decimal from 'decimal.js';
import { ALL_CURRENCIES, Currency } from './enums';
import {
  add,
  assertSameCurrency,
  assertValidDealAmount,
  formatMoney,
  parseMoney,
  MAX_DEAL_AMOUNT,
  MIN_DEAL_AMOUNT,
} from './money';

/**
 * Arbitrary that yields canonical 2-decimal money strings strictly within
 * the legal deal-amount range `[0.01, 999_999_999.99]`. Generated as an
 * integer count of cents and reformatted to the canonical string form so
 * every sample round-trips cleanly through `parseMoney`.
 *
 * Note: the cent-count upper bound (99_999_999_999) is below
 * `Number.MAX_SAFE_INTEGER` (~9.0e15), so plain `fc.integer` is safe here.
 */
const dealAmountString = fc
  .integer({ min: 1, max: 99_999_999_999 })
  .map((cents) => {
    const padded = cents.toString().padStart(3, '0');
    const whole = padded.slice(0, -2);
    const frac = padded.slice(-2);
    return `${whole}.${frac}`;
  });

/** Same as `dealAmountString` but returned as a parsed `Decimal`. */
const dealAmountDecimal = dealAmountString.map((s) => parseMoney(s));

/**
 * Arbitrary for amounts strictly above `MAX_DEAL_AMOUNT` (1_000_000_000.00
 * up to 9_999_999_999.99). Used to exercise the upper-bound rejection path
 * of `assertValidDealAmount`.
 */
const aboveMaxAmountString = fc
  .integer({ min: 100_000_000_000, max: 999_999_999_999 })
  .map((cents) => {
    const padded = cents.toString().padStart(3, '0');
    const whole = padded.slice(0, -2);
    const frac = padded.slice(-2);
    return `${whole}.${frac}`;
  });

describe('money — property tests (task 3.11)', () => {
  describe('parse/format round-trip (R2.1, R14.1)', () => {
    it('parseMoney(formatMoney(x)) is numerically equal to x for every 2dp value in range', () => {
      fc.assert(
        fc.property(dealAmountDecimal, (x) => {
          const round = parseMoney(formatMoney(x));
          return round.eq(x);
        }),
        { numRuns: 500 },
      );
    });

    it('formatMoney always emits exactly two fractional digits', () => {
      fc.assert(
        fc.property(dealAmountDecimal, (x) => {
          const s = formatMoney(x);
          // Canonical form: optional digits, '.', exactly two fractional digits.
          return /^\d+\.\d{2}$/.test(s);
        }),
        { numRuns: 500 },
      );
    });
  });

  describe('add — commutativity and associativity (R14.1)', () => {
    it('add(a, b) equals add(b, a) for every pair of 2dp money values', () => {
      fc.assert(
        fc.property(dealAmountDecimal, dealAmountDecimal, (a, b) => {
          return add(a, b).eq(add(b, a));
        }),
        { numRuns: 500 },
      );
    });

    it('add(add(a, b), c) equals add(a, add(b, c)) exactly (no FP drift on 2dp values)', () => {
      fc.assert(
        fc.property(
          dealAmountDecimal,
          dealAmountDecimal,
          dealAmountDecimal,
          (a, b, c) => {
            const left = add(add(a, b), c);
            const right = add(a, add(b, c));
            return left.eq(right);
          },
        ),
        { numRuns: 500 },
      );
    });

    it('add of two 2dp values yields a 2dp result', () => {
      fc.assert(
        fc.property(dealAmountDecimal, dealAmountDecimal, (a, b) => {
          const sum = add(a, b);
          return sum.decimalPlaces() <= 2;
        }),
        { numRuns: 500 },
      );
    });
  });

  describe('assertSameCurrency — symmetry (R9.6)', () => {
    it('throws iff the reversed call also throws', () => {
      fc.assert(
        fc.property(
          fc.constantFrom<Currency>(...ALL_CURRENCIES),
          fc.constantFrom<Currency>(...ALL_CURRENCIES),
          (a, b) => {
            const fwd = throwsFrom(() => assertSameCurrency(a, b));
            const rev = throwsFrom(() => assertSameCurrency(b, a));
            return fwd === rev;
          },
        ),
        { numRuns: 50 },
      );
    });

    it('throws exactly when the two currencies differ', () => {
      fc.assert(
        fc.property(
          fc.constantFrom<Currency>(...ALL_CURRENCIES),
          fc.constantFrom<Currency>(...ALL_CURRENCIES),
          (a, b) => {
            const threw = throwsFrom(() => assertSameCurrency(a, b));
            return threw === (a !== b);
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe('assertValidDealAmount — bounds (R2.1, R3.1)', () => {
    it('accepts every 2dp value in the inclusive range', () => {
      fc.assert(
        fc.property(dealAmountString, (s) => {
          const d = assertValidDealAmount(s);
          return d.gte(MIN_DEAL_AMOUNT) && d.lte(MAX_DEAL_AMOUNT);
        }),
        { numRuns: 500 },
      );
    });

    it('returns a Decimal numerically equal to the input string', () => {
      fc.assert(
        fc.property(dealAmountString, (s) => {
          return assertValidDealAmount(s).eq(new Decimal(s));
        }),
        { numRuns: 500 },
      );
    });

    it('rejects values strictly above the upper bound with money.out_of_range', () => {
      fc.assert(
        fc.property(aboveMaxAmountString, (s) => {
          try {
            assertValidDealAmount(s);
            return false;
          } catch (err) {
            return err instanceof RangeError && err.message === 'money.out_of_range';
          }
        }),
        { numRuns: 200 },
      );
    });

    it('rejects 0 and negative 2dp values with money.out_of_range', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 99_999_999_999 }),
          (cents) => {
            const padded = cents.toString().padStart(3, '0');
            const whole = padded.slice(0, -2);
            const frac = padded.slice(-2);
            const negativeOrZero =
              cents === 0 ? `0.00` : `-${whole}.${frac}`;
            try {
              assertValidDealAmount(negativeOrZero);
              return false;
            } catch (err) {
              return (
                err instanceof RangeError && err.message === 'money.out_of_range'
              );
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});

/** Returns true when `fn` throws any error, false when it returns normally. */
function throwsFrom(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
