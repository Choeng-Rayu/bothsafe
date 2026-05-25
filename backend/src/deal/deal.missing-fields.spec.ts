/**
 * Unit tests for the pure `computeMissingFields(deal)` calculator
 * (task 5.4). The function is the substrate behind `DealService.
 * computeMissingFields`; its semantics are pinned by R6.1 / R6.5.
 *
 * Property-based coverage of the same function lives separately in
 * task 5.10 (`computeMissingFields` correctness property).
 */

import { computeMissingFields } from './deal.missing-fields';
import { DEAL_REQUIRED_FIELDS } from '../common/constants';

describe('computeMissingFields', () => {
  // ---------------------------------------------------------------------------
  // Empty / fully-populated deals — exercises ordering and the all-present case.
  // ---------------------------------------------------------------------------

  it('returns all 5 required fields in canonical order for an empty deal', () => {
    expect(computeMissingFields({})).toEqual([
      'Product_Title',
      'Product_Type',
      'Deal_Amount',
      'Buyer_Name',
      'Seller_Name',
    ]);
  });

  it('returns the canonical order from DEAL_REQUIRED_FIELDS', () => {
    // Pin the contract: the function output order must match the constant.
    expect(computeMissingFields({})).toEqual([...DEAL_REQUIRED_FIELDS]);
  });

  it('returns [] when every required field is present', () => {
    expect(
      computeMissingFields({
        product_title: 'Vintage Hat',
        product_type: 'Apparel',
        deal_amount: '12.30',
        buyer_name: 'Alice',
        seller_name: 'Bob',
      }),
    ).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // String-field emptiness rules (R6.1).
  // ---------------------------------------------------------------------------

  it('treats whitespace-only product_title as missing', () => {
    const result = computeMissingFields({
      product_title: '   \t\n ',
      product_type: 'Apparel',
      deal_amount: '12.30',
      buyer_name: 'Alice',
      seller_name: 'Bob',
    });
    expect(result).toEqual(['Product_Title']);
  });

  it('treats a trimmed product_title as present (whitespace-only is missing, but content surrounded by whitespace is not)', () => {
    // Whitespace-only is missing, but a value that has content after
    // trimming is NOT missing — `computeMissingFields` does not reject
    // surrounding whitespace, it only rejects fully blank strings.
    const result = computeMissingFields({
      product_title: 'Vintage Hat',
      product_type: 'Apparel',
      deal_amount: '12.30',
      buyer_name: 'Alice',
      seller_name: 'Bob',
    });
    expect(result).toEqual([]);
  });

  it('treats null and undefined string fields as missing', () => {
    const result = computeMissingFields({
      product_title: null,
      product_type: undefined,
      deal_amount: '12.30',
      buyer_name: 'Alice',
      seller_name: 'Bob',
    });
    expect(result).toEqual(['Product_Title', 'Product_Type']);
  });

  // ---------------------------------------------------------------------------
  // Deal_Amount range / precision rules (R6.1, second clause).
  // ---------------------------------------------------------------------------

  it('treats deal_amount = "0" as missing (out of [0.01, 999_999_999.99])', () => {
    const result = computeMissingFields({
      product_title: 'Hat',
      product_type: 'Apparel',
      deal_amount: '0',
      buyer_name: 'Alice',
      seller_name: 'Bob',
    });
    expect(result).toEqual(['Deal_Amount']);
  });

  it('treats deal_amount = 0 (numeric) as missing (out of range)', () => {
    // Same constraint applied to a numeric input — R6.1 talks about the
    // value, not the lexical form.
    const result = computeMissingFields({
      product_title: 'Hat',
      product_type: 'Apparel',
      deal_amount: 0,
      buyer_name: 'Alice',
      seller_name: 'Bob',
    });
    expect(result).toEqual(['Deal_Amount']);
  });

  it('accepts deal_amount = "0.01" as present (lower bound, inclusive)', () => {
    const result = computeMissingFields({
      product_title: 'Hat',
      product_type: 'Apparel',
      deal_amount: '0.01',
      buyer_name: 'Alice',
      seller_name: 'Bob',
    });
    expect(result).toEqual([]);
  });

  it('accepts deal_amount = "12.30" as present', () => {
    const result = computeMissingFields({
      product_title: 'Hat',
      product_type: 'Apparel',
      deal_amount: '12.30',
      buyer_name: 'Alice',
      seller_name: 'Bob',
    });
    expect(result).toEqual([]);
  });

  it('treats deal_amount = "banana" as missing (un-parseable)', () => {
    // R6.1 amendment: any value `parseMoney` cannot convert to a
    // Decimal counts as missing. The dedicated `deal.invalid_field`
    // error is raised earlier at create/patch time via
    // `assertValidDealAmount`.
    const result = computeMissingFields({
      product_title: 'Hat',
      product_type: 'Apparel',
      deal_amount: 'banana',
      buyer_name: 'Alice',
      seller_name: 'Bob',
    });
    expect(result).toEqual(['Deal_Amount']);
  });

  it('treats deal_amount = NaN as missing', () => {
    const result = computeMissingFields({
      product_title: 'Hat',
      product_type: 'Apparel',
      deal_amount: Number.NaN,
      buyer_name: 'Alice',
      seller_name: 'Bob',
    });
    expect(result).toEqual(['Deal_Amount']);
  });

  // ---------------------------------------------------------------------------
  // Buyer/Seller participant emptiness — denormalised columns on DealRoom.
  // ---------------------------------------------------------------------------

  it('returns only Seller_Name when buyer is present but seller is missing', () => {
    const result = computeMissingFields({
      product_title: 'Hat',
      product_type: 'Apparel',
      deal_amount: '12.30',
      buyer_name: 'Alice',
      seller_name: null,
    });
    expect(result).toEqual(['Seller_Name']);
  });
});
