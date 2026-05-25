import { Injectable } from '@nestjs/common';
import type { DealRoom } from '@prisma/client';
import { Decimal } from 'decimal.js';

import { AuditService } from '../audit';
import {
  ALL_DISPUTE_REASONS,
  Currency,
  DealStatus,
  DisputeReason,
  LedgerDirection,
  LedgerEntryType,
  NotificationEvent,
  ParticipantRole,
} from '../common/enums';
import { DomainException } from '../common/errors';
import { formatMoney } from '../common/money';
import { DealService } from '../deal';
import { PrismaService } from '../prisma';
import { WalletService } from '../wallet';

const DISPUTABLE_STATUSES: DealStatus[] = [
  DealStatus.PAYMENT_PENDING_VERIFICATION,
  DealStatus.PAID_ESCROWED,
  DealStatus.SELLER_PREPARING,
  DealStatus.SHIPPED,
];

export interface OpenDisputeInput {
  reason: string;
  message: string;
  evidence_keys?: string[];
}

@Injectable()
export class DisputeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dealService: DealService,
    private readonly walletService: WalletService,
    private readonly auditService: AuditService,
  ) {}

  /** 8.3 — Open a dispute. */
  async openDispute(
    publicId: string,
    userId: string,
    input: OpenDisputeInput,
  ): Promise<{ id: string }> {
    // Validate reason
    if (!ALL_DISPUTE_REASONS.includes(input.reason as DisputeReason)) {
      throw DomainException.badRequest('dispute.invalid_field', {
        details: { field: 'reason', allowed: ALL_DISPUTE_REASONS },
      });
    }

    const trimmed = input.message?.trim() ?? '';
    if (trimmed.length < 10 || trimmed.length > 2000) {
      throw DomainException.badRequest('dispute.invalid_field', {
        details: { field: 'message', min: 10, max: 2000 },
      });
    }

    return this.prisma.runInTransaction(async (tx) => {
      const deal = await tx.dealRoom.findUnique({
        where: { public_id: publicId },
      });
      if (!deal) throw DomainException.notFound('deal.not_found');

      // Participant check
      const participant = await tx.dealParticipant.findUnique({
        where: { deal_id_user_id: { deal_id: deal.id, user_id: userId } },
        select: { role: true },
      });
      if (!participant) {
        throw DomainException.forbidden('auth.role_forbidden');
      }

      if (!DISPUTABLE_STATUSES.includes(deal.status as DealStatus)) {
        throw DomainException.badRequest('dispute.not_allowed_in_status', {
          details: { current: deal.status },
        });
      }

      // Check no active dispute
      const activeDispute = await tx.dispute.findFirst({
        where: { deal_id: deal.id, status: 'open' },
        select: { id: true },
      });
      if (activeDispute) {
        throw DomainException.conflict('dispute.already_open');
      }

      const dispute = await tx.dispute.create({
        data: {
          deal_id: deal.id,
          opener_user_id: userId,
          reason: input.reason as DisputeReason,
          message: trimmed,
          status: 'open',
        },
      });

      // Create evidence rows
      if (input.evidence_keys?.length) {
        await tx.disputeEvidence.createMany({
          data: input.evidence_keys.map((key) => ({
            dispute_id: dispute.id,
            uploader_user_id: userId,
            attachment_key: key,
            attachment_mime: 'application/octet-stream',
          })),
        });
      }

      await this.dealService.transition(
        deal,
        DealStatus.DISPUTED,
        { user_id: userId, role: participant.role as ParticipantRole },
        tx,
      );

      await tx.notificationOutboxEntry.create({
        data: {
          event: NotificationEvent.DISPUTE_OPENED,
          recipient_kind: 'deal_participants',
          recipient_id: null,
          payload: { deal_id: deal.id, dispute_id: dispute.id },
        },
      });

      return { id: dispute.id };
    });
  }

  /** 8.4 — Admin release (dispute resolution). */
  async adminRelease(dealId: string, adminId: string): Promise<void> {
    const deal = await this.prisma.dealRoom.findUnique({ where: { id: dealId } });
    if (!deal) throw DomainException.notFound('deal.not_found');

    if (deal.status !== DealStatus.DISPUTED) {
      throw DomainException.badRequest('deal.invalid_state', {
        details: { current: deal.status },
      });
    }

    // autoReleaseToSeller handles the transition DISPUTED → RELEASED
    // but we need to first transition to RELEASE_PENDING... Actually
    // the state machine allows DISPUTED → RELEASED directly.
    await this.prisma.runInTransaction(async (tx) => {
      const freshDeal = await tx.dealRoom.findUnique({ where: { id: dealId } });
      if (!freshDeal || freshDeal.status !== DealStatus.DISPUTED) {
        throw DomainException.badRequest('deal.invalid_state');
      }

      if (!freshDeal.deal_amount || !freshDeal.currency) {
        throw DomainException.badRequest('deal.missing_required_fields');
      }

      const dealCurrency = freshDeal.currency as Currency;
      const dealAmount = new Decimal(freshDeal.deal_amount.toString());

      const sellerParticipant = await tx.dealParticipant.findFirst({
        where: { deal_id: freshDeal.id, role: ParticipantRole.seller },
        select: { user_id: true },
      });
      if (!sellerParticipant) {
        throw DomainException.badRequest('deal.invalid_state');
      }

      const sellerWallet = await this.walletService.getOrCreate(
        sellerParticipant.user_id,
        dealCurrency,
        tx,
      );
      const escrowWallet = await tx.wallet.findFirst({
        where: { currency: dealCurrency, role: { role: 'escrow' } },
      });
      if (!escrowWallet) {
        throw DomainException.badRequest('wallet.platform_escrow_unavailable');
      }

      const canonicalAmount = formatMoney(dealAmount);
      await tx.walletLedgerEntry.createMany({
        data: [
          {
            wallet_id: escrowWallet.id,
            amount: canonicalAmount,
            currency: dealCurrency,
            direction: LedgerDirection.debit,
            entry_type: LedgerEntryType.SELLER_PAYOUT_SENT,
            related_deal_id: freshDeal.id,
          },
          {
            wallet_id: sellerWallet.id,
            amount: canonicalAmount,
            currency: dealCurrency,
            direction: LedgerDirection.credit,
            entry_type: LedgerEntryType.SELLER_PAYOUT_SENT,
            related_deal_id: freshDeal.id,
          },
        ],
      });

      await this.dealService.transition(
        freshDeal,
        DealStatus.RELEASED,
        { user_id: adminId, role: ParticipantRole.admin },
        tx,
      );

      // Resolve the dispute
      await tx.dispute.updateMany({
        where: { deal_id: freshDeal.id, status: 'open' },
        data: { status: 'resolved', resolution: 'release', resolved_by: adminId, resolved_at: new Date() },
      });

      await this.auditService.record(
        {
          action_type: 'DISPUTE_RESOLVED',
          actor_user_id: adminId,
          actor_role: ParticipantRole.admin,
          deal_id: freshDeal.id,
          metadata: { resolution: 'release' },
        },
        tx,
      );
    });
  }

  /** 8.5 — Admin refund (dispute resolution). */
  async adminRefund(dealId: string, adminId: string): Promise<void> {
    await this.prisma.runInTransaction(async (tx) => {
      const deal = await tx.dealRoom.findUnique({ where: { id: dealId } });
      if (!deal) throw DomainException.notFound('deal.not_found');

      if (
        deal.status !== DealStatus.DISPUTED &&
        deal.status !== DealStatus.PAID_ESCROWED
      ) {
        throw DomainException.badRequest('deal.invalid_state', {
          details: { current: deal.status },
        });
      }

      if (!deal.deal_amount || !deal.currency) {
        throw DomainException.badRequest('deal.missing_required_fields');
      }

      const dealCurrency = deal.currency as Currency;
      const dealAmount = new Decimal(deal.deal_amount.toString());

      const buyerParticipant = await tx.dealParticipant.findFirst({
        where: { deal_id: deal.id, role: ParticipantRole.buyer },
        select: { user_id: true },
      });
      if (!buyerParticipant) {
        throw DomainException.badRequest('deal.invalid_state');
      }

      const buyerWallet = await this.walletService.getOrCreate(
        buyerParticipant.user_id,
        dealCurrency,
        tx,
      );
      const escrowWallet = await tx.wallet.findFirst({
        where: { currency: dealCurrency, role: { role: 'escrow' } },
      });
      if (!escrowWallet) {
        throw DomainException.badRequest('wallet.platform_escrow_unavailable');
      }

      const canonicalAmount = formatMoney(dealAmount);
      await tx.walletLedgerEntry.createMany({
        data: [
          {
            wallet_id: escrowWallet.id,
            amount: canonicalAmount,
            currency: dealCurrency,
            direction: LedgerDirection.debit,
            entry_type: LedgerEntryType.BUYER_REFUND_SENT,
            related_deal_id: deal.id,
          },
          {
            wallet_id: buyerWallet.id,
            amount: canonicalAmount,
            currency: dealCurrency,
            direction: LedgerDirection.credit,
            entry_type: LedgerEntryType.BUYER_REFUND_SENT,
            related_deal_id: deal.id,
          },
        ],
      });

      await this.dealService.transition(
        deal,
        DealStatus.REFUNDED,
        { user_id: adminId, role: ParticipantRole.admin },
        tx,
      );

      // Resolve the dispute if one exists
      await tx.dispute.updateMany({
        where: { deal_id: deal.id, status: 'open' },
        data: { status: 'resolved', resolution: 'refund', resolved_by: adminId, resolved_at: new Date() },
      });

      await tx.notificationOutboxEntry.create({
        data: {
          event: NotificationEvent.REFUND_COMPLETED,
          recipient_kind: 'deal_participants',
          recipient_id: null,
          payload: { deal_id: deal.id },
        },
      });

      await this.auditService.record(
        {
          action_type: 'DISPUTE_RESOLVED',
          actor_user_id: adminId,
          actor_role: ParticipantRole.admin,
          deal_id: deal.id,
          metadata: { resolution: 'refund' },
        },
        tx,
      );
    });
  }
}
