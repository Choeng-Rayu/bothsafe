/**
 * Monetary helpers built on top of `decimal.js`.
 *
 * BothSafe stores all money columns as PostgreSQL `NUMERIC(18,2)` and the
 * Prisma client maps them to `Prisma.Decimal` (a re-export of `decimal.js`).
 * Every monetary computation in the backend MUST go through these helpers so
 * that:
 *
 *   1. Native `Number` arithmetic is never used on money (no FP drift).
 *   2. Inputs are normalised to a 2-decimal canonical form (`'12.30'`,
 *      `'0.01'`).
 *   3. Out-of-range or higher-precision inputs are rejected up front, before
 *      they reach Prisma or the wallet ledger.
 *
 * Precision/rounding is configured once on module load:
 *
 *   `Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP })`
 *
 * The `Decimal` constructor itself is intentionally NOT re-exported from this
 * module — keep the dependency contained so the rest of the codebase only
 * depends on these typed helpers.
 *
 * Usage:
 *
 *   ```ts
 *   import {
 *     parseMoney,
 *     formatMoney,
 *     gte,
 *     plus,
 *     assertValidDealAmount,
 *   } from '@/common/money';
 *
 *   const amount = assertValidDealAmount(dto.deal_amount);
 *   const total = plus(amount, '0.50');
 *   const display = formatMoney(total);          // -> '13.30'
 *   const canPay = gte(walletBalance, amount);   // -> boolean
 *   ```
 *
 * Requirements: R2.1, R3.1, R7.1, R14.1, R15.1.
 */

import Decimal from 'decimal.js';
import type { Prisma } from '@prisma/client';
import { Currency } from './enums';

// One-time global configuration. Done at module top, before any parseMoney
// call below evaluates the MIN/MAX constants.
Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

/**
 * Anything we accept as a monetary input across the codebase.
 *
 * `Prisma.Decimal` is the runtime type Prisma returns for `Decimal` columns;
 * it shares the same underlying class as `decimal.js`, so it's accepted by
 * the `Decimal` constructor used internally. We keep both in the union so
 * call sites don't need to widen Prisma values manually.
 */
export type MoneyInput = string | number | Prisma.Decimal | Decimal;

/**
 * Parse any accepted input into a `Decimal` with at most two decimal places.
 *
 * - Strings are trimmed; empty strings are rejected.
 * - Numbers must be finite (rejects `NaN`, `Infinity`, `-Infinity`).
 * - `Prisma.Decimal` / `Decimal` instances are re-wrapped through the local
 *   `decimal.js` constructor so all subsequent math uses our configured
 *   precision/rounding.
 * - Any input that ends up with more than 2 decimal places (e.g. `1.234`,
 *   `'0.001'`, a `Decimal` carrying 6 dp) is REJECTED — we never silently
 *   truncate. This mirrors the spec's "at most 2 decimal places" rule from
 *   R2.1 / R7.1 / R14.1.
 *
 * @throws {RangeError} `money.invalid` for any unparseable, non-finite, or
 *   higher-precision input.
 *
 * @example
 *   parseMoney('12.30')   // Decimal('12.30')
 *   parseMoney(0.01)      // Decimal('0.01')
 *   parseMoney('1.234')   // throws RangeError('money.invalid')
 *   parseMoney('   ')     // throws RangeError('money.invalid')
 */
export function parseMoney(value: MoneyInput): Decimal {
  if (value === null || value === undefined) {
    throw new RangeError('money.invalid');
  }

  let d: Decimal;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      throw new RangeError('money.invalid');
    }
    try {
      d = new Decimal(trimmed);
    } catch {
      throw new RangeError('money.invalid');
    }
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError('money.invalid');
    }
    try {
      d = new Decimal(value);
    } catch {
      throw new RangeError('money.invalid');
    }
  } else {
    // Prisma.Decimal or Decimal — both implement the `decimal.js` shape.
    try {
      d = new Decimal(value as Decimal);
    } catch {
      throw new RangeError('money.invalid');
    }
  }

  if (!d.isFinite()) {
    throw new RangeError('money.invalid');
  }
  if (d.decimalPlaces() > 2) {
    throw new RangeError('money.invalid');
  }

  return d;
}

/**
 * Render a `Decimal` as the canonical two-decimal string. Always pads to
 * exactly two fractional digits so display, hashing, and DB serialisation
 * agree.
 *
 * @example
 *   formatMoney(new Decimal('12.3'))  // '12.30'
 *   formatMoney(new Decimal('0'))     // '0.00'
 *   formatMoney(new Decimal('0.01'))  // '0.01'
 */
