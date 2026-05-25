/**
 * AuditService — append-only writer for `audit_log_entry`.
 *
 * Source of truth: design §"AuditService (`src/audit/`)"; tasks.md §3.9.
 * Acceptance criteria: R20.1, R20.2, R20.3, R20.4.
 *
 * ## Why `tx` is required
 *
 * R20.4 requires that if the audit-log write fails for any covered action,
 * the **originating action** rolls back. That is only achievable when the
 * audit insert and the originating mutation share a single Prisma
 * `$transaction`. If we accepted a no-`tx` call site (committing the audit
 * row through the global `PrismaService`) the audit row would land
 * **independently** of the business change, breaking R20.4 in both
 * directions:
 *
 *   - business commit + audit failure → no rollback (R20.4 broken)
 *   - business rollback + audit commit → orphan audit row (R20.1 misleading)
 *
 * The design therefore specifies a `tx`-required signature
 * (`record(entry: NewAuditLogEntry, tx: Tx): Promise<void>`) and tasks.md §3.9
 * is explicit:
 *
 *   > Required to be called inside the originating tx; throws if no tx is
 *   > provided.
 *
 * Callers obtain the `Prisma.TransactionClient` from
 * `PrismaService.runInTransaction(...)` (or `prisma.$transaction(async (tx) =>
 * ...)`) and pass it through alongside their other writes inside the same
 * callback.
 *
 * ## Append-only at the DB layer
 *
 * `audit_log_entry` has `UPDATE, DELETE, TRUNCATE` REVOKEd from the runtime
 * `app` role plus a `BEFORE UPDATE OR DELETE OR TRUNCATE` trigger calling
 * `reject_mutation()` (R20.5; task 2.10). This service deliberately exposes
 * **only** an insert path — no `update`, no `delete`, no `upsert` method.
 * That keeps the service surface aligned with what the database will
 * actually accept and prevents callers from reaching for a soft-delete
 * pattern that would be rejected at runtime anyway.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal } from 'decimal.js';

import {
  Currency,
  DealStatus,
  ParticipantRole,
} from '../common/enums';

/**
 * Input shape for {@link AuditService.record}.
 *
 * Mirrors the `audit_log_entry` table columns (design §"Audit log and
 * notifications") with the one ergonomic adjustment that `amount` accepts a
 * `Decimal | string | number` so callers can pass the same value they pass
 * to `WalletLedgerEntry.amount` (`decimal.js`) or a parsed currency string.
 *
 * `id` and `created_at` are intentionally omitted — they are filled by the
 * database (`BIGSERIAL`, `default now()` at millisecond precision per
 * R20.1–R20.3).
 *
 * `metadata` is free-form JSON for action-specific context (e.g. rejection
 * reason, payout reference, reviewer note). Callers should NEVER place raw
 * tokens, password hashes, KHQR strings, merchant secrets, or any other
 * sensitive value here — the audit log is broadly readable inside the app.
 */
export interface NewAuditLogEntry {
  /**
   * The kind of action being recorded. Plain string (no enum at the DB or
   * Prisma layer) so new action types can be introduced without an
   * `audit_action_type` Postgres enum migration. Examples used elsewhere
   * in the spec:
   *
   *   - `'DEAL_STATUS_TRANSITION'`     (R20.1; DealService.transition)
   *   - `'WALLET_PAYMENT'`             (R20.2; WalletService.payDealFromWallet)
   *   - `'WALLET_AUTO_RELEASE'`        (R20.2; WalletService.autoReleaseToSeller)
   *   - `'WITHDRAWAL_HOLD'`            (R20.2; WithdrawalService.create)
   *   - `'WITHDRAWAL_PAYOUT'`          (R20.3; WithdrawalService.approve)
   *   - `'WITHDRAWAL_RELEASE'`         (R20.3; WithdrawalService.reject)
   *   - `'ADMIN_PAYMENT_VERIFY'`       (R20.3; PaymentService verify)
   *   - `'ADMIN_PAYMENT_REJECT'`       (R20.3; PaymentService reject)
   *   - `'ADMIN_DISPUTE_RESOLVE'`      (R20.3; DisputeService.resolve)
   */
  action_type: string;
  /** Authenticated User who performed the action; null for system actions. */
  actor_user_id?: string | null;
  /** Role the actor played at the moment of the action. */
  actor_role?: ParticipantRole | null;
  /** Related Deal Room id when the action is deal-scoped (R20.1, R20.2). */
  deal_id?: string | null;
  /** Related Withdrawal Request id when the action is withdrawal-scoped (R20.2, R20.3). */
  withdrawal_id?: string | null;
  /**
   * Two-decimal monetary value when the action moved money. Accepts
   * `Decimal`, `string`, or `number` for caller ergonomics; the value is
   * passed to Prisma which converts it to `Decimal(18, 2)` for storage.
   */
  amount?: Decimal | string | number | null;
  /** ISO 4217 currency the action operated in, when applicable. */
  currency?: Currency | null;
  /** Previous Deal_Status. Required when `action_type` describes a transition (R20.1). */
  prev_status?: DealStatus | null;
  /** New Deal_Status. Required when `action_type` describes a transition (R20.1). */
  new_status?: DealStatus | null;
  /**
   * Free-form context payload. NEVER include secrets here — audit rows are
   * readable by every admin user and surface in the per-deal /
   * per-withdrawal audit timeline.
   */
  metadata?: Prisma.InputJsonValue | null;
}

