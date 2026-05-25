/**
 * BinancePayClient — HTTP client for Binance Pay API (§16.3).
 *
 * TODO: Implement when merchant credentials are available.
 * - createOrder: HMAC-SHA512 signed request to create payment order
 * - queryOrder: poll order status
 * - payout: initiate seller payout
 * - queryPayout: poll payout status
 * - 8s connect + 12s read timeout
 * - 3 retries with exponential backoff (0.5/1/2s) on 5xx only
 * - BinancePayCertificateCache: 1h TTL, refresh-ahead
 */

import { Injectable } from '@nestjs/common';

@Injectable()
export class BinancePayClient {
  // TODO: Implement with real Binance Pay merchant credentials (R21.6, R22.5)

  async createOrder(_params: {
    merchantTradeNo: string;
    totalAmount: string;
    currency: string;
    description: string;
  }): Promise<{ prepayId: string; qrcodeLink: string; deeplink: string; universalUrl: string }> {
    throw new Error('BinancePayClient.createOrder: not implemented — awaiting merchant credentials');
  }

  async queryOrder(_merchantTradeNo: string): Promise<{ status: string }> {
    throw new Error('BinancePayClient.queryOrder: not implemented — awaiting merchant credentials');
  }

  async payout(_params: {
    merchantSendId: string;
    amount: string;
    currency: string;
    receiverPayId?: string;
    receiverEmail?: string;
  }): Promise<{ payoutTransactionId: string; status: string }> {
    throw new Error('BinancePayClient.payout: not implemented — awaiting merchant credentials');
  }

  async queryPayout(_merchantSendId: string): Promise<{ status: string }> {
    throw new Error('BinancePayClient.queryPayout: not implemented — awaiting merchant credentials');
  }
}
