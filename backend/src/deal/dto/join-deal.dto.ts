/**
 * `JoinDealDto` — request body for `POST /v1/deals/:publicId/join`
 * (task 5.8).
 *
 * Source of truth: tasks.md §5.8; design §"DealService → join";
 * R5.1, R5.2, R5.3, R5.4, R5.5, R5.10.
 *
 * # Wire shape
 *
 * The body looks like:
 *
 * ```json
 * {
 *   "invite": "raw cuid v2 token from ?invite=...",
 *   "buyer_name": "Alice",          // when joining as buyer
 *   "seller_name": "Bob",           // when joining as seller
 *   "phone": "+855 12 345 678"      // optional
 * }
 * ```
 *
 * The role-specific name is required by the controller AFTER the
 * invite has been consumed (because we need `expected_role` to know
 * which one applies). At the DTO layer both name fields are optional;
 * the controller validates the role-appropriate one and rejects with
 * `join.invalid_field` (R5.10) when missing or out-of-bounds.
 *
 * # Validation rules
 *
 *   - `invite`        — required, ≥16 chars (the cuid v2 lower bound).
 *   - `buyer_name`    — optional, 1–120 chars after trim (R5.3).
 *   - `seller_name`   — optional, 1–120 chars after trim (R5.4).
 *   - `phone`         — optional, 5–32 chars after trim, only digits,
 *                       spaces, hyphens, parentheses, and a single
 *                       optional leading `+` (R5.5).
 *
 * The `@Transform` steps trim surrounding whitespace before validation
 * so the bounds in R5.3 / R5.4 / R5.5 are applied to the value the
 * controller will actually persist. Non-string inputs pass through
 * unchanged so `class-validator` surfaces the right error.
 */

import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { MIN_TOKEN_LENGTH } from '../../common/tokens';

/** Maximum length for `Buyer_Name` / `Seller_Name` per R5.3 / R5.4. */
export const JOIN_NAME_MAX_LENGTH = 120;

/** Lower bound for the optional phone field per R5.5. */
export const JOIN_PHONE_MIN_LENGTH = 5;

/** Upper bound for the optional phone field per R5.5. */
export const JOIN_PHONE_MAX_LENGTH = 32;

/**
 * Allowed-character regex for `phone` per R5.5: digits, spaces,
 * hyphens, parentheses, and a single optional leading `+`. Anchored on
 * both ends so a value containing any other character (including
 * leading whitespace surviving the `@Transform` trim) is rejected.
 */
export const JOIN_PHONE_PATTERN = /^\+?[0-9 ()-]+$/;

export class JoinDealDto {
  /**
   * Raw invite token from the URL `?invite=...`. The controller hashes
   * it (`hashToken`) before reaching the DB; we only enforce the
   * cuid-v2 length lower bound here so a wildly malformed value fails
   * fast at validation time rather than burning a SHA-256 cycle.
   */
  @IsString({ message: 'errors.invite.invalid' })
  @MinLength(MIN_TOKEN_LENGTH, { message: 'errors.invite.invalid' })
  invite!: string;

  /**
   * Optional buyer-side name; required by the controller when the
   * invite resolves to `expected_role === 'buyer'`. Trimmed before
   * validation so a body of `'   Alice   '` lands at `'Alice'`.
   */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'errors.join.invalid_field' })
  @MinLength(1, { message: 'errors.join.invalid_field' })
  @MaxLength(JOIN_NAME_MAX_LENGTH, { message: 'errors.join.invalid_field' })
  buyer_name?: string;

  /**
   * Optional seller-side name; required by the controller when the
   * invite resolves to `expected_role === 'seller'`. Same trimming /
   * bounds as `buyer_name`.
   */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'errors.join.invalid_field' })
  @MinLength(1, { message: 'errors.join.invalid_field' })
  @MaxLength(JOIN_NAME_MAX_LENGTH, { message: 'errors.join.invalid_field' })
  seller_name?: string;

  /**
   * Optional contact phone (R5.5). 5–32 characters of digits, spaces,
   * hyphens, parentheses, and a single optional leading `+`. Non-empty
   * `phone` values that fail the format regex collapse to
   * `join.invalid_field`.
   */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'errors.join.invalid_field' })
  @MinLength(JOIN_PHONE_MIN_LENGTH, { message: 'errors.join.invalid_field' })
  @MaxLength(JOIN_PHONE_MAX_LENGTH, { message: 'errors.join.invalid_field' })
  @Matches(JOIN_PHONE_PATTERN, { message: 'errors.join.invalid_field' })
  phone?: string;
}