export function formatMoney(d: Decimal): string {
  return d.toFixed(2);
}

/**
 * Alias for {@link parseMoney}. Provided so service code reads naturally
 * (`toDecimal(dto.amount)`) when the intent is "coerce arbitrary input
 * into a typed `Decimal`" rather than "validate as money".
 *
 * Both functions enforce the same 2-decimal/finite invariants — pick the
 * name that best matches the call site's intent.
 */
export function toDecimal(value: MoneyInput): Decimal {
  return parseMoney(value);
}

/**
 * Quantise a `Decimal` to the canonical 2-decimal precision used by every
 * money column in BothSafe (`NUMERIC(18,2)`).
 *
 * The design doc and Prisma schema store both `USD` and `KHR` as
 * `NUMERIC(18,2)` (design §"Persistence model" notation: "Money columns
 * use `NUMERIC(18,2)`"; see `prisma/schema.prisma` `deal_amount`,
 * `wallet_ledger_entry.amount`, `withdrawal_request.amount`). There is
 * NO separate 0-decimal codepath for KHR — both currencies are 2dp
 * everywhere in the persistence layer, the API surface, and the audit
 * log. The `currency` argument is accepted so the helper is future-proof
 * if Bakong ever adds a non-2dp currency, but for the MVP both branches
 * round to 2dp using banker-friendly `ROUND_HALF_UP` (configured at
 * module load).
 *
 * Use this helper before persisting the result of a multi-step
 * computation (fee math, refund splits, currency conversions) so that
 * the value Prisma stores matches what the service later compares
 * against `gte` / `eq`. Inputs that are already 2dp pass through
 * untouched.
 *
 * @throws {RangeError} `money.invalid` if the input is invalid.
 *
 * @example
 *   quantize(new Decimal('12.305'), Currency.USD).toFixed(2)  // '12.31'
 *   quantize('0.001', Currency.KHR).toFixed(2)                // '0.00'
 *   quantize(plus('0.10', '0.20'), Currency.USD).toFixed(2)   // '0.30'
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function quantize(value: MoneyInput, _currency: Currency): Decimal {
  // `parseMoney` already rejects > 2dp inputs; a fresh `Decimal` ensures
  // intermediate results from `plus`/`minus`/`times` (which may carry
  // extra precision) collapse to 2dp before persistence.
  let d: Decimal;
  if (value instanceof Decimal) {
    d = value;
  } else if (typeof value === 'string' || typeof value === 'number') {
    // Parse without the 2dp guard so callers can quantise intermediate
    // values that legitimately carry more precision (e.g. fee math).
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '') throw new RangeError('money.invalid');
      d = new Decimal(trimmed);
    } else {
      if (!Number.isFinite(value)) throw new RangeError('money.invalid');
      d = new Decimal(value);
    }
  } else {
    d = new Decimal(value as Decimal);
  }
  if (!d.isFinite()) throw new RangeError('money.invalid');
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * `a >= b`, after parsing both sides through {@link parseMoney}.
 *
 * @throws {RangeError} `money.invalid` if either input is invalid.
 */
export function gte(a: MoneyInput, b: MoneyInput): boolean {
  return parseMoney(a).gte(parseMoney(b));
}

/**
 * `a < b`, after parsing both sides through {@link parseMoney}.
 *
 * @throws {RangeError} `money.invalid` if either input is invalid.
 */
export function lt(a: MoneyInput, b: MoneyInput): boolean {
  return parseMoney(a).lt(parseMoney(b));
}

/**
 * `a + b` as a `Decimal`. Both operands are validated; the result preserves
 * up to two decimal places (since both inputs do).
 *
 * @throws {RangeError} `money.invalid` if either input is invalid.
 *
 * @example
 *   plus('12.30', '0.50')  // Decimal('12.80')
 */
export function plus(a: MoneyInput, b: MoneyInput): Decimal {
  return parseMoney(a).plus(parseMoney(b));
}

/**
 * Alias for {@link plus}. Provided so service code reads naturally
 * (`add(balance, deposit)`).
 */
export const add = plus;

/**
 * `a - b` as a `Decimal`. Both operands are validated; the result preserves
 * up to two decimal places (since both inputs do).
 *
 * @throws {RangeError} `money.invalid` if either input is invalid.
 *
 * @example
 *   minus('12.30', '0.50')  // Decimal('11.80')
 */
export function minus(a: MoneyInput, b: MoneyInput): Decimal {
  return parseMoney(a).minus(parseMoney(b));
}

