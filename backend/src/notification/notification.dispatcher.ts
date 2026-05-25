import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma';
import { InAppAdapter, AdminQueueAdapter, TelegramAdapter } from './adapters';

const MAX_RETRIES = 5;
const BATCH_SIZE = 50;

/** Exponential backoff delays in ms: 1m, 2m, 4m, 8m, 15m */
export const BACKOFF_DELAYS_MS = [60_000, 120_000, 240_000, 480_000, 900_000];

export function getBackoffDelay(attempts: number): number {
  const idx = Math.min(attempts, BACKOFF_DELAYS_MS.length - 1);
  return BACKOFF_DELAYS_MS[idx];
}

@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inApp: InAppAdapter,
    private readonly adminQueue: AdminQueueAdapter,
    private readonly telegram: TelegramAdapter,
  ) {}

  @Cron('*/5 * * * * *')
  async drain(): Promise<void> {
    const now = new Date();
    const rows = await this.prisma.notificationOutboxEntry.findMany({
      where: {
        status: 'pending',
        attempts: { lt: MAX_RETRIES },
      },
      orderBy: { created_at: 'asc' },
      take: BATCH_SIZE,
    });

    for (const row of rows) {
      // Exponential backoff: skip if not enough time has passed since last attempt
      if (row.attempts > 0) {
        const delay = getBackoffDelay(row.attempts - 1);
        const nextRetryAt = new Date(row.created_at.getTime() + delay * row.attempts);
        if (now < nextRetryAt) continue;
      }

      try {
        const adapter = this.resolveAdapter(row.recipient_kind);
        await adapter.send(row);
        await this.prisma.notificationOutboxEntry.update({
          where: { id: row.id },
          data: { status: 'sent', sent_at: now, attempts: row.attempts + 1 },
        });
      } catch (err: any) {
        const newAttempts = row.attempts + 1;
        const status = newAttempts >= MAX_RETRIES ? 'failed' : 'pending';
        await this.prisma.notificationOutboxEntry.update({
          where: { id: row.id },
          data: {
            status,
            attempts: newAttempts,
            last_error: String(err?.message ?? err).slice(0, 500),
          },
        });
        this.logger.warn(
          `Notification dispatch failed: event=${row.event} recipient_kind=${row.recipient_kind} recipient_id=${row.recipient_id} last_error=${err?.message}`,
        );
      }
    }
  }

  private resolveAdapter(recipientKind: string) {
    switch (recipientKind) {
      case 'telegram_chat':
        return this.telegram;
      case 'admin_queue':
        return this.adminQueue;
      default:
        return this.inApp;
    }
  }
}
