/**
 * Property-based tests for `computeTermsHash(deal)` (task 5.11).
 *
 * Source of truth: tasks.md §5.11; requirements.md R8.1;
 * `src/deal/deal.terms-hash.ts`.
 *
 * # Properties
 *
 * Per the implementation's R8.1 canonicalisation contract:
 *
 *   1. **Determinism** — `hash(d) === hash(d)` byte-for-byte across
 *      repeated calls, processes, and key-insertion orders.
 *   2. **Amount-precision invariance** — `hash({deal_amount:'12.30'})
 *      === hash({deal_amount:'12.3'})` because `formatMoney(parseMoney(...))`
 *      always emits exactly two fractional digits. This is the ONLY
 *      normalisation applied; it lets clients reformat money fields
 *      without invalidating approvals.
 *   3. **Material-edit sensitivity** — different `product_title`,
 *      `product_description`, `deal_amount`, or `currency` values
 *      produce different hashes.
 *   4. **Verbatim string handling** — whitespace differences in
 *      `product_title` / `product_description` ARE material (R7.3
 *      treats whitespace-only edits as real edits and must force
 *      re-approval). The hash therefore differs.
 *   5. **Key-order independence** — insertion order of properties on
 *      the input object does not change the hash; the canonicaliser
 *      uses a sorted-key replacer.
 *
 * Validates: R8.1.
 */

import * as fc from 'fast-check';

import { Currency } from '../common/enums';
import { computeTermsHash } from './deal.terms-hash';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const titleArb = fc.string({ minLength: 1, maxLength: 60 });
const descriptionArb = fc.oneof(
  fc.constant<string | null>(null),
  fc.string({ minLength: 0, maxLength: 200 }),
);
const currencyArb = fc.constantFrom(Currency.USD, Currency.KHR);

/** Money expressed as "X.YZ" with exactly two fractional digits. */
const canonicalMoneyArb: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: 999_999_999_99 })
  .map((cents) => {
    const dollars = Math.floor(cents / 100);
    const fraction = (cents % 100).toString().padStart(2, '0');
    return `${dollars}.${fraction}`;
  });

/** Same numeric value as canonical, but expressed without trailing zeros. */
function dropTrailingZero(canonical: string): string {
  return canonical.replace(/\.([0-9])0$/, '.$1');
}

interface MaterialFields {
  product_title: string;
  product_description: string | null;
  deal_amount: string;
  currency: Currency;
  // Permissive index signature so MaterialFields satisfies the
  // structural `TermsHashInput` contract (which uses `[extra: string]:
  // unknown` for `DealRoom` rows that carry many other columns).
  [extra: string]: unknown;
}

const materialArb: fc.Arbitrary<MaterialFields> = fc.record({
  product_title: titleArb,
  product_description: descriptionArb,
  deal_amount: canonicalMoneyArb,
  currency: currencyArb,
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('computeTermsHash — property tests (task 5.11)', () => {
  it('is deterministic: hash(d) === hash(d) across repeated calls', () => {
    fc.assert(
      fc.property(materialArb, (deal) => {
        const a = computeTermsHash(deal);
        const b = computeTermsHash({ ...deal });
        expect(a).toBe(b);
        // Sanity: 64-char lowercase hex.
        expect(a).toMatch(/^[0-9a-f]{64}$/);
      }),
      { numRuns: 200 },
    );
  });

  it('is invariant under amount-precision differences (12.3 ≡ 12.30)', () => {
    fc.assert(
      fc.property(materialArb, (deal) => {
        const padded = computeTermsHash(deal);
        const stripped = computeTermsHash({
          ...deal,
          deal_amount: dropTrailingZero(deal.deal_amount),
        });
        expect(padded).toBe(stripped);
      }),
      { numRuns: 200 },
    );
  });

  it('changes when product_title changes (material field)', () => {
    fc.assert(
      fc.property(materialArb, titleArb, (deal, otherTitle) => {
        fc.pre(otherTitle !== deal.product_title);
        const a = computeTermsHash(deal);
        const b = computeTermsHash({ ...deal, product_title: otherTitle });
        expect(a).not.toBe(b);
      }),
      { numRuns: 100 },
    );
  });

  it('changes when deal_amount changes to a different numeric value', () => {
    fc.assert(
      fc.property(materialArb, canonicalMoneyArb, (deal, otherAmount) => {
        // Skip when the new amount happens to equal the original after
        // canonicalisation.
        fc.pre(otherAmount !== deal.deal_amount);
        const a = computeTermsHash(deal);
        const b = computeTermsHash({ ...deal, deal_amount: otherAmount });
        expect(a).not.toBe(b);
      }),
      { numRuns: 100 },
    );
  });

  it('changes when currency flips (USD ↔ KHR)', () => {
    fc.assert(
      fc.property(materialArb, (deal) => {
        const flipped =
          deal.currency === Currency.USD ? Currency.KHR : Currency.USD;
        const a = computeTermsHash(deal);
        const b = computeTermsHash({ ...deal, currency: flipped });
        expect(a).not.toBe(b);
      }),
      { numRuns: 100 },
    );
  });

  it('treats whitespace differences in product_title as material (verbatim hashing)', () => {
    fc.assert(
      fc.property(materialArb, (deal) => {
        const trimmed = deal.product_title;
        const padded = `${trimmed}  `;
        fc.pre(padded !== trimmed);
        const a = computeTermsHash({ ...deal, product_title: trimmed });
        const b = computeTermsHash({ ...deal, product_title: padded });
        expect(a).not.toBe(b);
      }),
      { numRuns: 100 },
    );
  });

  it('is independent of property insertion order on the input object', () => {
    fc.assert(
      fc.property(materialArb, (deal) => {
        const a = computeTermsHash({
          product_title: deal.product_title,
          product_description: deal.product_description,
          deal_amount: deal.deal_amount,
          currency: deal.currency,
        });
        const b = computeTermsHash({
          currency: deal.currency,
          deal_amount: deal.deal_amount,
          product_description: deal.product_description,
          product_title: deal.product_title,
        });
        expect(a).toBe(b);
      }),
      { numRuns: 200 },
    );
  });

  it('ignores extra non-material fields on the input', () => {
    fc.assert(
      fc.property(materialArb, (deal) => {
        const a = computeTermsHash(deal);
        const b = computeTermsHash({
          ...deal,
          // Extra fields should be dropped by the canonicaliser.
          buyer_name: 'Alice',
          seller_name: 'Bob',
          quantity: 7,
          condition: 'used',
        } as never);
        expect(a).toBe(b);
      }),
      { numRuns: 100 },
    );
  });
});
