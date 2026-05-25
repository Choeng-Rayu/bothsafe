import { Injectable, Logger } from '@nestjs/common';
import { CreatorSource } from '@prisma/client';
import { DealService, CreateDealResult } from '../deal';
import { BotConversationService } from './bot.conversation.service';

const MAX_RETRIES = 3;

@Injectable()
export class BotDealCreator {
  private readonly logger = new Logger(BotDealCreator.name);

  constructor(
    private readonly dealService: DealService,
    private readonly conversationService: BotConversationService,
  ) {}

  /**
   * Creates a deal from the completed conversation payload.
   * Retries up to 3 times on failure without losing partial payload.
   */
  async createFromConversation(
    chatId: string,
    userId: string,
    payload: {
      role: 'buyer' | 'seller';
      title: string;
      amount: string;
      currency: 'USD' | 'KHR';
    },
  ): Promise<CreateDealResult | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await this.dealService.create({
          creatorUserId: userId,
          creatorRole: payload.role,
          creatorSource: CreatorSource.telegram,
          sections: {
            product_title: payload.title,
            deal_amount: payload.amount,
            currency: payload.currency,
          },
        });
        await this.conversationService.clear(chatId);
        return result;
      } catch (err) {
        this.logger.warn(
          `Deal creation attempt ${attempt}/${MAX_RETRIES} failed for chat ${chatId}`,
        );
        await this.conversationService.incrementRetries(chatId);
        if (attempt === MAX_RETRIES) {
          this.logger.error(
            `Deal creation failed after ${MAX_RETRIES} attempts for chat ${chatId}`,
          );
          await this.conversationService.clear(chatId);
          return null;
        }
      }
    }
    return null;
  }
}
