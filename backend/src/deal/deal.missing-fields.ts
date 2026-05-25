/**
 * Pure `computeMissingFields(deal)` — the missing-required-field calculator
 * that backs `DealService.computeMissingFields` (task 5.4).
 *
 * Why a standalone module?
 *   The function has no I/O, no DB calls, no NestJS decorators, and no
 *   service dependencies — it's a pure projection of a `DealRoom` row onto
 *   the canonical "missing" set. Keeping it outside the service class makes
 *   it trivially unit-testable (see `deal.missing-fields.spec.ts`) and lets
 *   `DealService.computeMissingFields(deal)` collapse to a one-line
 *   delegate.
 *
 * Source of truth:
 *   - `requirements.md` R6.1 — defines the required-field set
 *     (Product_Title, Product_Type, Deal_Amount, Buyer_Name, Seller_Name)
 *     and the "empty" predicate (null / absent / whitespace-only; for
 *     Deal_Amount, additionally any value outside [0.01, 999_999_999.99]).
 *   - `requirements.md` R6.5 — the missing-field array drives the
 *     `READY_FOR_PAYMENT → AWAITING_BOTH_APPROVAL` revert path.
 *   - `src/common/constants.ts` `DEAL_REQUIRED_FIELDS` — the canonical
 *     ordered list. The returned array preserves this order.
 *
 * Naming convention:
 *   The Prisma row stores snake_case columns (`product_title`,
 *   `product_type`, `deal_amount`, `buyer_name`, `seller_name`) but the
 *   API response and the constants file use canonical CamelCase
 *   (`'Product_Title'`, `'Product_Type'`, `'Deal_Amount'`, `'Buyer_Name'`,
 *   `'Seller_Name'`). This function is the boundary that translates one to
 *   the other.
 */

import {
  DEAL_REQUIRED_FIELDS,
  type DealRequiredField,
} from '../common/constants';
import {
  isInRange,
  MAX_DEAL_AMOUNT,
  MIN_DEAL_AMOUNT,
  parseMoney,
  type MoneyInput,
} from '../common/money';

/**
 * Minimal structural shape this function depends on. Accepts the Prisma
 * `DealRoom` row directly (its `deal_amount` is `Prisma.Decimal | null`,
 * which is a valid `MoneyInput`), as well as any object that exposes the
 * same five snake_case fields. Other columns on `DealRoom` are ignored.
 *
 * Buyer/seller names are denormalised onto `DealRoom` itself (see
 * `prisma/schema.prisma` → `model DealRoom`), so this function does not
 * need eager-loaded participants — `buyer_name` / `seller_name` are read
 * straight off the deal row.
 */
export interface DealMissingFieldsInput {
  product_title?: string | null;
  product_type?: string | null;
  /**
   * Two-decimal monetary value. Anything `parseMoney` accepts — `string`,
   * `number`, `Prisma.Decimal`, `Decimal` — is fine. `null` / `undefined`
   * count as missing (R6.1).
   */
  deal_amount?: MoneyInput | null;
  buyer_name?: string | null;
  seller_name?: string | null;
}

/**
 * Returns the subset of `DEAL_REQUIRED_FIELDS` that is currently empty on
 * the supplied deal, preserving the canonical declaration order.
 *
 * Emptiness rules (R6.1):
 *   - `null` / `undefined` → missing.
 *   - String fields: also missing when `value.trim() === ''`.
 *   - `Deal_Amount`: also missing when the value is unparseable
 *     (e.g. `'banana'`, `NaN`) OR falls outside
 *     `[MIN_DEAL_AMOUNT, MAX_DEAL_AMOUNT]` per `isInRange` (e.g. `'0'`,
 *     `'1000000000.00'`). Precision is NOT enforced here — over-precise
 *     values like `'1.234'` are caught by `assertValidDealAmount` at
 *     create/patch time and never reach this calculator.
 *
 * Returns an empty array when every required field is present.
 *
 * @example
 *   computeMissingFields({})
 *   // ['Product_Title', 'Product_Type', 'Deal_Amount', 'Buyer_Name', 'Seller_Name']
 *
 *   computeMissingFields({
 *     product_title: 'Hat',
 *     product_type: 'Apparel',
 *     deal_amount: '12.30',
 *     buyer_name: 'Alice',
 *     seller_name: 'Bob',
 *   })
 *   // []
 */
export function computeMissingFields(
  deal: DealMissingFieldsInput,
): readonly DealRequiredField[] {
  const missing: DealRequiredField[] = [];

  for (const field of DEAL_REQUIRED_FIELDS) {
    if (isFieldMissing(deal, field)) {
      missing.push(field);
    }
  }

  return missing;
}

/** Per-field empty check. Switch is exhaustive over `DealRequiredField`. */
function isFieldMissing(
  deal: DealMissingFieldsInput,
  field: DealRequiredField,
): boolean {
  switch (field) {
    case 'Product_Title':
      return isBlankString(deal.product_title);
    case 'Product_Type':
      return isBlankString(deal.product_type);
    case 'Deal_Amount':
      return isInvalidOrMissingAmount(deal.deal_amount);
    case 'Buyer_Name':
      return isBlankString(deal.buyer_name);
    case 'Seller_Name':
      return isBlankString(deal.seller_name);
  }
}

/**
 * `null`, `undefined`, non-string, or whitespace-only → missing. Mirrors
 * the R6.1 definition of "empty" for string-typed required fields.
 */
function isBlankString(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return true;
  return value.trim() === '';
}

/**
 * `null`/`undefined` or any value that fails to parse / falls outside
 * `[MIN_DEAL_AMOUNT, MAX_DEAL_AMOUNT]` → missing. Wraps `parseMoney` in
 * `try`/`catch` because R6.1 treats out-of-range or un-parseable amounts
 * as empty rather than as a hard error at this layer; the dedicated
 * validation error (`deal.invalid_field`) is raised earlier in the
 * create / patch path via `assertValidDealAmount`.
 *
 * Uses `isInRange` (the shared bounds helper from `money.ts`) instead of
 * `assertValidDealAmount` so we accept any 2dp Decimal in range — even
 * a hypothetical over-precision value that slipped past create-time
 * validation, since precision is enforced upstream and re-rejecting it
 * here would surface as the wrong error code on the response.
 */
function isInvalidOrMissingAmount(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  try {
    const parsed = parseMoney(value as MoneyInput);
    return !isInRange(parsed, MIN_DEAL_AMOUNT, MAX_DEAL_AMOUNT);
  } catch {
    // Un-parseable: NaN, 'banana', '', non-numeric strings, ...
    return true;
  }
}
