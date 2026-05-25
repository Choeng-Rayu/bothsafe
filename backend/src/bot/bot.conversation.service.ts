import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma';
import { BotState, isValidTransition } from './bot.states';

@Injectable()
export class BotConversationService {
  private readonly logger = new Logger(BotConversationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getOrCreate(chatId: string) {
    return this.prisma.botConversation.upsert({
      where: { telegram_chat_id: chatId },
      create: {
        telegram_chat_id: chatId,
        state: BotState.IDLE,
        partial_payload: {},
        retries: 0,
      },
      update: {},
    });
  }

  async update(
    chatId: string,
    newState: BotState,
    payload: Record<string, unknown>,
  ) {
    const current = await this.getOrCreate(chatId);
    const currentState = current.state as BotState;

    if (!isValidTransition(currentState, newState)) {
      this.logger.warn(
        `Invalid transition ${currentState} → ${newState} for chat ${chatId}`,
      );
      throw new Error(
        `Invalid state transition: ${currentState} → ${newState}`,
      );
    }

    return this.prisma.botConversation.update({
      where: { telegram_chat_id: chatId },
      data: {
        state: newState,
        partial_payload: { ...(current.partial_payload as object), ...payload } as any,
      },
    });
  }

  async incrementRetries(chatId: string) {
    return this.prisma.botConversation.update({
      where: { telegram_chat_id: chatId },
      data: { retries: { increment: 1 } },
    });
  }

  async clear(chatId: string) {
    return this.prisma.botConversation.upsert({
      where: { telegram_chat_id: chatId },
      create: {
        telegram_chat_id: chatId,
        state: BotState.IDLE,
        partial_payload: {},
        retries: 0,
      },
      update: {
        state: BotState.IDLE,
        partial_payload: {},
        retries: 0,
      },
    });
  }
}