/**
 * Alias for {@link minus}. Provided so service code reads naturally
 * (`sub(balance, hold)`).
 */
export const sub = minus;

/**
 * Inclusive range check: `min <= d <= max`. The `min` and `max` arguments
 * are parsed through {@link parseMoney}; `d` is assumed to already be a
 * validated `Decimal` (typically the result of `parseMoney` upstream).
 *
 * @throws {RangeError} `money.invalid` if `min` or `max` is invalid.
 */
export function isInRange(
  d: Decimal,
  min: MoneyInput,
  max: MoneyInput,
): boolean {
  const mn = parseMoney(min);
  const mx = parseMoney(max);
  return d.gte(mn) && d.lte(mx);
}

/**
 * Inclusive lower bound for any deal amount, mirroring the value defined in
 * `src/common/constants.ts`. Kept here as a `Decimal` for ergonomic use in
 * wallet/deal math.
 *
 * Requirements: R2.1, R3.1, R7.1.
 */
export const MIN_DEAL_AMOUNT: Decimal = parseMoney('0.01');

/**
 * Inclusive upper bound for any deal amount, mirroring the value defined in
 * `src/common/constants.ts`. Kept here as a `Decimal` for ergonomic use in
 * wallet/deal math.
 *
 * Requirements: R2.1, R3.1, R7.1.
 */
export const MAX_DEAL_AMOUNT: Decimal = parseMoney('999999999.99');

/**
 * Validate an input intended to be used as a deal amount: must parse cleanly
 * AND fall within `[MIN_DEAL_AMOUNT, MAX_DEAL_AMOUNT]`.
 *
 * @throws {RangeError} `money.invalid` if the input cannot be parsed.
 * @throws {RangeError} `money.out_of_range` if the parsed value is outside
 *   the allowed deal-amount window.
 *
 * @example
 *   assertValidDealAmount('12.30')     // Decimal('12.30')
 *   assertValidDealAmount('0')         // throws money.out_of_range
 *   assertValidDealAmount('1e12')      // throws money.out_of_range
 *   assertValidDealAmount('1.234')     // throws money.invalid
 */
export function assertValidDealAmount(input: MoneyInput): Decimal {
  const d = parseMoney(input);
  if (!isInRange(d, MIN_DEAL_AMOUNT, MAX_DEAL_AMOUNT)) {
    throw new RangeError('money.out_of_range');
  }
  return d;
}

/**
 * `a == b` (numeric equality after normalising precision). Both operands
 * are validated; trailing zeros do not affect the result, so
 * `eq('12.30', '12.3')` is `true`.
 *
 * @throws {RangeError} `money.invalid` if either input is invalid.
 */
export function eq(a: MoneyInput, b: MoneyInput): boolean {
  return parseMoney(a).eq(parseMoney(b));
}

/**
 * Strictly positive check: `d > 0`. Useful for guarding ledger inserts —
 * `wallet_ledger_entry.amount` carries a `CHECK (amount > 0)` constraint
 * (see `prisma/schema.prisma`, R14.1) and the sign is encoded by
 * `direction` rather than by the value.
 *
 * Accepts a raw `MoneyInput` so callers don't have to pre-parse; values
 * are validated through {@link parseMoney}.
 *
 * @throws {RangeError} `money.invalid` if the input is invalid.
 *
 * @example
 *   isPositive('12.30')   // true
 *   isPositive('0')       // false
 *   isPositive('-1.00')   // false
 */
export function isPositive(value: MoneyInput): boolean {
  return parseMoney(value).gt(0);
}

/**
 * Throws when two operands disagree on currency. Wallet/ledger math
 * (R9.6, R14.1, R15.1) is always currency-scoped: a buyer USD wallet is
 * never debited to credit a seller KHR wallet, and a single ledger entry
 * carries exactly one `currency` value. Call this at the start of any
 * cross-account transfer to fail fast with a typed error code instead of
 * letting a mismatch corrupt downstream state.
 *
 * The error code mirrors `wallet.currency_mismatch` from R9.6 — services
 * catching this should surface that envelope code unchanged.
 *
 * @throws {Error} `wallet.currency_mismatch` if `a !== b`.
 *
 * @example
 *   assertSameCurrency(Currency.USD, Currency.USD); // ok
 *   assertSameCurrency(Currency.USD, Currency.KHR); // throws
 */
export function assertSameCurrency(a: Currency, b: Currency): void {
  if (a !== b) {
    throw new Error('wallet.currency_mismatch');
  }
}
