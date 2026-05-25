import { Injectable } from '@nestjs/common';
import { type Prisma, type NotificationEvent } from '@prisma/client';

export interface EnqueueInput {
  event: NotificationEvent;
  recipient_kind: string;
  recipient_id?: string | null;
  payload: Record<string, unknown>;
}

@Injectable()
export class NotificationOutboxService {
  async enqueue(
    input: EnqueueInput,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.notificationOutboxEntry.create({
      data: {
        event: input.event,
        recipient_kind: input.recipient_kind,
        recipient_id: input.recipient_id ?? null,
        payload: input.payload as Prisma.InputJsonValue,
      },
    });
  }
}
