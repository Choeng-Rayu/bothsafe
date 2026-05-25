import { Injectable } from '@nestjs/common';
import {
  DealStatus,
  NotificationEvent,
  ParticipantRole,
} from '../common/enums';
import { DomainException } from '../common/errors';
import { DealService } from '../deal';
import { PrismaService } from '../prisma';

export interface SubmitShippingProofInput {
  delivery_company?: string | null;
  tracking_number?: string | null;
  package_photo_key?: string | null;
  delivery_receipt_key?: string | null;
  seller_note?: string | null;
}

@Injectable()
export class ShippingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dealService: DealService,
  ) {}

  async submitProof(
    publicId: string,
    sellerId: string,
    input: SubmitShippingProofInput,
  ): Promise<{ id: string }> {
    if (
      !input.delivery_company &&
      !input.tracking_number &&
      !input.package_photo_key &&
      !input.delivery_receipt_key
    ) {
      throw DomainException.badRequest('shipping.empty_proof');
    }

    return this.prisma.runInTransaction(async (tx) => {
      const deal = await tx.dealRoom.findUnique({
        where: { public_id: publicId },
      });
      if (!deal) throw DomainException.notFound('deal.not_found');

      const participant = await tx.dealParticipant.findUnique({
        where: { deal_id_user_id: { deal_id: deal.id, user_id: sellerId } },
        select: { role: true },
      });
      if (!participant || participant.role !== ParticipantRole.seller) {
        throw DomainException.forbidden('auth.role_forbidden');
      }

      if (deal.status !== DealStatus.SELLER_PREPARING) {
        throw DomainException.badRequest('shipping.invalid_state', {
          details: { current: deal.status },
        });
      }

      const proof = await tx.shippingProof.create({
        data: {
          deal_id: deal.id,
          seller_user_id: sellerId,
          delivery_company: input.delivery_company ?? undefined,
          tracking_number: input.tracking_number ?? undefined,
          package_photo_key: input.package_photo_key ?? undefined,
          delivery_receipt_key: input.delivery_receipt_key ?? undefined,
          seller_note: input.seller_note ?? undefined,
        },
      });

      await this.dealService.transition(
        deal,
        DealStatus.SHIPPED,
        { user_id: sellerId, role: ParticipantRole.seller },
        tx,
      );

      await tx.notificationOutboxEntry.create({
        data: {
          event: NotificationEvent.SHIPPING_UPLOADED,
          recipient_kind: 'deal_participants',
          recipient_id: null,
          payload: { deal_id: deal.id, shipping_proof_id: proof.id },
        },
      });

      return { id: proof.id };
    });
  }
}
