/**
 * BinanceWebhookService — handle Binance Pay webhook callbacks (§16.6).
 *
 * TODO: Implement when merchant credentials are available.
 * - POST /v1/payment/binance/webhook
 * - Verify signature → check timestamp → lookup by merchantTradeNo → dedup
 * - PAY_SUCCESS: settle escrow, transition to PAID_ESCROWED → SELLER_PREPARING
 * - PAY_REFUND: refund buyer, transition to REFUNDED
 * - PAY_CLOSED: revert to READY_FOR_PAYMENT
 */

import { Injectable } from '@nestjs/common';

@Injectable()
export class BinanceWebhookService {
  // TODO: Implement (R21.6–R21.12)

  async handle(_rawBody: string, _headers: Record<string, string>): Promise<{ code: string }> {
    throw new Error('BinanceWebhookService.handle: not implemented — awaiting merchant credentials');
  }
}
