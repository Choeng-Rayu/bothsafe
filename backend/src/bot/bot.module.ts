import { Module } from '@nestjs/common';
import { DealModule } from '../deal';
import { BotConversationService } from './bot.conversation.service';
import { BotDealCreator } from './bot.deal-creator';
import { BotHandlers } from './bot.handlers';
import { BotService } from './bot.service';

@Module({
  imports: [DealModule],
  providers: [BotService, BotConversationService, BotHandlers, BotDealCreator],
  exports: [BotService, BotConversationService],
})
export class BotModule {}
