import { Injectable } from '@nestjs/common';
import {
  DealStatus,
  NotificationEvent,
  ParticipantRole,
} from '../common/enums';
import { DomainException } from '../common/errors';
import { DealService } from '../deal';
import { PrismaService } from '../prisma';
import { WalletService } from '../wallet';

@Injectable()
export class ConfirmationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dealService: DealService,
    private readonly walletService: WalletService,
  ) {}

  /**
   * Buyer confirms receipt. Idempotent — if Confirmation already exists,
   * returns 200 without re-releasing.
   */
  async confirmReceived(
    publicId: string,
    buyerId: string,
    idempotencyKey: string,
  ): Promise<{ already_confirmed: boolean }> {
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

      // Idempotency: check if already confirmed
      const existing = await tx.confirmation.findUnique({
        where: { deal_id: deal.id },
      });
      if (existing) {
        return { already_confirmed: true };
      }

      if (deal.status !== DealStatus.SHIPPED) {
        throw DomainException.badRequest('confirmation.invalid_state', {
          details: { current: deal.status },
        });
      }

      await tx.confirmation.create({
        data: {
          deal_id: deal.id,
          buyer_user_id: buyerId,
          idempotency_key: idempotencyKey,
        },
      });

      const releasePending = await this.dealService.transition(
        deal,
        DealStatus.RELEASE_PENDING,
        { user_id: buyerId, role: ParticipantRole.buyer },
        tx,
      );

      await tx.notificationOutboxEntry.create({
        data: {
          event: NotificationEvent.BUYER_CONFIRMED,
          recipient_kind: 'deal_participants',
          recipient_id: null,
          payload: { deal_id: deal.id },
        },
      });

      return { already_confirmed: false };
    }).then(async (result) => {
      if (!result.already_confirmed) {
        // Auto-release outside the confirmation tx (separate tx in WalletService)
        const deal = await this.prisma.dealRoom.findUnique({
          where: { public_id: publicId },
        });
        if (deal && deal.status === DealStatus.RELEASE_PENDING) {
          try {
            await this.walletService.autoReleaseToSeller(deal);
          } catch {
            // R13.6 — leave at RELEASE_PENDING for admin retry
          }
        }
      }
      return result;
    });
  }
}
