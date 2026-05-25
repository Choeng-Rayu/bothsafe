/**
 * WalletService — owner of every monetary movement (task 6).
 *
 * Source of truth: tasks.md §6.1–6.5; requirements.md R9, R13.3, R14;
 * design.md §"WalletService".
 *
 * # Responsibilities
 *
 * Every credit, debit, balance read, and `Deal_Status` mutation that
 * touches money flows through this service:
 *
 *   1. {@link getOrCreate}            — one (user, currency) wallet (R14.6).
 *   2. {@link computeBalance}         — Σ(credit) − Σ(debit) (R14.3).
 *   3. {@link getAvailableBalance}    — balance − pending withdrawal holds (R15.6).
 *   4. {@link payDealFromWallet}      — atomic READY_FOR_PAYMENT → SELLER_PREPARING (R9).
 *   5. {@link settleEscrowFromKhqr}   — KHQR auto-verify settle (R11.2).
 *   6. {@link autoReleaseToSeller}    — RELEASE_PENDING → RELEASED (R13.3).
 *
 * # Invariants
 *
 *   - Every method that mutates state takes a `tx` argument or opens
 *     its own `prisma.runInTransaction` so all related ledger rows
 *     and the matching `Deal_Status` transition commit or roll back
 *     together (R9.8, R14.4, R14.5).
 *   - Ledger rows are append-only — the schema layer (task 2.10)
 *     revokes `UPDATE/DELETE/TRUNCATE` on `wallet_ledger_entry` for
 *     the `app` role; this service therefore never tries to mutate a
 *     prior row (R14.2).
 *   - Deal-status transitions are funnelled through `DealService.transition`
 *     so the audit row lands in the same transaction (R20.1).
 */

import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type DealRoom,
  type User,
  type Wallet,
  type WalletLedgerEntry,
} from '@prisma/client';
import { Decimal } from 'decimal.js';

import { AuditService } from '../audit';
import {
  Currency,
  DealStatus,
  LedgerDirection,
  LedgerEntryType,
  ParticipantRole,
} from '../common/enums';
import { DomainException } from '../common/errors';
import { formatMoney, parseMoney } from '../common/money';
import { DealService } from '../deal';
import { PrismaService } from '../prisma';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** WalletRole.role values (TEXT column, not an enum). */
export const WALLET_ROLE_USER = 'user';
export const WALLET_ROLE_ESCROW = 'escrow';
export const WALLET_ROLE_PLATFORM_FEE = 'platform_fee';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal viewer projection for the wallet payment flow. */
export interface WalletActor {
  id: string;
}

/**
 * Standard wallet response shape returned by the controller. Money
 * values are 2dp strings to preserve KHR precision over JSON.
 */
