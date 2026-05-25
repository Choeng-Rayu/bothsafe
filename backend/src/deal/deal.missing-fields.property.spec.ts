/**
 * Property-based tests for `computeMissingFields(deal)` (task 5.10).
 *
 * Source of truth: tasks.md §5.10; requirements.md R6.1, R6.2;
 * `src/deal/deal.missing-fields.ts`.
 *
 * # Property
 *
 * **Missing-field characterisation** — for any synthetic deal `d`, the
 * returned array equals `{ f ∈ DEAL_REQUIRED_FIELDS | empty(d, f) }`,
 * preserving the canonical declaration order.
 *
 * Where `empty(d, f)` is the R6.1 emptiness predicate:
 *   - For string fields (`Product_Title`, `Product_Type`, `Buyer_Name`,
 *     `Seller_Name`): `null`, `undefined`, or `value.trim() === ''`.
 *   - For `Deal_Amount`: `null`, `undefined`, unparseable, OR outside
 *     `[MIN_DEAL_AMOUNT, MAX_DEAL_AMOUNT]`.
 *
 * Validates: R6.1 (required-field set + emptiness rules) and R6.2
 * (`missing_fields` exposed on every deal-room response).
 */

import * as fc from 'fast-check';

import {
  DEAL_REQUIRED_FIELDS,
  type DealRequiredField,
} from '../common/constants';
import {
  MAX_DEAL_AMOUNT,
  MIN_DEAL_AMOUNT,
  parseMoney,
} from '../common/money';
import {
  computeMissingFields,
  type DealMissingFieldsInput,
} from './deal.missing-fields';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Strings that count as "empty" per R6.1: `null`, `undefined`, the empty
 * string, and whitespace-only strings.
 */
const emptyStringArb: fc.Arbitrary<string | null | undefined> = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(''),
  fc.constantFrom(' ', '   ', '\t', '\n', ' \t \n '),
);

/** Strings that count as "non-empty" — at least one non-whitespace char. */
const nonEmptyStringArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => s.trim().length > 0);

/** Money values that count as "empty" per R6.1 (out-of-range or unparseable). */
const emptyMoneyArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(''),
  fc.constant('   '),
  fc.constant('banana'),
  fc.constant('NaN'),
  fc.constant('0'), // below MIN_DEAL_AMOUNT
  fc.constant('-1.00'), // below MIN_DEAL_AMOUNT
  fc.constant('1000000000.00'), // above MAX_DEAL_AMOUNT
);

/** Money values that count as "valid" — in the legal range with ≤2dp. */
const validMoneyArb: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: 999_999_999_99 }) // cents
  .map((cents) => {
    const dollars = Math.floor(cents / 100);
    const fraction = (cents % 100).toString().padStart(2, '0');
    return `${dollars}.${fraction}`;
  });

interface SyntheticDeal {
  product_title?: string | null;
  product_type?: string | null;
  deal_amount?: unknown;
  buyer_name?: string | null;
  seller_name?: string | null;
}

const syntheticDealArb: fc.Arbitrary<SyntheticDeal> = fc.record(
  {
    product_title: fc.oneof(emptyStringArb, nonEmptyStringArb),
    product_type: fc.oneof(emptyStringArb, nonEmptyStringArb),
    deal_amount: fc.oneof(emptyMoneyArb, validMoneyArb),
    buyer_name: fc.oneof(emptyStringArb, nonEmptyStringArb),
    seller_name: fc.oneof(emptyStringArb, nonEmptyStringArb),
  },
  { requiredKeys: [] },
);

// ---------------------------------------------------------------------------
// Reference implementation (oracle)
// ---------------------------------------------------------------------------

function isStringEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return true;
  return value.trim().length === 0;
}

function isMoneyEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  try {
    const parsed = parseMoney(value as never);
    if (parsed.lt(MIN_DEAL_AMOUNT) || parsed.gt(MAX_DEAL_AMOUNT)) return true;
    return false;
  } catch {
    return true;
  }
}

function expectedMissing(deal: SyntheticDeal): readonly DealRequiredField[] {
  const missing: DealRequiredField[] = [];
  for (const f of DEAL_REQUIRED_FIELDS) {
    let isEmpty: boolean;
    switch (f) {
      case 'Product_Title':
        isEmpty = isStringEmpty(deal.product_title);
        break;
      case 'Product_Type':
        isEmpty = isStringEmpty(deal.product_type);
        break;
      case 'Deal_Amount':
        isEmpty = isMoneyEmpty(deal.deal_amount);
        break;
      case 'Buyer_Name':
        isEmpty = isStringEmpty(deal.buyer_name);
        break;
      case 'Seller_Name':
        isEmpty = isStringEmpty(deal.seller_name);
        break;
    }
    if (isEmpty) missing.push(f);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('computeMissingFields — property tests (task 5.10)', () => {
  it('returns exactly { f ∈ DEAL_REQUIRED_FIELDS | empty(deal, f) }, preserving canonical order', () => {
    fc.assert(
      fc.property(syntheticDealArb, (deal) => {
        const actual = computeMissingFields(deal as DealMissingFieldsInput);
        const expected = expectedMissing(deal);
        expect([...actual]).toEqual([...expected]);
      }),
      { numRuns: 200 },
    );
  });

  it('preserves canonical declaration order for any subset', () => {
    fc.assert(
      fc.property(syntheticDealArb, (deal) => {
        const actual = computeMissingFields(deal as DealMissingFieldsInput);
        // Each consecutive pair must agree with DEAL_REQUIRED_FIELDS order.
        for (let i = 1; i < actual.length; i++) {
          const prevIdx = DEAL_REQUIRED_FIELDS.indexOf(actual[i - 1]);
          const currIdx = DEAL_REQUIRED_FIELDS.indexOf(actual[i]);
          expect(prevIdx).toBeLessThan(currIdx);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('returns the empty array iff no required field is empty', () => {
    fc.assert(
      fc.property(
        fc.record({
          product_title: nonEmptyStringArb,
          product_type: nonEmptyStringArb,
          deal_amount: validMoneyArb,
          buyer_name: nonEmptyStringArb,
          seller_name: nonEmptyStringArb,
        }),
        (deal) => {
          const actual = computeMissingFields(deal as DealMissingFieldsInput);
          expect([...actual]).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns all required fields when every field is empty', () => {
    fc.assert(
      fc.property(
        fc.record({
          product_title: emptyStringArb,
          product_type: emptyStringArb,
          deal_amount: emptyMoneyArb,
          buyer_name: emptyStringArb,
          seller_name: emptyStringArb,
        }),
        (deal) => {
          const actual = computeMissingFields(deal as DealMissingFieldsInput);
          expect([...actual]).toEqual([...DEAL_REQUIRED_FIELDS]);
        },
      ),
      { numRuns: 50 },
    );
  });
});
