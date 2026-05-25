/**
 * Binance Pay module — buyer payment (R21) and seller payout (R22).
 *
 * TODO: Requires real Binance Pay merchant credentials for integration.
 * All services below are stubs pending merchant approval.
 *
 * Tasks: 16.1–16.12, 17.1–17.9
 */

import { Module } from '@nestjs/common';
import { BinancePayClient } from './binance-pay.client';
import { BinancePaySignatureVerifier } from './binance-pay.signature-verifier';
import { BinanceOrderService } from './binance-order.service';
import { BinanceWebhookService } from './binance-webhook.service';
import { BinancePayoutService } from './binance-payout.service';

@Module({
  providers: [
    BinancePayClient,
    BinancePaySignatureVerifier,
    BinanceOrderService,
    BinanceWebhookService,
    BinancePayoutService,
  ],
  exports: [BinanceOrderService, BinancePayoutService],
})
export class BinancePayModule {}
