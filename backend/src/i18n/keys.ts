/**
 * Centralised message-key registry for the backend.
 *
 * The backend never returns hardcoded user-facing strings. Every
 * `BadRequestException`, success envelope, and notification payload
 * carries a `message_key` (and optional `details`) that the frontend
 * resolves via `next-intl` against `frontend/messages/{km,en,zh}.json`.
 *
 * This file is the single source of truth for which keys exist on the
 * backend. Each constant below is the literal dotted key emitted by the
 * service layer; the frontend message JSONs MUST contain a translation
 * for every value here.
 *
 * Key shape (see `backend/src/i18n/README.md`):
 *
 *     errors.<domain>.<state_or_action>
 *     messages.<domain>.<state_or_action>
 *     notifications.<event_name>
 *
 * The `errors.`, `messages.`, and `notifications.` prefixes keep
 * backend-emitted keys cleanly separated from purely-UI keys
 * (`common.*`, `deal.create.*`, `auth.login_title`, etc.) that the
 * frontend defines on its own.
 *
 * Pure module — no I/O, no side effects on import. The arrays are frozen
 * at module load so consumers can rely on runtime immutability.
 *
 * Related docs:
 *   - design.md §"Cross-Cutting Concerns → Error envelope"
 *   - tasks.md task 3.6 (exception filter), task 3.10 (this module)
 *   - AGENTS.md → "Backend Coding Rules" (`message_key` rule)
 */

// -----------------------------------------------------------------------------
// Error keys — emitted from `HttpException`s in the global exception filter.
//
// Every entry here corresponds to a specific failure mode in the
// requirements/design. Adding a new error code MUST go through this list
// and the matching frontend message JSON files in the same change.
//
// The `error.code` field in the response envelope drops the `errors.`
// prefix (e.g., `wallet.insufficient_balance`) because the envelope
// itself encodes the error nature. The `message_key` field carries the
// full dotted key (`errors.wallet.insufficient_balance`) so the frontend
// can pass it straight to `useTranslations()`.
// -----------------------------------------------------------------------------

export const ERROR_KEYS = [
  // -- errors.auth.* (R1.5–R1.9, R5.9, R7.6, R8.6, R16.6, R16.8) -------------
  'errors.auth.required',
  'errors.auth.invalid_signup_data',
  'errors.auth.invalid_credentials',
  'errors.auth.invalid_password_length',
  'errors.auth.email_taken',
  'errors.auth.rate_limited',
  'errors.auth.role_forbidden',
  'errors.auth.admin_required',

  // -- errors.deal.* (R2.3, R2.4, R3.3, R6.5, R7.5, R7.7, R8.2) --------------
  'errors.deal.missing_required_fields',
  'errors.deal.invalid_field',
  'errors.deal.locked_after_payment',
  'errors.deal.approval_not_allowed',
  'errors.deal.invalid_state',
  'errors.deal.not_found',

  // -- errors.invite.* / errors.join.* (R4.3, R5.7, R5.10) -------------------
  'errors.invite.invalid',
  'errors.invite.consumed',
  'errors.join.invalid_field',

  // -- errors.wallet.* (R9.3, R9.5, R9.6, R9.9) ------------------------------
  'errors.wallet.insufficient_balance',
  'errors.wallet.currency_mismatch',
  'errors.wallet.invalid_deal_state',
  'errors.wallet.transaction_failed',
  'errors.wallet.not_found',

  // -- errors.payment.* (R10.5, R10.8, R11.6, R11.7) -------------------------
  'errors.payment.khqr_unavailable',
  'errors.payment.empty_receipt',
  'errors.payment.invalid_state',
  'errors.payment.invalid_reason',

  // -- errors.shipping.* (R12.5, R12.6) --------------------------------------
  'errors.shipping.empty_proof',
  'errors.shipping.invalid_state',

  // -- errors.confirmation.* (R13.x) -----------------------------------------
  'errors.confirmation.invalid_state',
  'errors.confirmation.already_confirmed',

  // -- errors.dispute.* (R17.4, R17.6) ---------------------------------------
  'errors.dispute.invalid_state',
  'errors.dispute.duplicate_active',
  'errors.dispute.invalid_reason',
  'errors.dispute.invalid_message_length',

  // -- errors.withdrawal.* (R15.x, R16.4, R16.5) -----------------------------
  'errors.withdrawal.invalid_amount',
  'errors.withdrawal.invalid_destination',
  'errors.withdrawal.invalid_status',
  'errors.withdrawal.not_found',

  // -- errors.storage.* (R10.7, R12.4, R15.3) --------------------------------
  'errors.storage.invalid_file',
  'errors.storage.upload_failed',

  // -- errors.rate.* (R1.7, R4.6) --------------------------------------------
  'errors.rate.exceeded',

  // -- errors.binance.* (R21.x, R22.x) ---------------------------------------
  'errors.binance.unavailable',
  'errors.binance.invalid_signature',
  'errors.binance.order_not_found',

  // -- errors.idempotency.* (R13.2, R16.2, R16.3, R18.11) --------------------
  'errors.idempotency.mismatch',

  // -- errors.validation.* (generic class-validator failures) ----------------
  'errors.validation.invalid_field',
  'errors.validation.required_field',
  'errors.validation.out_of_range',
] as const;

