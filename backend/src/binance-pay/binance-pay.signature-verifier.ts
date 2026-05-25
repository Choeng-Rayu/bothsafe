/**
 * BinancePaySignatureVerifier — webhook signature verification (§16.4).
 *
 * TODO: Implement when merchant credentials are available.
 * - HMAC-SHA512 over `${timestamp}\n${nonce}\n${rawBody}\n`
 * - RSA-SHA256 verify of BinancePay-Signature against cert from BinancePay-Certificate-SN
 * - Reject: missing headers, ±5min timestamp skew, hash mismatch, unknown cert serial
 */

import { Injectable } from '@nestjs/common';

@Injectable()
export class BinancePaySignatureVerifier {
  // TODO: Implement (R21.6, R21.7, R22.7)

  verify(_params: {
    timestamp: string;
    nonce: string;
    rawBody: string;
    signature: string;
    certificateSN: string;
  }): boolean {
    throw new Error('BinancePaySignatureVerifier.verify: not implemented — awaiting merchant credentials');
  }
}
