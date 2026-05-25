// task 5.2
/**
 * DTO for `POST /v1/deals` (deal creation, R2 + R3).
 *
 * Source of truth: tasks.md §5.2; design §"DealService → create";
 * R2.1, R2.2, R2.3, R2.4, R2.5 (seller flow);
 * R3.1, R3.2, R3.3 (buyer flow).
 *
 * # Layered validation strategy
 *
 * The DTO is the FIRST gate the request body hits — it runs before the
 * service layer touches the database. We validate the cheap, request-
 * shape-level invariants here (string presence, length bounds, enum
 * membership, "is this a number-shaped string?") and defer the
 * money-range / out-of-bound checks to `assertValidDealAmount` inside
 * `DealService.create`. That two-step split mirrors the existing
 * `EmailSignupDto → hashPassword` pattern (`auth/dto/email-signup.dto.ts`
 * + `auth/password.ts`):
 *
 *   - DTO layer rejects malformed shapes with `errors.deal.invalid_field`
 *     so the client sees a structured envelope without us spending DB
 *     cycles or running role-conditional logic.
 *   - Service layer applies the role-conditional required-field checks
 *     (R2.3 vs R3.3) and the money-range / precision check via
 *     `assertValidDealAmount`. That's where role-aware "missing
 *     required" becomes meaningful — the DTO can't enforce R2.3 on its
 *     own because the buyer flow accepts a different required set.
 *
 * # Field rules (DTO-level)
 *
 * - `creator_role` — `'buyer' | 'seller'`. R2.6 / R3.5 anchor the
 *   creator role on the deal row; the controller refuses any other
 *   value (the service rejects `'admin'` defensively, but the DTO is
 *   the user-facing surface). `'admin'` is intentionally absent —
 *   admin-created deals don't exist in the spec.
 *
 * - `creator_source` — optional `'web' | 'telegram'` (R2.6 / R3.4).
 *   Defaults to `'web'` when omitted (the schema default also sets
 *   `'web'`). The Telegram bot adapter sets this to `'telegram'`
 *   explicitly when calling `DealService.create` from `BotConversation`.
 *
 * - String section fields (`product_title`, `product_type`,
 *   `product_description`, `condition`, `buyer_name`, `seller_name`,
 *   `buyer_phone`, `seller_phone`) — trimmed by `class-transformer`
 *   before length validation runs, so `"   "` round-trips to `""` and
 *   fails `@MinLength(1)`. Length bounds match R2.1, R3.1, R3.2, R7.1
 *   exactly.
 *
 * - `deal_amount` — accepted as either a number or a string-shaped
 *   number (`'12.30'`, `'0.01'`). We do NOT use `@IsNumber()` because
 *   `Number` parsing introduces FP drift (`0.1 + 0.2 !== 0.3`); we
 *   validate the string shape with `@Matches(/^...$/)` and let
 *   `parseMoney` / `assertValidDealAmount` in the service do the
 *   precision and range checks. A `number` input is coerced to
 *   string via `@Transform` so the service path receives a uniform
 *   `string | undefined` value.
 *
 * - `quantity` — optional integer 1–999_999 (R7.1). `@IsInt` rejects
 *   floats and non-numeric input.
 *
 * - `condition` — `'new' | 'used'` (R7.1). TEXT (not an enum) on the
 *   DB side; the DTO enforces the case-sensitive allow-list.
 *
 * - `currency` — `'USD' | 'KHR'` (R2.2, R3.1). The case-sensitive enum
 *   check matches R2.2 ("case-sensitive set {USD, KHR}").
 *
 * - `preferred_lang` (per-side) — `'km' | 'en' | 'zh'` (R7.2).
 *
 * # Why DTO does NOT split seller vs buyer required fields
 *
 * R2.3 says "missing → reject" for seller flow on Seller_Name +
 * Product_Title + Deal_Amount + Currency. R3.3 says the same for buyer
 * flow on Buyer_Name + Product_Title + Deal_Amount + Currency. Both
 * targets share `Product_Title`, `Deal_Amount`, `Currency` but diverge
 * on the name field. We could implement this with a discriminated DTO
 * (`SellerCreateDealDto` vs `BuyerCreateDealDto`) but that means two
 * separate decorator graphs and a manual selector at the controller.
 *
 * Instead we let every section field be optional at the DTO layer and
 * raise the role-conditional `deal.missing_required_fields` /
 * `deal.invalid_field` envelopes inside `DealService.create`. That keeps
 * the DTO simple and matches the parallel patch-section DTO pattern
 * (task 5.6) where every field is also optional.
 */

