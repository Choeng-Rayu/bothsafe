/**
 * Cross-module compile-time constants.
 *
 * Anything a service needs that is not produced by the Prisma generator and
 * is not configuration lives here: the deal-status transitions table, the
 * required-fields list, the material-edit field set, the allowed-action
 * keys, money bounds, file-size limits, allowed MIME types, and the default
 * TTL/window values used by `src/config/configuration.ts` as fallbacks.
 *
 * Every export is either `as const` (literal types) or wrapped in
 * `Object.freeze` (runtime immutability). Pure module — no I/O, no side
 * effects on import.
 *
 * See also:
 *   - design §"Deal Status state machine" — source of `DEAL_STATUS_TRANSITIONS`.
 *   - AGENTS.md → "Deal Status Enum" — canonical status names.
 *   - requirements.md R6.1 (required fields), R7.3 (material-edit fields),
 *     R10.5–R10.7 (file size / MIME), R1.7 (auth rate limit window).
 */

import { DealStatus } from './enums';

// -----------------------------------------------------------------------------
// Deal-status transitions table.
//
// Maps each `DealStatus` to the readonly set of legal next statuses per
// design §"Deal Status state machine". `DealService.transition` is the
// only place a deal's status mutates — it consults this table to decide
// whether `(prev, next)` is admissible, and writes an `AuditLogEntry` in
// the same transaction (R20.1).
//
// Wrapped with `Object.freeze` so consumers can rely on runtime
// immutability; combined with the `as const`-typed inner arrays this also
// gives compile-time literal types for each row.
//
// `READY_FOR_PAYMENT → AWAITING_BOTH_APPROVAL` covers the material-edit
// revert path (R7.3) and the cleared-required-field revert path (R6.5).
// Terminal states (RELEASED, REFUNDED, CANCELLED, EXPIRED) map to `[]`.
// -----------------------------------------------------------------------------

export const DEAL_STATUS_TRANSITIONS: Readonly<Record<DealStatus, readonly DealStatus[]>> =
  Object.freeze({
    [DealStatus.DRAFT]: [DealStatus.AWAITING_COUNTERPARTY] as const,
    [DealStatus.AWAITING_COUNTERPARTY]: [
      DealStatus.AWAITING_BOTH_APPROVAL,
      DealStatus.EXPIRED,
      DealStatus.CANCELLED,
    ] as const,
    [DealStatus.AWAITING_BOTH_APPROVAL]: [
      DealStatus.READY_FOR_PAYMENT,
      DealStatus.CANCELLED,
    ] as const,
    [DealStatus.READY_FOR_PAYMENT]: [
      DealStatus.PAID_ESCROWED,
      DealStatus.PAYMENT_PENDING_VERIFICATION,
      // Material edit / cleared required field reverts (R6.5, R7.3).
      DealStatus.AWAITING_BOTH_APPROVAL,
    ] as const,
    [DealStatus.PAYMENT_PENDING_VERIFICATION]: [
      DealStatus.PAID_ESCROWED,
      DealStatus.READY_FOR_PAYMENT,
      DealStatus.DISPUTED,
    ] as const,
    [DealStatus.PAID_ESCROWED]: [
      DealStatus.SELLER_PREPARING,
      DealStatus.REFUNDED,
      DealStatus.DISPUTED,
    ] as const,
    [DealStatus.SELLER_PREPARING]: [DealStatus.SHIPPED, DealStatus.DISPUTED] as const,
    [DealStatus.SHIPPED]: [DealStatus.RELEASE_PENDING, DealStatus.DISPUTED] as const,
    [DealStatus.BUYER_CONFIRMED]: [DealStatus.RELEASE_PENDING] as const,
    [DealStatus.RELEASE_PENDING]: [DealStatus.RELEASED] as const,
    [DealStatus.DISPUTED]: [DealStatus.RELEASED, DealStatus.REFUNDED] as const,
    [DealStatus.RELEASED]: [] as const,
    [DealStatus.REFUNDED]: [] as const,
    [DealStatus.CANCELLED]: [] as const,
    [DealStatus.EXPIRED]: [] as const,
  });

/**
 * Returns true when `to` is a legal next status for `from` per
 * `DEAL_STATUS_TRANSITIONS`. Pure lookup — does not consult the database
 * and does not record an audit row; that is the caller's responsibility
 * (`DealService.transition`).
 */
export function canTransition(from: DealStatus, to: DealStatus): boolean {
  return DEAL_STATUS_TRANSITIONS[from].includes(to);
}

// -----------------------------------------------------------------------------
// Field-level constants.
// -----------------------------------------------------------------------------

