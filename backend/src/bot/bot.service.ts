import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotHandlers, BotMessage } from './bot.handlers';

/**
 * BotService — conditionally starts the Telegram bot if TELEGRAM_BOT_TOKEN is set.
 * Without the token, the module degrades gracefully (no polling, no webhook).
 */
@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);
  private connected = false;

  constructor(
    private readonly config: ConfigService,
    private readonly handlers: BotHandlers,
  ) {}

  async onModuleInit() {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN not set — Telegram bot disabled. Set it to enable bot features.',
      );
      return;
    }

    // Token is available but we don't have telegraf/node-telegram-bot-api installed.
    // Log and skip — the handlers are still callable in-process for testing.
    this.logger.warn(
      'Telegram bot library not installed — bot polling/webhook disabled. Install telegraf or node-telegram-bot-api to enable.',
    );
  }

  /** Whether the bot is connected to Telegram API. */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a message via the Telegram bot (used by TelegramAdapter).
   * Returns false if bot is not connected.
   */
  async sendMessage(chatId: string, text: string): Promise<boolean> {
    if (!this.connected) {
      this.logger.debug(
        `[bot-stub] Would send to ${chatId}: ${text.slice(0, 50)}...`,
      );
      return false;
    }
    // When a real Telegram library is wired, call bot.sendMessage here.
    return false;
  }

  /** Process an incoming message (for testing or webhook integration). */
  async processMessage(msg: BotMessage) {
    const text = msg.text;

    if (text === '/start') return this.handlers.handleStart(msg);
    if (text === '/help') return this.handlers.handleHelp(msg);
    if (text === '/mydeals') return this.handlers.handleMyDeals(msg);
    if (text === '/newdeal') return this.handlers.handleNewDeal(msg);
    if (text === '/cancel') return this.handlers.handleCancel(msg);

    return this.handlers.handleMessage(msg);
  }
}