import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  ALL_CREATOR_SOURCES,
  ALL_CURRENCIES,
  ALL_PREFERRED_LANGS,
} from '../../common/enums';

// ---------------------------------------------------------------------------
// Section sub-DTOs.
//
// Authored as flat fields on the request body (`product_title`, ...) but
// grouped into logical sections so the patch endpoints (task 5.6) can
// reuse the same field rules. Each section maps onto the `DealRoom`
// snake_case columns 1:1.
// ---------------------------------------------------------------------------

/** Trim a string field, leaving non-strings alone. */
const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Coerce a number or string into the `deal_amount` string shape the
 * service layer expects. Numbers are stringified through
 * `Number.prototype.toString` (NOT `JSON.stringify`) so integer values
 * round-trip without exponent notation. Non-finite numbers fall through
 * to the regex which rejects them.
 */
const coerceDealAmount = ({ value }: { value: unknown }) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString();
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return value;
};

/**
 * Regex shape for `deal_amount`: a non-empty string consisting of
 * digits with at most two decimal places (`'12'`, `'12.3'`, `'12.30'`,
 * `'0.01'`). Negative values, exponents, and currency symbols are
 * rejected. Range / precision (≤ 2dp at the DB layer) is re-validated
 * inside the service via `assertValidDealAmount` so the canonical
 * `money.invalid` / `money.out_of_range` errors are raised there.
 */
const DEAL_AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

/**
 * Permissive phone-shape regex used for participant phone fields.
 * Matches the R5.5 (join) spec: 5–32 chars consisting of digits,
 * spaces, hyphens, parentheses, and an optional leading `+`. The
 * length is enforced separately by `@MinLength` / `@MaxLength` so the
 * regex only validates the character class.
 */
const PHONE_PATTERN = /^\+?[\d\s\-()]+$/;

// ---------------------------------------------------------------------------
// Top-level DTO
// ---------------------------------------------------------------------------

/**
 * Body of `POST /v1/deals` (R2 + R3).
 *
 * Section fields are flat on the request payload (no nested
 * `product`/`participant` objects) to match the existing API style and
 * to keep the `class-validator` graph small. The service layer
 * regroups them into the `sections` shape expected by
 * `DealService.create`.
 */
export class CreateDealDto {
  // -------------------------------------------------------------------------
  // Core creator metadata
  // -------------------------------------------------------------------------

  /**
   * Role the authenticated user is creating the deal in. R2.6 / R3.5.
   * Counterparty receives the opposite role at join time (R5.2).
   */
  @IsIn(['buyer', 'seller'], {
    message: 'errors.deal.invalid_field',
  })
  creator_role!: 'buyer' | 'seller';

  /**
   * Where the deal originated. Defaults to `'web'`; the Telegram bot
   * adapter passes `'telegram'` explicitly. R2.6 / R3.4.
   */
  @IsOptional()
  @IsIn(ALL_CREATOR_SOURCES as readonly string[], {
    message: 'errors.deal.invalid_field',
  })
  creator_source?: 'web' | 'telegram';

  // -------------------------------------------------------------------------
  // Product section (R2.1, R3.1, R7.1)
  // -------------------------------------------------------------------------

  /**
   * 1–200 characters after trim. R2.1 (seller) / R3.1 (buyer) /
   * R7.1 (patch). Required at the service layer for both flows.
   */
  @IsOptional()
  @Transform(trimString)
  @IsString({ message: 'errors.deal.invalid_field' })
  @MinLength(1, { message: 'errors.deal.invalid_field' })
  @MaxLength(200, { message: 'errors.deal.invalid_field' })
  product_title?: string;

  /**
   * 1–100 characters after trim (R7.1). Required at the service layer
   * via `computeMissingFields` before the deal can transition to
   * `READY_FOR_PAYMENT` (R6.1) but optional at create time — the
   * buyer flow can leave it blank for the seller to fill in.
   */
  @IsOptional()
  @Transform(trimString)
  @IsString({ message: 'errors.deal.invalid_field' })
  @MinLength(1, { message: 'errors.deal.invalid_field' })
  @MaxLength(100, { message: 'errors.deal.invalid_field' })
  product_type?: string;

