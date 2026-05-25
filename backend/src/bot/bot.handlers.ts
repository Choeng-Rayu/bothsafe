import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma';
import { BotConversationService } from './bot.conversation.service';
import { BotDealCreator } from './bot.deal-creator';
import { BotState } from './bot.states';

/** Minimal message shape for handler methods (decoupled from any Telegram lib). */
export interface BotMessage {
  chatId: string;
  text: string;
  userId?: string;
}

export interface BotReply {
  text: string;
  buttons?: Array<{ text: string; data?: string }>;
}

@Injectable()
export class BotHandlers {
  private readonly logger = new Logger(BotHandlers.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversationService: BotConversationService,
    private readonly dealCreator: BotDealCreator,
  ) {}

  async handleStart(_msg: BotMessage): Promise<BotReply> {
    return {
      text: '🛡️ Welcome to BothSafe!\n\nI help you create secure escrow deals for online transactions.\n\nUse /newdeal to create a deal, or /help for more info.',
      buttons: [
        { text: '➕ New Deal', data: '/newdeal' },
        { text: '📋 My Deals', data: '/mydeals' },
        { text: '❓ Help', data: '/help' },
      ],
    };
  }

  async handleHelp(_msg: BotMessage): Promise<BotReply> {
    return {
      text: [
        '📖 BothSafe Bot Commands:',
        '',
        '/newdeal — Create a new escrow deal',
        '/mydeals — View your recent deals',
        '/cancel — Cancel current operation',
        '/help — Show this message',
        '',
        'Share deal links in your chats for safe transactions!',
      ].join('\n'),
    };
  }

  async handleMyDeals(msg: BotMessage): Promise<BotReply> {
    if (!msg.userId) {
      return { text: '⚠️ Please link your Telegram account first.' };
    }

    const deals = await this.prisma.dealRoom.findMany({
      where: {
        participants: { some: { user_id: msg.userId } },
      },
      orderBy: { created_at: 'desc' },
      take: 5,
      select: {
        public_id: true,
        product_title: true,
        deal_amount: true,
        currency: true,
        status: true,
      },
    });

    if (deals.length === 0) {
      return { text: '📭 No deals found. Use /newdeal to create one!' };
    }

    const lines = deals.map(
      (d, i) =>
        `${i + 1}. ${d.product_title ?? 'Untitled'} — ${d.deal_amount} ${d.currency ?? ''} [${d.status}]`,
    );
    return { text: `📋 Your recent deals:\n\n${lines.join('\n')}` };
  }

  async handleNewDeal(msg: BotMessage): Promise<BotReply> {
    await this.conversationService.getOrCreate(msg.chatId);
    await this.conversationService.update(
      msg.chatId,
      BotState.COLLECTING_ROLE,
      {},
    );
    return {
      text: '🆕 Creating a new deal.\n\nAre you the buyer or seller?',
      buttons: [
        { text: '🛒 Buyer', data: 'role:buyer' },
        { text: '🏪 Seller', data: 'role:seller' },
      ],
    };
  }

  async handleCancel(msg: BotMessage): Promise<BotReply> {
    await this.conversationService.clear(msg.chatId);
    return { text: '❌ Operation cancelled. Use /newdeal to start again.' };
  }

  async handleMessage(msg: BotMessage): Promise<BotReply | null> {
    const conv = await this.conversationService.getOrCreate(msg.chatId);
    const state = conv.state as BotState;

    switch (state) {
      case BotState.COLLECTING_ROLE:
        return this.collectRole(msg);
      case BotState.COLLECTING_TITLE:
        return this.collectTitle(msg);
      case BotState.COLLECTING_AMOUNT:
        return this.collectAmount(msg);
      case BotState.COLLECTING_CURRENCY:
        return this.collectCurrency(msg);
      case BotState.CONFIRMING:
        return this.handleConfirm(msg);
      default:
        return null;
    }
  }

  private async collectRole(msg: BotMessage): Promise<BotReply> {
    const role = msg.text.toLowerCase().replace('role:', '');
    if (role !== 'buyer' && role !== 'seller') {
      return {
        text: '⚠️ Please choose buyer or seller.',
        buttons: [
          { text: '🛒 Buyer', data: 'role:buyer' },
          { text: '🏪 Seller', data: 'role:seller' },
        ],
      };
    }
    await this.conversationService.update(msg.chatId, BotState.COLLECTING_TITLE, { role });
    return { text: '📝 What is the product title?' };
  }

  private async collectTitle(msg: BotMessage): Promise<BotReply> {
    const title = msg.text.trim();
    if (!title || title.length < 2) {
      return { text: '⚠️ Please enter a valid product title (at least 2 characters).' };
    }
    await this.conversationService.update(msg.chatId, BotState.COLLECTING_AMOUNT, { title });
    return { text: '💰 Enter the deal amount (e.g. 25.00):' };
  }

  private async collectAmount(msg: BotMessage): Promise<BotReply> {
    const amount = msg.text.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
      return { text: '⚠️ Please enter a valid amount (e.g. 25.00).' };
    }
    await this.conversationService.update(msg.chatId, BotState.COLLECTING_CURRENCY, { amount });
    return {
      text: '💱 Choose currency:',
      buttons: [
        { text: '🇺🇸 USD', data: 'USD' },
        { text: '🇰🇭 KHR', data: 'KHR' },
      ],
    };
  }

  private async collectCurrency(msg: BotMessage): Promise<BotReply> {
    const currency = msg.text.toUpperCase();
    if (currency !== 'USD' && currency !== 'KHR') {
      return {
        text: '⚠️ Please choose USD or KHR.',
        buttons: [
          { text: '🇺🇸 USD', data: 'USD' },
          { text: '🇰🇭 KHR', data: 'KHR' },
        ],
      };
    }
    await this.conversationService.update(msg.chatId, BotState.CONFIRMING, { currency });
    const conv = await this.conversationService.getOrCreate(msg.chatId);
    const p = conv.partial_payload as Record<string, string>;
    return {
      text: [
        '✅ Please confirm your deal:',
        '',
        `Role: ${p.role}`,
        `Title: ${p.title}`,
        `Amount: ${p.amount} ${p.currency}`,
        '',
        'Type "yes" to confirm or /cancel to abort.',
      ].join('\n'),
      buttons: [
        { text: '✅ Confirm', data: 'yes' },
        { text: '❌ Cancel', data: '/cancel' },
      ],
    };
  }

  private async handleConfirm(msg: BotMessage): Promise<BotReply> {
    if (msg.text.toLowerCase() !== 'yes') {
      return { text: 'Type "yes" to confirm or /cancel to abort.' };
    }
    if (!msg.userId) {
      await this.conversationService.clear(msg.chatId);
      return { text: '⚠️ Please link your Telegram account to create deals.' };
    }

    const conv = await this.conversationService.getOrCreate(msg.chatId);
    const p = conv.partial_payload as Record<string, string>;

    const result = await this.dealCreator.createFromConversation(
      msg.chatId,
      msg.userId,
      {
        role: p.role as 'buyer' | 'seller',
        title: p.title,
        amount: p.amount,
        currency: p.currency as 'USD' | 'KHR',
      },
    );

    if (!result) {
      return { text: '❌ Failed to create deal. Please try again with /newdeal.' };
    }

    return {
      text: [
        '🎉 Deal created successfully!',
        '',
        `Your link: ${result.rawCreatorAccessToken}`,
        `Invite link: ${result.rawInviteToken}`,
        '',
        'Share the invite link with the other party.',
      ].join('\n'),
    };
  }
}
