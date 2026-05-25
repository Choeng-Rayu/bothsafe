/**
 * Unit tests for `src/common/money.ts`.
 *
 * Coverage targets the pure helper surface used by Wallet, Deal, Payment,
 * Withdrawal, and KHQR services (task 3.3): parse/format round-trip,
 * comparison wrappers, arithmetic preservation of precision, deal-amount
 * range validation, and the cross-account currency guard.
 *
 * Property-based checks for these helpers live in task 3.11; this file
 * exercises the explicit examples and edge cases.
 */

import Decimal from 'decimal.js';
import { Currency } from './enums';
import {
  parseMoney,
  formatMoney,
  gte,
  lt,
  eq,
  plus,
  minus,
  add,
  sub,
  toDecimal,
  quantize,
  isPositive,
  isInRange,
  assertSameCurrency,
  assertValidDealAmount,
  MIN_DEAL_AMOUNT,
  MAX_DEAL_AMOUNT,
} from './money';

describe('parseMoney / formatMoney', () => {
  it('parses two-decimal strings exactly', () => {
    expect(parseMoney('12.30').toFixed(2)).toBe('12.30');
    expect(parseMoney('0.01').toFixed(2)).toBe('0.01');
    expect(parseMoney('999999999.99').toFixed(2)).toBe('999999999.99');
  });

  it('parses finite numbers', () => {
    expect(parseMoney(0.01).toFixed(2)).toBe('0.01');
    expect(parseMoney(12.3).toFixed(2)).toBe('12.30');
  });

  it('formats with two-decimal padding', () => {
    expect(formatMoney(new Decimal('12.3'))).toBe('12.30');
    expect(formatMoney(new Decimal('0'))).toBe('0.00');
    expect(formatMoney(new Decimal('0.01'))).toBe('0.01');
  });

  it('rejects more than two decimal places', () => {
    expect(() => parseMoney('1.234')).toThrow('money.invalid');
    expect(() => parseMoney('0.001')).toThrow('money.invalid');
  });

  it('rejects empty / whitespace strings', () => {
    expect(() => parseMoney('')).toThrow('money.invalid');
    expect(() => parseMoney('   ')).toThrow('money.invalid');
  });

  it('rejects non-finite numbers', () => {
    expect(() => parseMoney(Number.NaN)).toThrow('money.invalid');
    expect(() => parseMoney(Number.POSITIVE_INFINITY)).toThrow('money.invalid');
    expect(() => parseMoney(Number.NEGATIVE_INFINITY)).toThrow('money.invalid');
  });

  it('rejects null / undefined', () => {
    expect(() => parseMoney(null as unknown as string)).toThrow('money.invalid');
    expect(() => parseMoney(undefined as unknown as string)).toThrow('money.invalid');
  });

  it('round-trips through format then parse', () => {
    for (const v of ['0.01', '12.30', '100.00', '999999999.99']) {
      expect(formatMoney(parseMoney(v))).toBe(v);
    }
  });
});

describe('comparison helpers', () => {
  it('gte / lt agree with Decimal semantics', () => {
    expect(gte('12.30', '12.30')).toBe(true);
    expect(gte('12.31', '12.30')).toBe(true);
    expect(gte('12.29', '12.30')).toBe(false);
    expect(lt('12.29', '12.30')).toBe(true);
    expect(lt('12.30', '12.30')).toBe(false);
  });

  it('eq treats trailing-zero forms as equal', () => {
    expect(eq('12.30', '12.3')).toBe(true);
    expect(eq('0.10', '0.1')).toBe(true);
    expect(eq('0.10', '0.11')).toBe(false);
  });
});

