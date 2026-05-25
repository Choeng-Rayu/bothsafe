/**
 * Unit tests for `computeTermsHash` (task 5.3).
 *
 * Canonicalisation contract under test (see `deal.terms-hash.ts` JSDoc):
 *
 *   - Same input → same hash (determinism).
 *   - Different `product_title` → different hash.
 *   - `deal_amount` "12.30" vs "12.3" → SAME hash (money normalisation).
 *   - Different `currency` → different hash.
 *   - Whitespace-only difference in title → DIFFERENT hash (titles are
 *     NOT normalised, so the "material edit reverts approval" check
 *     in R7.3 cannot get false negatives).
 *
 * Property-based exercise of the same contract lives in task 5.11.
 */

import { Currency } from '../common/enums';
import { computeTermsHash } from './deal.terms-hash';

const baseDeal = {
  product_title: 'Pixel 8 Pro',
  product_description: 'Lightly used, original box.',
  deal_amount: '120.00',
  currency: Currency.USD,
};

describe('computeTermsHash', () => {
  it('returns a 64-character lowercase hex string', () => {
    const hash = computeTermsHash(baseDeal);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same hash for the same input', () => {
    expect(computeTermsHash(baseDeal)).toBe(computeTermsHash(baseDeal));
  });

  it('is insensitive to extra fields outside the material-edit set', () => {
    // Quantity, condition, buyer/seller names are explicitly NOT material
    // (R7.4) and must not affect the hash.
    const withExtras = {
      ...baseDeal,
      quantity: 1,
      condition: 'new',
      buyer_name: 'Alice',
      seller_name: 'Bob',
      product_type: 'phone',
    };
    expect(computeTermsHash(withExtras)).toBe(computeTermsHash(baseDeal));
  });

  it('returns a different hash when product_title changes', () => {
    const edited = { ...baseDeal, product_title: 'Pixel 8' };
    expect(computeTermsHash(edited)).not.toBe(computeTermsHash(baseDeal));
  });

  it('returns the same hash for "12.30" vs "12.3" (money normalisation)', () => {
    const padded = { ...baseDeal, deal_amount: '12.30' };
    const trimmed = { ...baseDeal, deal_amount: '12.3' };
    expect(computeTermsHash(padded)).toBe(computeTermsHash(trimmed));
  });

  it('returns the same hash for numeric vs string money inputs', () => {
    const asString = { ...baseDeal, deal_amount: '99.99' };
    const asNumber = { ...baseDeal, deal_amount: 99.99 };
    expect(computeTermsHash(asString)).toBe(computeTermsHash(asNumber));
  });

  it('returns a different hash when currency changes', () => {
    const khr = { ...baseDeal, currency: Currency.KHR };
    expect(computeTermsHash(khr)).not.toBe(computeTermsHash(baseDeal));
  });

  it('returns a different hash when product_title differs only in whitespace', () => {
    // Titles are NOT normalised: a trailing-space edit IS a material edit
    // (R7.3) and MUST flip the hash. Otherwise reverting an approval by
    // editing whitespace would silently fail.
    const trailing = { ...baseDeal, product_title: 'Pixel 8 Pro ' };
    const internal = { ...baseDeal, product_title: 'Pixel  8 Pro' };
    expect(computeTermsHash(trailing)).not.toBe(computeTermsHash(baseDeal));
    expect(computeTermsHash(internal)).not.toBe(computeTermsHash(baseDeal));
    expect(computeTermsHash(trailing)).not.toBe(computeTermsHash(internal));
  });

  it('returns a different hash when product_description differs only in whitespace', () => {
    const padded = {
      ...baseDeal,
      product_description: 'Lightly used, original box. ',
    };
    expect(computeTermsHash(padded)).not.toBe(computeTermsHash(baseDeal));
  });

  it('returns the same hash regardless of object property insertion order', () => {
    // Keys are emitted alphabetically, so author-side property order
    // must not affect the result.
    const reordered = {
      currency: baseDeal.currency,
      deal_amount: baseDeal.deal_amount,
      product_description: baseDeal.product_description,
      product_title: baseDeal.product_title,
    };
    expect(computeTermsHash(reordered)).toBe(computeTermsHash(baseDeal));
  });

  it('treats missing fields as null and is stable across undefined / null / absent', () => {
    const missing = { product_title: 'x', deal_amount: '1.00' };
    const explicitNull = {
      product_title: 'x',
      product_description: null,
      deal_amount: '1.00',
      currency: null,
    };
    const explicitUndef = {
      product_title: 'x',
      product_description: undefined,
      deal_amount: '1.00',
      currency: undefined,
    };
    expect(computeTermsHash(missing)).toBe(computeTermsHash(explicitNull));
    expect(computeTermsHash(missing)).toBe(computeTermsHash(explicitUndef));
  });

  it('treats absent deal_amount as null (no money parse attempted)', () => {
    const noAmount = {
      product_title: 'x',
      product_description: 'y',
      currency: Currency.USD,
    };
    // Should not throw, and should differ from a deal with a real amount.
    expect(() => computeTermsHash(noAmount)).not.toThrow();
    const withAmount = { ...noAmount, deal_amount: '0.01' };
    expect(computeTermsHash(noAmount)).not.toBe(computeTermsHash(withAmount));
  });

  it('propagates RangeError for an invalid deal_amount', () => {
    expect(() =>
      computeTermsHash({ ...baseDeal, deal_amount: 'not-a-number' }),
    ).toThrow('money.invalid');
    expect(() =>
      computeTermsHash({ ...baseDeal, deal_amount: '1.234' }),
    ).toThrow('money.invalid');
  });
});