/**
 * Pre-payment required-field set (R6.1). A field is considered "missing"
 * when its value is null, absent, or whitespace-only; `Deal_Amount` is
 * additionally considered empty when it falls outside the legal money
 * range (see `DEAL_AMOUNT_MIN` / `DEAL_AMOUNT_MAX`). The list uses the
 * canonical names that appear in API responses (`missing_fields`).
 */
export const DEAL_REQUIRED_FIELDS = [
  'Product_Title',
  'Product_Type',
  'Deal_Amount',
  'Buyer_Name',
  'Seller_Name',
] as const;

export type DealRequiredField = (typeof DEAL_REQUIRED_FIELDS)[number];

/**
 * Fields whose modification is treated as a material edit (R7.3): editing
 * any of them clears both prior approvals and reverts the deal to
 * `AWAITING_BOTH_APPROVAL`. Names match the snake_case database columns
 * on `DealRoom`.
 */
export const DEAL_MATERIAL_EDIT_FIELDS = [
  'product_title',
  'product_description',
  'deal_amount',
  'currency',
] as const;

export type DealMaterialEditField = (typeof DEAL_MATERIAL_EDIT_FIELDS)[number];

/**
 * Allowed-action keys returned in the `allowed_actions` array on every
 * Deal Room response. Computed per-viewer by
 * `DealService.computeAllowedActions` based on `Deal_Status`,
 * `missing_fields`, and the viewer's role. Mirrors AGENTS.md → "Frontend
 * Coding Rules" — UIs render exclusively from this list.
 *
 * Source of truth: design.md → "Standard `DealRoomResponse` shape →
 * `AllowedAction`" union. The two payment actions are split because the
 * buyer chooses between paying from their internal wallet (R9.1, gated
 * by sufficient balance) and paying via Bakong KHQR (R10.1); the
 * follow-up `submit_khqr_receipt` action is exposed only after KHQR
 * payment has been initiated (R10.4).
 */
export const ALLOWED_ACTIONS = [
  'edit_product',
  'edit_participant',
  'approve',
  'pay_from_wallet',
  'pay_khqr',
  'submit_khqr_receipt',
  'submit_shipping_proof',
  'confirm_received',
  'open_dispute',
] as const;

export type AllowedAction = (typeof ALLOWED_ACTIONS)[number];

// -----------------------------------------------------------------------------
// Token / TTL defaults.
//
// Used as fallbacks in `src/config/configuration.ts` when the environment
// variable is unset. Production deployments override every value via the
// `.env` loaded by `docker-compose.prod.yml`; these defaults are sized for
// dev ergonomics and the canonical product copy.
// -----------------------------------------------------------------------------

/** Invite-token lifetime in hours (R4.3). Default: 72 h. */
export const INVITE_TOKEN_TTL_HOURS_DEFAULT = 72;

/** Deal expiry clock for `AWAITING_COUNTERPARTY → EXPIRED` in hours. Default: 720 h (30 d). */
export const DEAL_EXPIRES_HOURS_DEFAULT = 720;

/**
 * Session lifetime in days. R1.2 specifies 24 h; we keep the unit in days
 * because the env var (`SESSION_TTL_DAYS`) is days. Default: 1 day.
 */
export const SESSION_TTL_DAYS_DEFAULT = 1;

// -----------------------------------------------------------------------------
// Money bounds.
//
// Strings (not numbers) so they round-trip through `Decimal` without
// floating-point loss; consumers should pass them straight to
// `decimal.js` constructors in `src/common/money.ts`.
// -----------------------------------------------------------------------------

/** Minimum legal `Deal_Amount` (R2.1, R3.1). */
export const DEAL_AMOUNT_MIN = '0.01';

/** Maximum legal `Deal_Amount` (R2.1, R3.1). */
export const DEAL_AMOUNT_MAX = '999999999.99';

// -----------------------------------------------------------------------------
// File-size limits.
// -----------------------------------------------------------------------------

/** Receipt / shipping-proof / dispute attachment cap, 10 MB (R10.6, R12.4). */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

/** Withdrawal KHQR image cap, 5 MB (R15.3). Stricter than receipt cap. */
export const KHQR_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

// -----------------------------------------------------------------------------
// Allowed MIME types.
// -----------------------------------------------------------------------------

/** Accepted MIME types for payment receipts and similar uploads (R10.6). */
export const ALLOWED_RECEIPT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'application/pdf',
] as const;

export type AllowedReceiptMimeType = (typeof ALLOWED_RECEIPT_MIME_TYPES)[number];

// -----------------------------------------------------------------------------
// Rate-limit windows.
// -----------------------------------------------------------------------------

/** Sliding window for `auth_login` rate limiter (R1.7). 15 minutes. */
export const AUTH_LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** Maximum failed login attempts in `AUTH_LOGIN_WINDOW_MS` before lockout (R1.7). */
export const AUTH_LOGIN_MAX_FAILS = 5;
