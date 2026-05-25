import { Injectable } from '@nestjs/common';
import type { WithdrawalRequest } from '@prisma/client';
import { Decimal } from 'decimal.js';

import { AuditService } from '../audit';
import {
  ALL_CURRENCIES,
  ALL_WITHDRAWAL_DESTINATIONS,
  Currency,
  LedgerDirection,
  LedgerEntryType,
  NotificationEvent,
  WithdrawalDestination,
  WithdrawalStatus,
} from '../common/enums';
import { DomainException } from '../common/errors';
import { formatMoney } from '../common/money';
import { PrismaService } from '../prisma';
import { WalletService } from '../wallet';

export interface CreateWithdrawalInput {
  amount: string;
  currency: string;
  destination_type: string;
  khqr_string?: string | null;
  khqr_image_key?: string | null;
  bank_name?: string | null;
  bank_account_name?: string | null;
  bank_account_number?: string | null;
}

export interface ApproveWithdrawalInput {
  payout_reference: string;
  admin_note?: string | null;
}

export interface RejectWithdrawalInput {
  reason: string;
}

@Injectable()
export class WithdrawalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly auditService: AuditService,
  ) {}

  /** 9.1 — Create withdrawal request with hold. */
  async create(
    sellerId: string,
    input: CreateWithdrawalInput,
  ): Promise<WithdrawalRequest> {
    // Validate currency
    if (!ALL_CURRENCIES.includes(input.currency as Currency)) {
      throw DomainException.badRequest('withdrawal.invalid_field', {
        details: { field: 'currency' },
      });
    }

    // Validate amount
    const amount = new Decimal(input.amount || '0');
    if (amount.lt('0.01') || amount.gt('999999999.99') || amount.dp() > 2) {
      throw DomainException.badRequest('withdrawal.invalid_field', {
        details: { field: 'amount' },
      });
    }

    // Validate destination_type
    if (!ALL_WITHDRAWAL_DESTINATIONS.includes(input.destination_type as WithdrawalDestination)) {
      throw DomainException.badRequest('withdrawal.invalid_field', {
        details: { field: 'destination_type', allowed: ALL_WITHDRAWAL_DESTINATIONS },
      });
    }

    const destType = input.destination_type as WithdrawalDestination;

    // Validate destination fields
    if (destType === WithdrawalDestination.khqr) {
      if (!input.khqr_string && !input.khqr_image_key) {
        throw DomainException.badRequest('withdrawal.invalid_field', {
          details: { field: 'khqr_string or khqr_image_key required' },
        });
      }
      if (input.khqr_string && (input.khqr_string.length < 10 || input.khqr_string.length > 512)) {
        throw DomainException.badRequest('withdrawal.invalid_field', {
          details: { field: 'khqr_string', min: 10, max: 512 },
        });
      }
    } else if (destType === WithdrawalDestination.bank) {
      if (
        !input.bank_name || input.bank_name.length < 1 || input.bank_name.length > 100 ||
        !input.bank_account_name || input.bank_account_name.length < 1 || input.bank_account_name.length > 100 ||
        !input.bank_account_number || input.bank_account_number.length < 5 || input.bank_account_number.length > 34
      ) {
        throw DomainException.badRequest('withdrawal.invalid_field', {
          details: { field: 'bank fields' },
        });
      }
      // Alphanumeric check
      if (!/^[a-zA-Z0-9]+$/.test(input.bank_account_number)) {
        throw DomainException.badRequest('withdrawal.invalid_field', {
          details: { field: 'bank_account_number', reason: 'must be alphanumeric' },
        });
      }
    }

    const currency = input.currency as Currency;

    return this.prisma.runInTransaction(async (tx) => {
      const wallet = await this.walletService.getOrCreate(sellerId, currency, tx);
      const available = await this.walletService.getAvailableBalance(wallet.id, tx);

      if (available.lt(amount)) {
        throw DomainException.badRequest('wallet.insufficient_balance', {
          details: {
            available: formatMoney(available),
            required: formatMoney(amount),
            currency,
          },
        });
      }

      const canonicalAmount = formatMoney(amount);

      const withdrawal = await tx.withdrawalRequest.create({
        data: {
          seller_user_id: sellerId,
          wallet_id: wallet.id,
          amount: canonicalAmount,
          currency,
          destination_type: destType,
          khqr_string: destType === WithdrawalDestination.khqr ? (input.khqr_string ?? null) : null,
          khqr_image_key: destType === WithdrawalDestination.khqr ? (input.khqr_image_key ?? null) : null,
          bank_name: destType === WithdrawalDestination.bank ? input.bank_name! : null,
          bank_account_name: destType === WithdrawalDestination.bank ? input.bank_account_name! : null,
          bank_account_number: destType === WithdrawalDestination.bank ? input.bank_account_number! : null,
          status: WithdrawalStatus.pending_admin_review,
        },
      });

      // Write SELLER_PAYOUT_PENDING hold
      await tx.walletLedgerEntry.create({
        data: {
          wallet_id: wallet.id,
          amount: canonicalAmount,
          currency,
          direction: LedgerDirection.debit,
          entry_type: LedgerEntryType.SELLER_PAYOUT_PENDING,
          related_withdrawal_id: withdrawal.id,
        },
      });

      await this.auditService.record(
        {
          action_type: 'WITHDRAWAL_HOLD',
          actor_user_id: sellerId,
          deal_id: null,
          metadata: { withdrawal_id: withdrawal.id, amount: canonicalAmount, currency },
        },
        tx,
      );

      await tx.notificationOutboxEntry.create({
        data: {
          event: NotificationEvent.WITHDRAWAL_REQUESTED,
          recipient_kind: 'admin',
          recipient_id: null,
          payload: {
            withdrawal_id: withdrawal.id,
            seller_user_id: sellerId,
            amount: canonicalAmount,
            currency,
            destination_type: destType,
          },
        },
      });

      return withdrawal;
    });
  }

  /** 9.2 — List seller's withdrawals. */
  async listForSeller(sellerId: string): Promise<WithdrawalRequest[]> {
    return this.prisma.withdrawalRequest.findMany({
      where: { seller_user_id: sellerId },
      orderBy: { created_at: 'desc' },
    });
  }

  /** 9.2 — Get single withdrawal (owner only). */
  async getForSeller(id: string, sellerId: string): Promise<WithdrawalRequest> {
    const w = await this.prisma.withdrawalRequest.findUnique({ where: { id } });
    if (!w || w.seller_user_id !== sellerId) {
      throw DomainException.notFound('withdrawal.not_found');
    }
    return w;
  }

  /** 9.3 — Admin list withdrawals. */
  async adminList(status?: string, limit = 50, cursor?: string): Promise<WithdrawalRequest[]> {
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    return this.prisma.withdrawalRequest.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: Math.min(limit, 50),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  }

  /** 9.3 — Admin get single withdrawal. */
  async adminGet(id: string): Promise<WithdrawalRequest> {
    const w = await this.prisma.withdrawalRequest.findUnique({ where: { id } });
    if (!w) throw DomainException.notFound('withdrawal.not_found');
    return w;
  }

  /** 9.4 — Admin approve (idempotent). */
  async adminApprove(
    id: string,
    adminId: string,
    input: ApproveWithdrawalInput,
  ): Promise<void> {
    await this.prisma.runInTransaction(async (tx) => {
      const w = await tx.withdrawalRequest.findUnique({ where: { id } });
      if (!w) throw DomainException.notFound('withdrawal.not_found');

      // Idempotent
      if (w.status === WithdrawalStatus.paid) return;

      if (w.status !== WithdrawalStatus.pending_admin_review) {
        throw DomainException.badRequest('withdrawal.invalid_status', {
          details: { current: w.status },
        });
      }

      await tx.withdrawalRequest.update({
        where: { id },
        data: {
          status: WithdrawalStatus.paid,
          payout_reference: input.payout_reference,
          admin_note: input.admin_note ?? null,
          reviewed_by: adminId,
          reviewed_at: new Date(),
        },
      });

      // Write SELLER_PAYOUT_SENT ledger entry
      await tx.walletLedgerEntry.create({
        data: {
          wallet_id: w.wallet_id,
          amount: formatMoney(w.amount),
          currency: w.currency,
          direction: LedgerDirection.debit,
          entry_type: LedgerEntryType.SELLER_PAYOUT_SENT,
          related_withdrawal_id: w.id,
          external_ref: input.payout_reference,
        },
      });

      await this.auditService.record(
        {
          action_type: 'WITHDRAWAL_PAYOUT',
          actor_user_id: adminId,
          actor_role: 'admin',
          deal_id: null,
          metadata: {
            withdrawal_id: w.id,
            payout_reference: input.payout_reference,
          },
        },
        tx,
      );

      await tx.notificationOutboxEntry.create({
        data: {
          event: NotificationEvent.WITHDRAWAL_PAID,
          recipient_kind: 'user',
          recipient_id: w.seller_user_id,
          payload: { withdrawal_id: w.id },
        },
      });
    });
  }

  /** 9.5 — Admin reject (idempotent). */
  async adminReject(
    id: string,
    adminId: string,
    input: RejectWithdrawalInput,
  ): Promise<void> {
    if (!input.reason || input.reason.length < 1 || input.reason.length > 500) {
      throw DomainException.badRequest('withdrawal.invalid_field', {
        details: { field: 'reason', min: 1, max: 500 },
      });
    }

    await this.prisma.runInTransaction(async (tx) => {
      const w = await tx.withdrawalRequest.findUnique({ where: { id } });
      if (!w) throw DomainException.notFound('withdrawal.not_found');

      // Idempotent
      if (w.status === WithdrawalStatus.rejected) return;

      if (w.status !== WithdrawalStatus.pending_admin_review) {
        throw DomainException.badRequest('withdrawal.invalid_status', {
          details: { current: w.status },
        });
      }

      await tx.withdrawalRequest.update({
        where: { id },
        data: {
          status: WithdrawalStatus.rejected,
          rejection_reason: input.reason,
          reviewed_by: adminId,
          reviewed_at: new Date(),
        },
      });

      // Compensating ADJUSTMENT credit (release the hold)
      await tx.walletLedgerEntry.create({
        data: {
          wallet_id: w.wallet_id,
          amount: formatMoney(w.amount),
          currency: w.currency,
          direction: LedgerDirection.credit,
          entry_type: LedgerEntryType.ADJUSTMENT,
          related_withdrawal_id: w.id,
        },
      });

      await this.auditService.record(
        {
          action_type: 'WITHDRAWAL_REJECTED',
          actor_user_id: adminId,
          actor_role: 'admin',
          deal_id: null,
          metadata: { withdrawal_id: w.id, reason: input.reason },
        },
        tx,
      );

      await tx.notificationOutboxEntry.create({
        data: {
          event: NotificationEvent.WITHDRAWAL_REJECTED,
          recipient_kind: 'user',
          recipient_id: w.seller_user_id,
          payload: { withdrawal_id: w.id, reason: input.reason },
        },
      });
    });
  }
}