/**
 * Append-only writer for the `audit_log_entry` table.
 *
 * The single public method, {@link AuditService.record}, MUST be called
 * inside the same Prisma `$transaction` as the action being audited
 * (R20.1–R20.4). The service does **not** open a transaction of its own
 * and does **not** fall back to the global `PrismaService` — see the
 * file-level docstring for the rationale.
 */
@Injectable()
export class AuditService {
  /**
   * Insert a single audit row inside the caller-supplied transaction.
   *
   * Throws synchronously (before any DB I/O) when `tx` is missing, which
   * is the contract documented in tasks.md §3.9 and design §"AuditService".
   * That early throw means a forgotten `tx` argument fails fast at the
   * call site rather than silently committing the audit row outside the
   * originating transaction.
   *
   * The function returns `void` rather than the inserted row because:
   *   - the `BIGSERIAL` id is an internal correlation handle and is not
   *     surfaced through any user-facing API,
   *   - returning the row would tempt callers to reuse it after the
   *     transaction commits, which is unnecessary for the audit pattern.
   *
   * Failure propagates to the caller. R20.4 is satisfied transitively:
   * if the insert throws (constraint violation, connection error, …) the
   * caller's `$transaction` callback throws, which rolls back every
   * change made in the same transaction.
   *
   * @param entry  Audit row payload. See {@link NewAuditLogEntry}.
   * @param tx     Prisma transaction client obtained from
   *               `PrismaService.runInTransaction(async (tx) => …)`.
   * @throws       `Error('AuditService.record: tx is required …')` when
   *               `tx` is missing or null.
   */
  async record(
    entry: NewAuditLogEntry,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (!tx) {
      // R20.4 — the audit insert MUST share the originating transaction
      // so that an audit failure rolls back the business change. Without
      // a `tx` we cannot guarantee that and refuse the call.
      throw new Error(
        'AuditService.record: tx is required; audit rows MUST be written inside the originating transaction (R20.4).',
      );
    }

    await tx.auditLogEntry.create({
      data: {
        action_type: entry.action_type,
        actor_user_id: entry.actor_user_id ?? null,
        actor_role: entry.actor_role ?? null,
        deal_id: entry.deal_id ?? null,
        withdrawal_id: entry.withdrawal_id ?? null,
        amount: normalizeAmount(entry.amount),
        currency: entry.currency ?? null,
        prev_status: entry.prev_status ?? null,
        new_status: entry.new_status ?? null,
        // Prisma rejects `undefined` for optional JSON columns; coerce
        // missing/`null` metadata to `Prisma.JsonNull` so the DB receives
        // SQL NULL.
        metadata: entry.metadata == null ? Prisma.JsonNull : entry.metadata,
      },
    });
  }
}

/**
 * Normalize the caller-supplied `amount` to a Prisma-friendly `Decimal`
 * input or `null`. Prisma accepts `Decimal | string | number` for
 * `Decimal(18, 2)` columns, so we hand the value through verbatim except
 * when the caller passed `undefined`/`null` (mapped to SQL NULL).
 *
 * Strings are NOT parsed here — Prisma's own `Decimal(18, 2)` mapper
 * rejects malformed values with a clear error, which is the right place
 * for that diagnostic.
 */
function normalizeAmount(
  value: Decimal | string | number | null | undefined,
): Decimal | string | number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return value;
}
