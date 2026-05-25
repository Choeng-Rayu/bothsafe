import { Injectable } from '@nestjs/common';
import type { DealRoom, Prisma } from '@prisma/client';
import { Decimal } from 'decimal.js';

import { AuditService } from '../audit';
import {
  Currency,
  DealStatus,
  LedgerDirection,
  LedgerEntryType,
  NotificationEvent,
  ParticipantRole,
} from '../common/enums';
import { DomainException } from '../common/errors';
import { formatMoney } from '../common/money';
import { DealService } from '../deal';
import { KhqrGenerator } from '../khqr';
import { PrismaService } from '../prisma';
import { WalletService } from '../wallet';

export interface GenerateKhqrResult {
  khqr_string: string;
  khqr_image_url: string | null;
  reference_note: string;
  amount_due: string;
  currency: string;
}

export interface SubmitReceiptInput {
  paid_amount?: string | null;
  buyer_note?: string | null;
  attachment_key?: string | null;
}

@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dealService: DealService,
    private readonly walletService: WalletService,
    private readonly khqrGenerator: KhqrGenerator,
    private readonly auditService: AuditService,
  ) {}

  /** 7.4 — Pay from wallet (delegates to WalletService). */
  async payFromWallet(publicId: string, buyerId: string): Promise<DealRoom> {
    const deal = await this.prisma.dealRoom.findUnique({
      where: { public_id: publicId },
    });
    if (!deal) throw DomainException.notFound('deal.not_found');
    return this.walletService.payDealFromWallet(deal, { id: buyerId });
  }

  /** 7.5 — Generate KHQR for a deal. */
  async generateKhqr(publicId: string, buyerId: string): Promise<GenerateKhqrResult> {
    const deal = await this.prisma.dealRoom.findUnique({
      where: { public_id: publicId },
    });
    if (!deal) throw DomainException.notFound('deal.not_found');

    // Buyer role check
    const participant = await this.prisma.dealParticipant.findUnique({
      where: { deal_id_user_id: { deal_id: deal.id, user_id: buyerId } },
      select: { role: true },
    });
    if (!participant || participant.role !== ParticipantRole.buyer) {
      throw DomainException.forbidden('auth.role_forbidden');
    }

    if (deal.status !== DealStatus.READY_FOR_PAYMENT) {
      throw DomainException.badRequest('payment.invalid_state', {
        details: { current: deal.status },
      });
    }
    if (!deal.deal_amount || !deal.currency) {
      throw DomainException.badRequest('deal.missing_required_fields');
    }

    const amount = formatMoney(deal.deal_amount);
    const receiver = process.env.BAKONG_ACCOUNT_ID ?? 'bothsafe@bakong';

    const result = await this.khqrGenerator.generate({
      amount,
      currency: deal.currency,
      receiver,
    });

    // Cache on deal (store md5 for KhqrVerifier.verifyByReferenceNote)
    await this.prisma.dealRoom.update({
      where: { id: deal.id },
      data: {
        reference_note: result.referenceNote,
        khqr_payload_meta: {
          khqr_string: result.khqrString,
          md5: (result as { md5?: string }).md5 ?? null,
          generated_at: new Date().toISOString(),
        },
      },
    });

    // Encode the real PNG as a base64 data URL so the frontend can
    // render it as <img src="data:image/png;base64,..."> without needing
    // MinIO for MVP.
    const pngDataUrl = result.pngBuffer
      ? `data:image/png;base64,${result.pngBuffer.toString('base64')}`
      : null;

    return {
      khqr_string: result.khqrString,
      khqr_image_url: pngDataUrl,
      reference_note: result.referenceNote,
      amount_due: amount,
      currency: deal.currency,
    };
  }

  /** 7.6 — Submit KHQR receipt. */
  async submitReceipt(
    publicId: string,
    buyerId: string,
    input: SubmitReceiptInput,
  ): Promise<{ id: string }> {
    if (!input.paid_amount && !input.attachment_key) {
      throw DomainException.badRequest('payment.empty_receipt');
    }

    return this.prisma.runInTransaction(async (tx) => {
      const deal = await tx.dealRoom.findUnique({
        where: { public_id: publicId },
      });
      if (!deal) throw DomainException.notFound('deal.not_found');

      const participant = await tx.dealParticipant.findUnique({
        where: { deal_id_user_id: { deal_id: deal.id, user_id: buyerId } },
        select: { role: true },
      });
      if (!participant || participant.role !== ParticipantRole.buyer) {
        throw DomainException.forbidden('auth.role_forbidden');
      }

      if (deal.status !== DealStatus.READY_FOR_PAYMENT) {
        throw DomainException.badRequest('payment.invalid_state', {
          details: { current: deal.status },
        });
      }

      const proof = await tx.paymentProof.create({
        data: {
          deal_id: deal.id,
          buyer_user_id: buyerId,
          paid_amount: input.paid_amount ?? undefined,
          buyer_note: input.buyer_note ?? undefined,
          attachment_key: input.attachment_key ?? undefined,
        },
      });

      await this.dealService.transition(
        deal,
        DealStatus.PAYMENT_PENDING_VERIFICATION,
        { user_id: buyerId, role: ParticipantRole.buyer },
        tx,
      );

      await tx.notificationOutboxEntry.create({
        data: {
          event: NotificationEvent.PAYMENT_PROOF_UPLOADED,
          recipient_kind: 'admin',
          recipient_id: null,
          payload: { deal_id: deal.id, payment_proof_id: proof.id },
        },
      });

      return { id: proof.id };
    });
  }

  /** 7.7 — Admin verify payment proof. */
  async adminVerifyProof(proofId: string, adminId: string): Promise<void> {
    await this.prisma.runInTransaction(async (tx) => {
      const proof = await tx.paymentProof.findUnique({
        where: { id: proofId },
        include: { deal: true },
      });
      if (!proof) throw DomainException.notFound('payment.proof_not_found');

      const deal = proof.deal;
      if (deal.status !== DealStatus.PAYMENT_PENDING_VERIFICATION) {
        throw DomainException.badRequest('payment.invalid_state', {
          details: { current: deal.status },
        });
      }

      if (!deal.deal_amount || !deal.currency) {
        throw DomainException.badRequest('deal.missing_required_fields');
      }

      // Write ESCROW_RECEIVED ledger entry
      const escrowWallet = await this.walletService.getOrCreate(
        adminId,
        deal.currency as Currency,
        tx,
      );
      // Use the platform escrow wallet lookup pattern
      const escrow = await tx.wallet.findFirst({
        where: { currency: deal.currency as Currency, role: { role: 'escrow' } },
      });
      const escrowWalletId = escrow?.id ?? escrowWallet.id;

      const canonicalAmount = formatMoney(deal.deal_amount);
      await tx.walletLedgerEntry.create({
        data: {
          wallet_id: escrowWalletId,
          amount: canonicalAmount,
          currency: deal.currency as Currency,
          direction: LedgerDirection.credit,
          entry_type: LedgerEntryType.ESCROW_RECEIVED,
          related_deal_id: deal.id,
        },
      });

      // Transition PAYMENT_PENDING_VERIFICATION → PAID_ESCROWED → SELLER_PREPARING
      const paidDeal = await this.dealService.transition(
        deal,
        DealStatus.PAID_ESCROWED,
        { user_id: adminId, role: ParticipantRole.admin },
        tx,
      );
      await this.dealService.transition(
        paidDeal,
        DealStatus.SELLER_PREPARING,
        { user_id: adminId, role: ParticipantRole.admin },
        tx,
      );

      await this.auditService.record(
        {
          action_type: 'PAYMENT_VERIFIED',
          actor_user_id: adminId,
          actor_role: ParticipantRole.admin,
          deal_id: deal.id,
          metadata: { payment_proof_id: proofId },
        },
        tx,
      );
    });
  }

  /** 7.7 — Admin reject payment proof. */
  async adminRejectProof(
    proofId: string,
    adminId: string,
    reason: string,
  ): Promise<void> {
    if (!reason || reason.length < 1 || reason.length > 500) {
      throw DomainException.badRequest('payment.invalid_reason');
    }

    await this.prisma.runInTransaction(async (tx) => {
      const proof = await tx.paymentProof.findUnique({
        where: { id: proofId },
        include: { deal: true },
      });
      if (!proof) throw DomainException.notFound('payment.proof_not_found');

      const deal = proof.deal;
      if (deal.status !== DealStatus.PAYMENT_PENDING_VERIFICATION) {
        throw DomainException.badRequest('payment.invalid_state', {
          details: { current: deal.status },
        });
      }

      await this.dealService.transition(
        deal,
        DealStatus.READY_FOR_PAYMENT,
        { user_id: adminId, role: ParticipantRole.admin },
        tx,
      );

      await tx.notificationOutboxEntry.create({
        data: {
          event: NotificationEvent.PAYMENT_REJECTED,
          recipient_kind: 'deal_participants',
          recipient_id: null,
          payload: { deal_id: deal.id, reason },
        },
      });

      await this.auditService.record(
        {
          action_type: 'PAYMENT_REJECTED',
          actor_user_id: adminId,
          actor_role: ParticipantRole.admin,
          deal_id: deal.id,
          metadata: { payment_proof_id: proofId, reason },
        },
        tx,
      );
    });
  }
}
