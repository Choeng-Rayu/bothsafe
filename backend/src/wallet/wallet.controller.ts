/**
 * WalletController — `GET /v1/wallet/me` + ledger paging (task 6.6).
 *
 * Source of truth: tasks.md §6.6; design.md §"API Surface → Wallet";
 * R14.1, R14.3.
 *
 *   - `GET /v1/wallet/me` returns the authenticated user's wallets
 *     (one row per currency) with `balance` and `available` as
 *     2-decimal money strings.
 *   - `GET /v1/wallet/me/ledger?currency=USD&cursor=...&limit=...`
 *     returns the user's ledger rows for the given currency, ordered
 *     by `(created_at DESC, id DESC)` with cursor-based pagination.
 */

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Decimal } from 'decimal.js';

import { AuthGuard, CurrentUser, type AuthenticatedUser } from '../auth';
import { ALL_CURRENCIES, type Currency } from '../common/enums';
import { DomainException } from '../common/errors';
import { formatMoney } from '../common/money';
import { PrismaService } from '../prisma';

import { WalletService, type WalletBalance } from './wallet.service';

const DEFAULT_LEDGER_LIMIT = 50;
const MAX_LEDGER_LIMIT = 200;

interface WalletMeResponse {
  wallets: WalletBalance[];
}

interface LedgerEntryResponse {
  id: string;
  amount: string;
  currency: Currency;
  direction: 'credit' | 'debit';
  entry_type: string;
  related_deal_id: string | null;
  external_ref: string | null;
  created_at: Date;
}

interface LedgerListResponse {
  entries: LedgerEntryResponse[];
  next_cursor: string | null;
}

@Controller('v1/wallet')
export class WalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly prisma: PrismaService,
  ) {}

  @UseGuards(AuthGuard)
  @Get('me')
  @HttpCode(HttpStatus.OK)
  async getMyWallets(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WalletMeResponse> {
    const wallets = await this.prisma.wallet.findMany({
      where: { user_id: user.id },
    });

    const balances: WalletBalance[] = await Promise.all(
      wallets.map(async (w) => {
        const balance = await this.walletService.computeBalance(w.id);
        const available = await this.walletService.getAvailableBalance(w.id);
        return {
          id: w.id,
          currency: w.currency as Currency,
          balance: formatMoney(balance),
          available: formatMoney(available),
        };
      }),
    );

    return { wallets: balances };
  }

  @UseGuards(AuthGuard)
  @Get('me/ledger')
  @HttpCode(HttpStatus.OK)
  async getMyLedger(
    @CurrentUser() user: AuthenticatedUser,
    @Query('currency') currency: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<LedgerListResponse> {
    if (!currency || !ALL_CURRENCIES.includes(currency as Currency)) {
      throw DomainException.badRequest('wallet.invalid_field', {
        details: { field: 'currency', allowed: ALL_CURRENCIES },
      });
    }

    const parsedLimit = Math.max(
      1,
      Math.min(MAX_LEDGER_LIMIT, Number(limit) || DEFAULT_LEDGER_LIMIT),
    );

    const wallet = await this.prisma.wallet.findUnique({
      where: {
        user_id_currency: { user_id: user.id, currency: currency as Currency },
      },
    });
    if (!wallet) {
      return { entries: [], next_cursor: null };
    }

    const rows = await this.prisma.walletLedgerEntry.findMany({
      where: { wallet_id: wallet.id },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: parsedLimit + 1,
      ...(cursor
        ? { cursor: { id: BigInt(cursor) }, skip: 1 }
        : {}),
      select: {
        id: true,
        amount: true,
        currency: true,
        direction: true,
        entry_type: true,
        related_deal_id: true,
        external_ref: true,
        created_at: true,
      },
    });

    const hasMore = rows.length > parsedLimit;
    const slice = hasMore ? rows.slice(0, parsedLimit) : rows;
    const nextCursor = hasMore ? slice[slice.length - 1].id.toString() : null;

    return {
      entries: slice.map((r) => ({
        id: r.id.toString(),
        amount: formatMoney(new Decimal(r.amount.toString())),
        currency: r.currency as Currency,
        direction: r.direction as 'credit' | 'debit',
        entry_type: r.entry_type,
        related_deal_id: r.related_deal_id,
        external_ref: r.external_ref,
        created_at: r.created_at,
      })),
      next_cursor: nextCursor,
    };
  }
}