export type ErrorKey = (typeof ERROR_KEYS)[number];

const ERROR_KEY_SET: ReadonlySet<string> = new Set(ERROR_KEYS);

/** Type guard: true when `s` is a known error key registered in `ERROR_KEYS`. */
export function isErrorKey(s: string): s is ErrorKey {
  return ERROR_KEY_SET.has(s);
}

// -----------------------------------------------------------------------------
// Success / info-banner keys — used in non-error response envelopes.
//
// The `DealRoomResponse` carries an optional `message_key` (design §
// "Cross-Cutting Concerns → Response shape") that the frontend renders as
// a toast or banner. Use these for "you just did X" feedback, not for
// long-running notifications (see `NOTIFICATION_KEYS` below).
// -----------------------------------------------------------------------------

export const MESSAGE_KEYS = [
  'messages.deal.created',
  'messages.deal.updated',
  'messages.deal.approved',
  'messages.deal.joined',
  'messages.payment.proof_uploaded',
  'messages.payment.verified',
  'messages.payment.released',
  'messages.shipping.uploaded',
  'messages.confirmation.received',
  'messages.dispute.opened',
  'messages.dispute.resolved',
  'messages.withdrawal.requested',
  'messages.withdrawal.paid',
  'messages.withdrawal.rejected',
] as const;

export type MessageKey = (typeof MESSAGE_KEYS)[number];

// -----------------------------------------------------------------------------
// Notification-event keys — emitted via `NotificationOutboxService.enqueue`.
//
// One entry per `NotificationEvent` enum value (see
// `src/common/enums.ts`). The frontend (in-app timeline) and the Telegram
// adapter both look up these keys when rendering the message body.
// -----------------------------------------------------------------------------

export const NOTIFICATION_KEYS = [
  'notifications.counterparty_joined',
  'notifications.deal_updated',
  'notifications.both_approved',
  'notifications.payment_proof_uploaded',
  'notifications.payment_verified',
  'notifications.payment_rejected',
  'notifications.seller_should_ship',
  'notifications.shipping_uploaded',
  'notifications.buyer_confirmed',
  'notifications.dispute_opened',
  'notifications.payout_released',
  'notifications.refund_completed',
  'notifications.withdrawal_requested',
  'notifications.withdrawal_paid',
  'notifications.withdrawal_rejected',
  'notifications.admin_release_failed',
] as const;

export type NotificationKey = (typeof NOTIFICATION_KEYS)[number];

// -----------------------------------------------------------------------------
// Aggregate registry — the union of every key the backend may emit.
// -----------------------------------------------------------------------------

/** Every backend-emitted message key. Frozen for runtime immutability. */
export const ALL_BACKEND_MESSAGE_KEYS: readonly string[] = Object.freeze([
  ...ERROR_KEYS,
  ...MESSAGE_KEYS,
  ...NOTIFICATION_KEYS,
]);

export type BackendMessageKey = ErrorKey | MessageKey | NotificationKey;

const ALL_KEYS_SET: ReadonlySet<string> = new Set(ALL_BACKEND_MESSAGE_KEYS);

/**
 * Type guard: true when `s` is any backend-registered message key
 * (error, success, or notification). Used by tests that assert the
 * frontend translation files cover every key the backend may emit.
 */
export function isBackendMessageKey(s: string): s is BackendMessageKey {
  return ALL_KEYS_SET.has(s);
}

/**
 * Strip the leading `errors.` prefix from an error message key, returning
 * the bare `<domain>.<...>` code suitable for the `error.code` field of
 * the response envelope.
 *
 * Example: `errorCodeFromKey('errors.wallet.insufficient_balance')`
 *          → `'wallet.insufficient_balance'`.
 */
export function errorCodeFromKey(key: ErrorKey): string {
  return key.startsWith('errors.') ? key.slice('errors.'.length) : key;
}