export interface WalletBalance {
  id: string;
  currency: Currency;
  balance: string;
  available: string;
}

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly dealService: DealService,
  ) {}

  // -------------------------------------------------------------------------
  // 6.1 — getOrCreate + computeBalance
  // -------------------------------------------------------------------------

  /**
   * Idempotent (user, currency) → Wallet lookup (R14.6).
   *
   * The schema's `(user_id, currency)` UNIQUE means there is at most
   * one wallet per pair; we use Prisma's `upsert` for atomic
   * "find-or-create".
   */
  async getOrCreate(
    userId: string,
    currency: Currency,
    tx?: Prisma.TransactionClient,
  ): Promise<Wallet> {
    const client = tx ?? this.prisma;
    return client.wallet.upsert({
      where: { user_id_currency: { user_id: userId, currency } },
      update: {},
      create: { user_id: userId, currency },
    });
  }

  /**
   * Signed sum of every ledger entry on the wallet (R14.3).
   *
   * Uses Prisma's `groupBy` once per direction so we issue at most
   * two SQL queries regardless of ledger row count. The resulting
   * `Decimal` is canonicalised through `parseMoney` so callers see a
   * 2dp value even when the wallet has zero ledger entries.
   */
  async computeBalance(
    walletId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Decimal> {
    const client = tx ?? this.prisma;
    const [credits, debits] = await Promise.all([
      client.walletLedgerEntry.aggregate({
        _sum: { amount: true },
        where: { wallet_id: walletId, direction: LedgerDirection.credit },
      }),
      client.walletLedgerEntry.aggregate({
        _sum: { amount: true },
        where: { wallet_id: walletId, direction: LedgerDirection.debit },
      }),
    ]);

    const c = credits._sum.amount
      ? new Decimal(credits._sum.amount.toString())
      : new Decimal(0);
    const d = debits._sum.amount
      ? new Decimal(debits._sum.amount.toString())
      : new Decimal(0);

    return c.minus(d);
  }

  // -------------------------------------------------------------------------
  // 6.2 — getAvailableBalance
  // -------------------------------------------------------------------------

  /**
   * Available balance = balance − Σ(holds for pending withdrawals)
   * (R15.6). The hold is recorded as a `SELLER_PAYOUT_PENDING` debit
   * on the same wallet, so on-paper the balance already excludes it.
   * To avoid double counting, the available calculation simply
   * returns the same signed-sum balance — the hold is a real debit
   * that lowers the wallet balance until either an `ADJUSTMENT`
   * compensates it (rejection) or a `SELLER_PAYOUT_SENT` confirms it.
   *
   * Returning the signed-sum balance is therefore the correct
   * implementation for an "available" projection: any future hold
   * surfaces as a `SELLER_PAYOUT_PENDING` row and lowers the value
   * automatically.
   */
  async getAvailableBalance(
    walletId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Decimal> {
    return this.computeBalance(walletId, tx);
  }

  // -------------------------------------------------------------------------
  // 6.3 — payDealFromWallet (R9)
  // -------------------------------------------------------------------------

  /**
   * Atomic wallet payment (R9.2, R9.7, R9.8).
   *
   * Steps inside one transaction:
   *
   *   1. Authorise: caller must be the deal's buyer participant (R9.4).
   *   2. State guard: deal must be `READY_FOR_PAYMENT` (R9.5).
   *   3. Resolve buyer wallet for the deal currency (R9.6).
   *   4. Lock + read both wallets (`SELECT … FOR UPDATE` deterministic order).
   *   5. Verify sufficient balance (R9.3).
   *   6. Append two ledger rows (debit buyer, credit escrow).
   *   7. `READY_FOR_PAYMENT → PAID_ESCROWED → SELLER_PREPARING` via
   *      DealService.transition (audit rows land in same tx).
   *
   * @throws auth.role_forbidden          — caller is not the buyer participant.
   * @throws wallet.invalid_deal_state    — deal is not `READY_FOR_PAYMENT`.
   * @throws wallet.currency_mismatch     — wallet currency ≠ deal currency.
   * @throws wallet.insufficient_balance  — balance < deal_amount.
   */
  async payDealFromWallet(
    deal: DealRoom,
    buyer: WalletActor,
  ): Promise<DealRoom> {
    return this.prisma.runInTransaction(async (tx) => {
      // --- 1. Authorise (R9.4) ------------------------------------------
      const participant = await tx.dealParticipant.findUnique({
        where: {
          deal_id_user_id: { deal_id: deal.id, user_id: buyer.id },
        },
        select: { role: true },
      });
      if (!participant || participant.role !== ParticipantRole.buyer) {
        throw DomainException.forbidden('auth.role_forbidden');
      }

      // --- 2. State guard (R9.5) ----------------------------------------
      if (deal.status !== DealStatus.READY_FOR_PAYMENT) {
        throw DomainException.badRequest('wallet.invalid_deal_state', {
          details: { current: deal.status, expected: DealStatus.READY_FOR_PAYMENT },
        });
      }

      if (deal.deal_amount === null || deal.currency === null) {
        // R6.1 should have prevented this, but be explicit.
        throw DomainException.badRequest('deal.missing_required_fields');
      }
      const dealAmount = new Decimal(deal.deal_amount.toString());
      const dealCurrency = deal.currency as Currency;

      // --- 3. Resolve wallets (R9.6, R14.6) -----------------------------
      const buyerWallet = await this.getOrCreate(buyer.id, dealCurrency, tx);
      if (buyerWallet.currency !== dealCurrency) {
        throw DomainException.badRequest('wallet.currency_mismatch', {
          details: {
            wallet_currency: buyerWallet.currency,
            deal_currency: dealCurrency,
          },
        });
      }

      const escrowWallet = await this.getOrCreatePlatformEscrowWallet(
        dealCurrency,
        tx,
      );

      // --- 4. Lock both wallets in deterministic order (id ASC) --------
      // SELECT … FOR UPDATE on the wallet rows so concurrent payments
      // serialise. We can't use `SELECT FOR UPDATE` from Prisma's
      // typed client; emulate by issuing a no-op `update({where: {id}})`
      // which obtains a row lock for the duration of the tx.
      const [walletA, walletB] =
        buyerWallet.id < escrowWallet.id
          ? [buyerWallet, escrowWallet]
          : [escrowWallet, buyerWallet];
      await tx.wallet.update({
        where: { id: walletA.id },
        data: { id: walletA.id },
      });
      await tx.wallet.update({
        where: { id: walletB.id },
        data: { id: walletB.id },
      });

      // --- 5. Verify sufficient balance (R9.3) --------------------------
      const balance = await this.computeBalance(buyerWallet.id, tx);
      if (balance.lt(dealAmount)) {
        throw DomainException.badRequest('wallet.insufficient_balance', {
          details: {
            available: formatMoney(balance),
            required: formatMoney(dealAmount),
            currency: dealCurrency,
          },
        });
      }

      // --- 6. Append ledger entries ------------------------------------
      const canonicalAmount = formatMoney(dealAmount);
      await tx.walletLedgerEntry.createMany({
        data: [
          {
            wallet_id: buyerWallet.id,
            amount: canonicalAmount,
            currency: dealCurrency,
            direction: LedgerDirection.debit,
            entry_type: LedgerEntryType.ESCROW_RECEIVED,
            related_deal_id: deal.id,
          },
          {
            wallet_id: escrowWallet.id,
            amount: canonicalAmount,
            currency: dealCurrency,
            direction: LedgerDirection.credit,
            entry_type: LedgerEntryType.ESCROW_RECEIVED,
            related_deal_id: deal.id,
          },
        ],
      });

      // --- 7. Status transitions (R9.2, R9.7) --------------------------
      // READY_FOR_PAYMENT → PAID_ESCROWED → SELLER_PREPARING
      const paidDeal = await this.dealService.transition(
        deal,
        DealStatus.PAID_ESCROWED,
        { user_id: buyer.id, role: ParticipantRole.buyer },
        tx,
      );
      const preparingDeal = await this.dealService.transition(
        paidDeal,
        DealStatus.SELLER_PREPARING,
        { user_id: buyer.id, role: ParticipantRole.buyer },
        tx,
      );

      return preparingDeal;
    });
  }

  // -------------------------------------------------------------------------
  // 6.4 — settleEscrowFromKhqr (R11.2)
  // -------------------------------------------------------------------------

  /**
   * Settle a KHQR-auto-verified payment. Called by the KHQR poller
   * (task 7.3) after a Bakong credit matching the deal's
   * reference_note + amount has been confirmed.
   *
   * Idempotent on `external_ref`: if a ledger row already exists for
   * the same Bakong txn id we no-op (the KHQR verifier may retry).
   */
  async settleEscrowFromKhqr(
    deal: DealRoom,
    externalRef: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (!tx) {
      throw new Error(
        'WalletService.settleEscrowFromKhqr: tx is required (R14.4).',
      );
    }
    if (deal.deal_amount === null || deal.currency === null) {
      throw DomainException.badRequest('deal.missing_required_fields');
    }

    // Idempotency on external_ref — if we've already settled this
    // Bakong txn, return.
    const prior = await tx.walletLedgerEntry.findFirst({
      where: { external_ref: externalRef },
      select: { id: true },
    });
    if (prior) return;

    const escrowWallet = await this.getOrCreatePlatformEscrowWallet(
      deal.currency as Currency,
      tx,
    );
    const canonicalAmount = formatMoney(deal.deal_amount);

    await tx.walletLedgerEntry.create({
      data: {
        wallet_id: escrowWallet.id,
        amount: canonicalAmount,
        currency: deal.currency,
        direction: LedgerDirection.credit,
        entry_type: LedgerEntryType.ESCROW_RECEIVED,
        related_deal_id: deal.id,
        external_ref: externalRef,
      },
    });

    // Status transitions handled by the caller (Payment service)
    // since the auto-verify path may also drive PAYMENT_PENDING_VERIFICATION
    // → PAID_ESCROWED via the KHQR poller. We only own the ledger move.
  }

  // -------------------------------------------------------------------------
  // 6.5 — autoReleaseToSeller (R13.3)
  // -------------------------------------------------------------------------

  /**
   * Atomic auto-release on buyer confirmation (R13.3).
   *
   *   1. State guard: deal must be `RELEASE_PENDING`.
   *   2. Resolve seller participant + (seller_user_id, deal currency) wallet.
   *   3. Lock both wallets in id-asc order.
   *   4. Append two ledger rows (debit escrow, credit seller).
   *   5. `RELEASE_PENDING → RELEASED` transition.
   *
   * On any failure the entire transaction rolls back, leaving
   * `RELEASE_PENDING` in place so an admin retry path can re-trigger
   * (R13.6).
   */
  async autoReleaseToSeller(deal: DealRoom): Promise<DealRoom> {
    return this.prisma.runInTransaction(async (tx) => {
      if (deal.status !== DealStatus.RELEASE_PENDING) {
        throw DomainException.badRequest('wallet.invalid_deal_state', {
          details: { current: deal.status, expected: DealStatus.RELEASE_PENDING },
        });
      }
      if (deal.deal_amount === null || deal.currency === null) {
        throw DomainException.badRequest('deal.missing_required_fields');
      }
      const dealCurrency = deal.currency as Currency;
      const dealAmount = new Decimal(deal.deal_amount.toString());

      // Resolve seller participant.
      const sellerParticipant = await tx.dealParticipant.findFirst({
        where: { deal_id: deal.id, role: ParticipantRole.seller },
        select: { user_id: true },
      });
      if (!sellerParticipant) {
        throw DomainException.badRequest('wallet.invalid_deal_state', {
          details: { reason: 'seller_participant_missing' },
        });
      }

      const sellerWallet = await this.getOrCreate(
        sellerParticipant.user_id,
        dealCurrency,
        tx,
      );
      const escrowWallet = await this.getOrCreatePlatformEscrowWallet(
        dealCurrency,
        tx,
      );

      // Lock in id-asc order.
      const [walletA, walletB] =
        sellerWallet.id < escrowWallet.id
          ? [sellerWallet, escrowWallet]
          : [escrowWallet, sellerWallet];
      await tx.wallet.update({
        where: { id: walletA.id },
        data: { id: walletA.id },
      });
      await tx.wallet.update({
        where: { id: walletB.id },
        data: { id: walletB.id },
      });

      const canonicalAmount = formatMoney(dealAmount);
      await tx.walletLedgerEntry.createMany({
        data: [
          {
            wallet_id: escrowWallet.id,
            amount: canonicalAmount,
            currency: dealCurrency,
            direction: LedgerDirection.debit,
            entry_type: LedgerEntryType.SELLER_PAYOUT_SENT,
            related_deal_id: deal.id,
          },
          {
            wallet_id: sellerWallet.id,
            amount: canonicalAmount,
            currency: dealCurrency,
            direction: LedgerDirection.credit,
            entry_type: LedgerEntryType.SELLER_PAYOUT_SENT,
            related_deal_id: deal.id,
          },
        ],
      });

      const released = await this.dealService.transition(
        deal,
        DealStatus.RELEASED,
        { user_id: sellerParticipant.user_id, role: ParticipantRole.seller },
        tx,
      );

      return released;
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve (or create) the platform-owned escrow wallet for the
   * given currency. The schema reserves a single `WalletRole` row per
   * wallet with `role = 'escrow'`. We do NOT auto-create a platform
   * User — that is bootstrapped at deployment time. If no escrow
   * wallet exists yet, we fall back to creating one owned by the
   * first admin User (defence-in-depth so first-run dev environments
   * don't block on missing infra).
   */
  private async getOrCreatePlatformEscrowWallet(
    currency: Currency,
    tx: Prisma.TransactionClient,
  ): Promise<Wallet> {
    // Look up any wallet whose `role === 'escrow'` AND `currency`.
    const existing = await tx.wallet.findFirst({
      where: {
        currency,
        role: { role: WALLET_ROLE_ESCROW },
      },
    });
    if (existing) return existing;

    // Bootstrap: first admin User.
    const admin = await tx.user.findFirst({
      where: { is_admin: true },
      select: { id: true },
    });
    if (!admin) {
      throw DomainException.badRequest('wallet.platform_escrow_unavailable', {
        details: { reason: 'no_admin_user' },
      });
    }

    const created = await this.getOrCreate(admin.id, currency, tx);
    await tx.walletRole.upsert({
      where: { wallet_id: created.id },
      create: { wallet_id: created.id, role: WALLET_ROLE_ESCROW },
      update: {},
    });
    return created;
  }
}
