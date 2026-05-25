/**
 * Cross-module enum re-exports and runtime helpers.
 *
 * This file is the single import surface for every enum produced by the
 * Prisma generator (see `prisma/schema.prisma` task 2.2). Re-exporting them
 * from one place keeps consumer modules from depending on `@prisma/client`
 * directly for type-only enum work and lets us add small runtime helpers
 * (literal-typed value arrays, terminal-status discriminators) without
 * forcing those helpers to live next to the schema.
 *
 * Kept in lock-step with the Prisma-generated enums; if a value is added
 * or removed in `schema.prisma`, mirror it here and run
 * `npx tsc --noEmit -p backend/tsconfig.json` to surface drift.
 *
 * Pure module — no I/O, no side effects on import.
 *
 * See also: design §"Postgres-level types and enums" and
 * AGENTS.md → "Deal Status Enum".
 */

export {
  DealStatus,
  Currency,
  ParticipantRole,
  CreatorSource,
  PreferredLang,
  WithdrawalStatus,
  WithdrawalDestination,
  DisputeReason,
  LedgerEntryType,
  LedgerDirection,
  NotificationEvent,
  OutboxStatus,
} from '@prisma/client';

import {
  DealStatus,
  Currency,
  ParticipantRole,
  CreatorSource,
  PreferredLang,
  WithdrawalStatus,
  WithdrawalDestination,
  DisputeReason,
  LedgerEntryType,
  LedgerDirection,
  NotificationEvent,
  OutboxStatus,
} from '@prisma/client';

// -----------------------------------------------------------------------------
// Literal-typed value arrays for runtime iteration / validation.
//
// Each list mirrors the Prisma enum exactly, in the same order as the
// schema. Frozen with `as const` so consumers get both compile-time literal
// types and runtime immutability.
// -----------------------------------------------------------------------------

/** All `DealStatus` members in declaration order. Source of truth: AGENTS.md. */
export const ALL_DEAL_STATUSES = [
  DealStatus.DRAFT,
  DealStatus.AWAITING_COUNTERPARTY,
  DealStatus.AWAITING_BOTH_APPROVAL,
  DealStatus.READY_FOR_PAYMENT,
  DealStatus.PAYMENT_PENDING_VERIFICATION,
  DealStatus.PAID_ESCROWED,
  DealStatus.SELLER_PREPARING,
  DealStatus.SHIPPED,
  DealStatus.BUYER_CONFIRMED,
  DealStatus.DISPUTED,
  DealStatus.RELEASE_PENDING,
  DealStatus.RELEASED,
  DealStatus.REFUNDED,
  DealStatus.CANCELLED,
  DealStatus.EXPIRED,
] as const satisfies readonly DealStatus[];

export const ALL_CURRENCIES = [Currency.USD, Currency.KHR] as const satisfies readonly Currency[];

export const ALL_PARTICIPANT_ROLES = [
  ParticipantRole.buyer,
  ParticipantRole.seller,
  ParticipantRole.admin,
] as const satisfies readonly ParticipantRole[];

export const ALL_CREATOR_SOURCES = [
  CreatorSource.web,
  CreatorSource.telegram,
] as const satisfies readonly CreatorSource[];

export const ALL_PREFERRED_LANGS = [
  PreferredLang.km,
  PreferredLang.en,
  PreferredLang.zh,
] as const satisfies readonly PreferredLang[];

export const ALL_WITHDRAWAL_STATUSES = [
  WithdrawalStatus.pending_admin_review,
  WithdrawalStatus.paid,
  WithdrawalStatus.rejected,
] as const satisfies readonly WithdrawalStatus[];

export const ALL_WITHDRAWAL_DESTINATIONS = [
  WithdrawalDestination.khqr,
  WithdrawalDestination.bank,
] as const satisfies readonly WithdrawalDestination[];

export const ALL_DISPUTE_REASONS = [
  DisputeReason.ITEM_NOT_RECEIVED,
  DisputeReason.WRONG_ITEM,
  DisputeReason.DAMAGED_ITEM,
  DisputeReason.FAKE_ITEM,
  DisputeReason.PAYMENT_PROBLEM,
  DisputeReason.OTHER,
] as const satisfies readonly DisputeReason[];

export const ALL_LEDGER_ENTRY_TYPES = [
  LedgerEntryType.ESCROW_RECEIVED,
  LedgerEntryType.PLATFORM_FEE_RESERVED,
  LedgerEntryType.SELLER_PAYOUT_PENDING,
  LedgerEntryType.SELLER_PAYOUT_SENT,
  LedgerEntryType.BUYER_REFUND_PENDING,
  LedgerEntryType.BUYER_REFUND_SENT,
  LedgerEntryType.ADJUSTMENT,
] as const satisfies readonly LedgerEntryType[];

export const ALL_LEDGER_DIRECTIONS = [
  LedgerDirection.credit,
  LedgerDirection.debit,
] as const satisfies readonly LedgerDirection[];

export const ALL_NOTIFICATION_EVENTS = [
  NotificationEvent.COUNTERPARTY_JOINED,
  NotificationEvent.DEAL_UPDATED,
  NotificationEvent.BOTH_APPROVED,
  NotificationEvent.PAYMENT_PROOF_UPLOADED,
  NotificationEvent.PAYMENT_VERIFIED,
  NotificationEvent.PAYMENT_REJECTED,
  NotificationEvent.SELLER_SHOULD_SHIP,
  NotificationEvent.SHIPPING_UPLOADED,
  NotificationEvent.BUYER_CONFIRMED,
  NotificationEvent.DISPUTE_OPENED,
  NotificationEvent.PAYOUT_RELEASED,
  NotificationEvent.REFUND_COMPLETED,
  NotificationEvent.WITHDRAWAL_REQUESTED,
  NotificationEvent.WITHDRAWAL_PAID,
  NotificationEvent.WITHDRAWAL_REJECTED,
  NotificationEvent.ADMIN_RELEASE_FAILED,
] as const satisfies readonly NotificationEvent[];

export const ALL_OUTBOX_STATUSES = [
  OutboxStatus.pending,
  OutboxStatus.sent,
  OutboxStatus.failed,
] as const satisfies readonly OutboxStatus[];

// -----------------------------------------------------------------------------
// Deal-status discriminator helpers.
// -----------------------------------------------------------------------------

/**
 * Terminal `DealStatus` values: deals in these states are final and may
 * never transition again. Source of truth: design §"Deal Status state
 * machine" — `RELEASED`, `REFUNDED`, `CANCELLED`, `EXPIRED` are sinks.
 */
export const TERMINAL_DEAL_STATUSES = [
  DealStatus.RELEASED,
  DealStatus.REFUNDED,
  DealStatus.CANCELLED,
  DealStatus.EXPIRED,
] as const satisfies readonly DealStatus[];

const TERMINAL_DEAL_STATUS_SET: ReadonlySet<DealStatus> = new Set(TERMINAL_DEAL_STATUSES);

/**
 * Returns true when `s` is a terminal `DealStatus` (no further transitions
 * are legal). Used by `DealService.transition` and the admin dashboard to
 * gate write actions.
 */
export function isTerminalDealStatus(s: DealStatus): boolean {
  return TERMINAL_DEAL_STATUS_SET.has(s);
}
