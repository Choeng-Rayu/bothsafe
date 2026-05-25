/**
 * BinancePayoutService — seller withdrawal via Binance Pay (§17.3–17.5).
 *
 * TODO: Implement when merchant credentials are available.
 * - initiatePayout: called from WithdrawalService.approve for binance destination
 * - merchantSendId = withdrawal.id for outbound idempotency
 * - On SUCCESS: write SELLER_PAYOUT_SENT, set status='paid', persist BinancePayout row
 * - On failure: leave pending_admin_review, return withdrawal.binance_payout_failed
 * - Payout webhook: same signature verification as 16.4/16.6
 * - Reconciliation: BullMQ cron every 60s for PENDING/PROCESSING payouts
 */

import { Injectable } from '@nestjs/common';

@Injectable()
export class BinancePayoutService {
  // TODO: Implement (R22.5–R22.9)

  async initiatePayout(_withdrawalId: string): Promise<{ payoutTransactionId: string }> {
    throw new Error('BinancePayoutService.initiatePayout: not implemented — awaiting merchant credentials');
  }

  async handlePayoutWebhook(_rawBody: string, _headers: Record<string, string>): Promise<{ code: string }> {
    throw new Error('BinancePayoutService.handlePayoutWebhook: not implemented — awaiting merchant credentials');
  }
}
