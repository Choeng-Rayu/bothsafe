/**
 * `computeTermsHash` — canonical fingerprint of the material content that
 * both participants approve (R8.1).
 *
 * The hash is the anchor of the approval state machine:
 *
 *   - Each `Approval` row snapshots `deal.terms_hash` at the moment the
 *     participant approved (R8.1).
 *   - When any **material edit field** changes
 *     (`DEAL_MATERIAL_EDIT_FIELDS` in `src/common/constants.ts`:
 *     `product_title`, `product_description`, `deal_amount`, `currency`)
 *     the deal is recomputed and prior approvals become stale, so the
 *     "active approvals" predicate
 *     `invalidated_at IS NULL AND terms_hash = deal.terms_hash`
 *     flips to `false` (R7.3, R8.4).
 *   - `READY_FOR_PAYMENT` is gated on both participants holding an active
 *     approval (R8.3). Because that comparison is byte-for-byte equality
 *     of two hashes, the function below MUST be deterministic and
 *     stable across processes, deploys, and Postgres roundtrips.
 *
 * ## Canonicalisation rules
 *
 * The hash input is built from **only** the four fields in
 * `DEAL_MATERIAL_EDIT_FIELDS`. Anything outside that set (Product_Type,
 * Quantity, Condition, Buyer_Name, Seller_Name, ...) is intentionally
 * excluded — those edits are NOT material and MUST NOT invalidate
 * approvals (R7.4).
 *
 * The canonical string is built as follows:
 *
 *   1. **Field set.** Exactly the four keys from
 *      `DEAL_MATERIAL_EDIT_FIELDS`. Missing/`undefined` fields are
 *      coerced to `null` so a deal that has never set a description
 *      hashes the same as a deal that explicitly stored `null`.
 *   2. **Money normalisation.** `deal_amount` is run through
 *      `formatMoney(parseMoney(...))`, producing the **exact 2dp money
 *      string** (`"12.30"`, never `"12.3"` or `"12.300"`). This is the
 *      ONLY field that gets normalised — it lets us treat the same
 *      number in different lexical forms as equivalent for the purposes
 *      of approval (otherwise reformatting a price field on the client
 *      would silently invalidate approvals).
 *   3. **No string normalisation.** `product_title` and
 *      `product_description` are hashed verbatim — no trim, no
 *      whitespace collapse, no case folding. This is deliberate: a
 *      whitespace-only edit (e.g. "Phone " vs "Phone") IS a material
 *      edit by R7.3, so we want it to flip the hash and force
 *      re-approval. Normalising here would cause false negatives in the
 *      "material edit reverts approval" check.
 *   4. **Alphabetical key order.** Keys are emitted in the same
 *      alphabetical order on every call by passing a sorted key list as
 *      `JSON.stringify`'s replacer-array, so two equivalent objects
 *      produce identical bytes regardless of property insertion order.
 *   5. **No whitespace.** `JSON.stringify(obj, sortedKeys)` is called
 *      without a `space` argument, so the serialised form contains no
 *      indentation, line breaks, or padding.
 *   6. **SHA-256, lowercase hex.** UTF-8 bytes of the canonical string
 *      are fed to `createHash('sha256')` and the digest is returned as
 *      a 64-character lowercase hex string.
 *
 * Future material-edit checks rely on byte-for-byte equality of the
 * resulting hex string. Do not change the canonicalisation rules above
 * without a coordinated migration of every persisted `Approval.terms_hash`
 * and `DealRoom.terms_hash` value.
 *
 * @example
 *   computeTermsHash({
 *     product_title: 'Phone',
 *     product_description: 'red',
 *     deal_amount: '12.3',     // normalised to "12.30"
 *     currency: Currency.USD,
 *   });
 *   // 'a1b2c3...'   (64 lowercase hex chars)
 *
 * Requirements: R8.1.
 */

import { createHash } from 'node:crypto';
import {
  DEAL_MATERIAL_EDIT_FIELDS,
  type DealMaterialEditField,
} from '../common/constants';
import { formatMoney, parseMoney, type MoneyInput } from '../common/money';
import type { Currency } from '../common/enums';

/**
 * Minimal structural shape `computeTermsHash` needs from a deal. Defined
 * structurally (rather than importing the Prisma `DealRoom` type) so this
 * module stays a pure dependency of the domain layer and can be called
 * from tests, services, and bot handlers without coupling to the
 * Prisma client.
 *
 * Extra fields on the input are ignored — only the four
 * `DEAL_MATERIAL_EDIT_FIELDS` participate in the hash.
 */
export interface TermsHashInput {
  product_title?: string | null;
  product_description?: string | null;
  deal_amount?: MoneyInput | null;
  currency?: Currency | null;
  // Intentionally permissive: callers commonly pass a full `DealRoom`
  // row, which carries many other fields. Extra keys are dropped during
  // canonicalisation.
  [extra: string]: unknown;
}

/**
 * Canonical, deterministic SHA-256 of a deal's material-edit fields.
 *
 * See module-level JSDoc for the exact canonicalisation rules. The
 * returned string is always 64 characters of lowercase hex.
 *
 * @throws {RangeError} `money.invalid` if `deal_amount` is non-null but
 *   cannot be parsed as a 2dp money value (propagated from `parseMoney`).
 */
export function computeTermsHash(deal: TermsHashInput): string {
  // 1. Build a canonical object containing exactly the material-edit
  //    fields, with any missing/undefined value coerced to `null`.
  const dealAmount =
    deal.deal_amount === null || deal.deal_amount === undefined
      ? null
      : formatMoney(parseMoney(deal.deal_amount));

  const canonical: Record<DealMaterialEditField, string | null> = {
    product_title: deal.product_title ?? null,
    product_description: deal.product_description ?? null,
    deal_amount: dealAmount,
    currency: deal.currency ?? null,
  };

  // 2. Stable, alphabetical key order. `JSON.stringify(obj, replacerArray)`
  //    only emits keys that appear in `replacerArray`, in the order they
  //    appear there — so a sorted copy of the field list gives us both
  //    deterministic order AND a hard whitelist of fields included in
  //    the hash. No `space` argument => no whitespace in the output.
  const sortedKeys = [...DEAL_MATERIAL_EDIT_FIELDS].sort();
  const json = JSON.stringify(canonical, sortedKeys);

  // 3. SHA-256 the UTF-8 bytes; return lowercase hex.
  return createHash('sha256').update(json, 'utf8').digest('hex');
}