  /**
   * 0–2000 characters after trim (R3.2 / R7.1). Buyer-flow only at
   * create time; the seller flow ignores this field per R2.5 (the
   * service drops it). Empty string round-trips to `null` at the
   * service layer.
   */
  @IsOptional()
  @Transform(trimString)
  @IsString({ message: 'errors.deal.invalid_field' })
  @MaxLength(2000, { message: 'errors.deal.invalid_field' })
  product_description?: string;

  /**
   * Integer 1–999_999 (R7.1). Optional at create.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'errors.deal.invalid_field' })
  @Min(1, { message: 'errors.deal.invalid_field' })
  @Max(999_999, { message: 'errors.deal.invalid_field' })
  quantity?: number;

  /**
   * `'new'` or `'used'` (R7.1). TEXT on the DB side; the DTO enforces
   * the case-sensitive allow-list.
   */
  @IsOptional()
  @IsIn(['new', 'used'], {
    message: 'errors.deal.invalid_field',
  })
  condition?: 'new' | 'used';

  /**
   * Two-decimal money amount serialised as a string (R2.1, R3.1,
   * R7.1). The service re-validates via `assertValidDealAmount` to
   * enforce the [0.01, 999_999_999.99] range and catch any over-
   * precision sneaking past the regex. We deliberately do NOT use
   * `@IsNumber()` here because IEEE-754 round-tripping would corrupt
   * KHR amounts.
   */
  @IsOptional()
  @Transform(coerceDealAmount)
  @IsString({ message: 'errors.deal.invalid_field' })
  @Matches(DEAL_AMOUNT_PATTERN, { message: 'errors.deal.invalid_field' })
  deal_amount?: string;

  /** R2.2 / R3.1 — case-sensitive `'USD' | 'KHR'`. */
  @IsOptional()
  @IsIn(ALL_CURRENCIES as readonly string[], {
    message: 'errors.deal.invalid_field',
  })
  currency?: 'USD' | 'KHR';

  // -------------------------------------------------------------------------
  // Participant sections (R2.1 / R3.1 / R5 / R7.2)
  // -------------------------------------------------------------------------

  /**
   * 1–100 characters after trim (R2.1 / R7.2). Required at the
   * service layer for the seller-flow (R2.3); optional for the
   * buyer-flow at create time.
   */
  @IsOptional()
  @Transform(trimString)
  @IsString({ message: 'errors.deal.invalid_field' })
  @MinLength(1, { message: 'errors.deal.invalid_field' })
  @MaxLength(100, { message: 'errors.deal.invalid_field' })
  seller_name?: string;

  /**
   * 1–100 characters after trim (R3.1 / R7.2). Required at the
   * service layer for the buyer-flow (R3.3); optional for the
   * seller-flow at create time.
   */
  @IsOptional()
  @Transform(trimString)
  @IsString({ message: 'errors.deal.invalid_field' })
  @MinLength(1, { message: 'errors.deal.invalid_field' })
  @MaxLength(100, { message: 'errors.deal.invalid_field' })
  buyer_name?: string;

  /**
   * Optional creator phone number (5–32 chars, R5.5 / R7.2). On the
   * seller flow this is the seller's phone; on the buyer flow this is
   * the buyer's phone. The service stores it on the matching
   * `DealParticipant` row, not on `DealRoom`.
   */
  @IsOptional()
  @Transform(trimString)
  @IsString({ message: 'errors.deal.invalid_field' })
  @MinLength(5, { message: 'errors.deal.invalid_field' })
  @MaxLength(32, { message: 'errors.deal.invalid_field' })
  @Matches(PHONE_PATTERN, { message: 'errors.deal.invalid_field' })
  phone?: string;

  /** R7.2 — preferred UI language for the creator. */
  @IsOptional()
  @IsIn(ALL_PREFERRED_LANGS as readonly string[], {
    message: 'errors.deal.invalid_field',
  })
  preferred_lang?: 'km' | 'en' | 'zh';
}
