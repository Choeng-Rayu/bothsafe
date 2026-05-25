import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { NotificationOutboxEntry } from '@prisma/client';

export interface NotificationAdapter {
  send(entry: NotificationOutboxEntry): Promise<void>;
}

@Injectable()
export class InAppAdapter implements NotificationAdapter {
  private readonly logger = new Logger(InAppAdapter.name);

  async send(entry: NotificationOutboxEntry): Promise<void> {
    this.logger.debug(`[in-app] event=${entry.event} recipient=${entry.recipient_id}`);
  }
}

@Injectable()
export class AdminQueueAdapter implements NotificationAdapter {
  private readonly logger = new Logger(AdminQueueAdapter.name);

  async send(entry: NotificationOutboxEntry): Promise<void> {
    this.logger.debug(`[admin-queue] event=${entry.event}`);
  }
}

/** Token for optional BotService injection (avoids circular dep). */
export const BOT_SERVICE_TOKEN = 'BOT_SERVICE_TOKEN';

@Injectable()
export class TelegramAdapter implements NotificationAdapter {
  private readonly logger = new Logger(TelegramAdapter.name);

  constructor(
    @Optional() @Inject(BOT_SERVICE_TOKEN) private readonly botService?: { sendMessage(chatId: string, text: string): Promise<boolean>; isConnected(): boolean } | null,
  ) {}

  async send(entry: NotificationOutboxEntry): Promise<void> {
    if (this.botService?.isConnected() && entry.recipient_id) {
      await this.botService.sendMessage(
        entry.recipient_id,
        `[${entry.event}] Notification for your deal.`,
      );
      return;
    }
    this.logger.debug(`[telegram-stub] event=${entry.event} recipient=${entry.recipient_id}`);
  }
}