describe('arithmetic', () => {
  it('plus and minus preserve two-decimal precision', () => {
    expect(formatMoney(plus('12.30', '0.50'))).toBe('12.80');
    expect(formatMoney(minus('12.30', '0.50'))).toBe('11.80');
    expect(formatMoney(plus('0.10', '0.20'))).toBe('0.30');
  });

  it('add / sub aliases mirror plus / minus', () => {
    expect(formatMoney(add('12.30', '0.50'))).toBe('12.80');
    expect(formatMoney(sub('12.30', '0.50'))).toBe('11.80');
  });

  it('toDecimal alias mirrors parseMoney', () => {
    expect(toDecimal('12.30').toFixed(2)).toBe('12.30');
    expect(() => toDecimal('1.234')).toThrow('money.invalid');
  });

  it('isPositive only accepts strictly positive values', () => {
    expect(isPositive('0.01')).toBe(true);
    expect(isPositive('999999999.99')).toBe(true);
    expect(isPositive('0')).toBe(false);
    expect(isPositive('0.00')).toBe(false);
    expect(isPositive('-0.01')).toBe(false);
  });
});

describe('quantize', () => {
  it('rounds intermediate values to 2dp using ROUND_HALF_UP', () => {
    expect(quantize('12.305', Currency.USD).toFixed(2)).toBe('12.31');
    expect(quantize('12.304', Currency.USD).toFixed(2)).toBe('12.30');
    expect(quantize('0.001', Currency.KHR).toFixed(2)).toBe('0.00');
  });

  it('passes through values that are already 2dp', () => {
    expect(quantize('12.30', Currency.USD).toFixed(2)).toBe('12.30');
    expect(quantize('999999999.99', Currency.KHR).toFixed(2)).toBe('999999999.99');
  });

  it('quantises Decimal results carrying extra precision', () => {
    const raw = new Decimal('1').div(new Decimal('3')); // 0.333...
    expect(quantize(raw, Currency.USD).toFixed(2)).toBe('0.33');
  });

  it('rejects non-finite / empty inputs', () => {
    expect(() => quantize('', Currency.USD)).toThrow('money.invalid');
    expect(() => quantize('   ', Currency.USD)).toThrow('money.invalid');
    expect(() => quantize(Number.NaN, Currency.USD)).toThrow('money.invalid');
    expect(() => quantize(Number.POSITIVE_INFINITY, Currency.KHR)).toThrow('money.invalid');
  });
});

describe('deal-amount range', () => {
  it('isInRange respects inclusive bounds', () => {
    expect(isInRange(parseMoney('0.01'), MIN_DEAL_AMOUNT, MAX_DEAL_AMOUNT)).toBe(true);
    expect(isInRange(parseMoney('999999999.99'), MIN_DEAL_AMOUNT, MAX_DEAL_AMOUNT)).toBe(true);
    expect(isInRange(parseMoney('12.30'), MIN_DEAL_AMOUNT, MAX_DEAL_AMOUNT)).toBe(true);
  });

  it('assertValidDealAmount accepts values within R2.1 / R3.1 bounds', () => {
    expect(formatMoney(assertValidDealAmount('0.01'))).toBe('0.01');
    expect(formatMoney(assertValidDealAmount('999999999.99'))).toBe('999999999.99');
  });

  it('assertValidDealAmount rejects out-of-range values', () => {
    expect(() => assertValidDealAmount('0')).toThrow('money.out_of_range');
    expect(() => assertValidDealAmount('0.00')).toThrow('money.out_of_range');
    expect(() => assertValidDealAmount('1000000000.00')).toThrow('money.out_of_range');
    expect(() => assertValidDealAmount('-1.00')).toThrow('money.out_of_range');
  });

  it('assertValidDealAmount rejects higher-precision input before range check', () => {
    expect(() => assertValidDealAmount('1.234')).toThrow('money.invalid');
  });
});

describe('assertSameCurrency', () => {
  it('passes when both currencies match', () => {
    expect(() => assertSameCurrency(Currency.USD, Currency.USD)).not.toThrow();
    expect(() => assertSameCurrency(Currency.KHR, Currency.KHR)).not.toThrow();
  });

  it('throws wallet.currency_mismatch when currencies differ (R9.6)', () => {
    expect(() => assertSameCurrency(Currency.USD, Currency.KHR)).toThrow(
      'wallet.currency_mismatch',
    );
    expect(() => assertSameCurrency(Currency.KHR, Currency.USD)).toThrow(
      'wallet.currency_mismatch',
    );
  });
});
