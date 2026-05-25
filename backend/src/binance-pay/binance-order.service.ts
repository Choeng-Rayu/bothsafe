/**
 * BinanceOrderService — create and manage Binance Pay orders for deals (§16.5).
 *
 * TODO: Implement when merchant credentials are available.
 * - createOrderForDeal: buyer-only, reject KHR, idempotency scope binance_create_order
 * - Single tx: insert BinanceOrder, transition READY_FOR_PAYMENT → PAYMENT_PENDING_VERIFICATION
 * - On API failure: leave deal at READY_FOR_PAYMENT, return payment.binance_unavailable
 */

import { Injectable } from '@nestjs/common';

@Injectable()
export class BinanceOrderService {
  // TODO: Implement (R21.1–R21.5)

  async createOrderForDeal(_dealId: string, _buyerId: string): Promise<{
    qrcodeLink: string;
    deeplink: string;
    universalUrl: string;
  }> {
    throw new Error('BinanceOrderService.createOrderForDeal: not implemented — awaiting merchant credentials');
  }
}
