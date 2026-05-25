/**
 * Real KHQR service using `bakong-khqr` npm package.
 *
 * KhqrGenerator: generates real, CRC-valid KHQR string + actual PNG
 *   via the `qrcode` package.
 * KhqrVerifier: calls POST /v1/check_transaction_by_md5 on the Bakong
 *   Open API. Returns the Bakong transaction hash on payment confirmed,
 *   null otherwise.
 *
 * Bakong API reference: https://github.com/Choeng-Rayu/-bakong_js
 */

import { Injectable, Logger } from '@nestjs/common';
import * as QRCode from 'qrcode';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BakongKHQR, IndividualInfo, khqrData } = require('bakong-khqr');

import { generateReferenceNote } from '../common/tokens';
import { PrismaService } from '../prisma';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KhqrGenerateInput {
  amount: string;    // '10.50'
  currency: string;  // 'USD' | 'KHR'
  receiver: string;  // bakong account id e.g. 'choeng_rayu@aclb'
}

export interface KhqrGenerateResult {
  khqrString: string;
  pngBuffer: Buffer;       // real 400×400 QR PNG
  referenceNote: string;   // 16-char Crockford base32 reference note
  md5: string;             // Bakong md5 for /check_transaction_by_md5
}

export interface BakongPaymentData {
  hash: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  currency: string;
  description: string;
  createdDateMs: number;
  acknowledgedDateMs: number;
}

const BAKONG_API_URL =
  process.env.BAKONG_API_URL ?? 'https://api-bakong.nbc.gov.kh/v1';

// ---------------------------------------------------------------------------
// KhqrGenerator
// ---------------------------------------------------------------------------

@Injectable()
export class KhqrGenerator {
  private readonly logger = new Logger(KhqrGenerator.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate a real Bakong KHQR individual QR.
   *
   * Steps:
   *   1. Allocate a unique 16-char Crockford base32 reference_note.
   *   2. Build the KHQR payload via bakong-khqr's IndividualInfo +
   *      BakongKHQR.generateIndividual.
   *   3. Render the QR string into a real PNG buffer via `qrcode`.
   *   4. Return {khqrString, pngBuffer, referenceNote, md5}.
   */
  async generate(input: KhqrGenerateInput): Promise<KhqrGenerateResult> {
    const referenceNote = await this.allocateReferenceNote();

    const accountId =
      input.receiver || process.env.BAKONG_ACCOUNT_ID || 'bothsafe@aclb';
    const merchantName =
      process.env.BAKONG_MERCHANT_NAME ?? 'BothSafe Escrow';
    const merchantCity =
      process.env.BAKONG_MERCHANT_CITY ?? 'Phnom Penh';

    // Expiration: 1 hour from now in milliseconds (must be 13 digits)
    const expirationTimestamp = String(Date.now() + 60 * 60 * 1000);

    // Map currency to bakong-khqr numeric constant
    const currencyCode =
      input.currency === 'KHR' ? khqrData.currency.khr : khqrData.currency.usd;

    const info = new IndividualInfo(accountId, merchantName, merchantCity, {
      amount: parseFloat(input.amount),
      currency: currencyCode,
      billNumber: referenceNote,
      terminalLabel: 'BothSafe',
      expirationTimestamp,
    });

    const result = new BakongKHQR().generateIndividual(info);

    if (result.status.code !== 0 || !result.data) {
      this.logger.error(
        `KhqrGenerator: KHQR generation failed — ${result.status.message}`,
      );
      throw new Error(`KHQR generation failed: ${result.status.message}`);
    }

    const khqrString: string = result.data.qr;
    const md5: string = result.data.md5;

    // Generate real 400×400 QR PNG
    const pngBuffer = await QRCode.toBuffer(khqrString, {
      type: 'png',
      width: 400,
      margin: 2,
      errorCorrectionLevel: 'M',
    });

    this.logger.log(
      `KhqrGenerator: generated KHQR ref=${referenceNote} md5=${md5}`,
    );

    return { khqrString, pngBuffer, referenceNote, md5 };
  }

  /**
   * Allocate a unique 16-char Crockford base32 reference note.
   * Retries on the rare collision (UNIQUE on deal_room.reference_note).
   */
  private async allocateReferenceNote(maxRetries = 5): Promise<string> {
    for (let i = 0; i < maxRetries; i++) {
      const note = generateReferenceNote();
      const existing = await this.prisma.dealRoom.findUnique({
        where: { reference_note: note },
        select: { id: true },
      });
      if (!existing) return note;
    }
    throw new Error('Failed to allocate unique reference_note after retries');
  }
}

// ---------------------------------------------------------------------------
// KhqrVerifier
// ---------------------------------------------------------------------------

@Injectable()
export class KhqrVerifier {
  private readonly logger = new Logger(KhqrVerifier.name);

  /**
   * Poll the Bakong Open API for a confirmed payment.
   *
   * Calls POST /v1/check_transaction_by_md5 using the md5 cached in
   * DealRoom.khqr_payload_meta. Returns the Bakong transaction hash on
   * success (responseCode === 0), or null when not yet paid / on error.
   *
   * The Bakong API returns:
   *   responseCode = 0  → PAID   — response.data contains hash, amount, etc.
   *   responseCode = 1  → UNPAID (transaction not found yet)
   *   HTTP 401          → expired token
   *   HTTP 403          → non-Cambodia IP
   *
   * Callers should retry this up to 3× within 60 s (R11.1).
   */
  async verifyByReferenceNote(deal: {
    reference_note: string | null;
    deal_amount: unknown;
    currency: string | null;
    khqr_payload_meta: unknown;
  }): Promise<string | null> {
    const token = process.env.BAKONG_API_TOKEN;
    if (!token) {
      this.logger.warn('KhqrVerifier: BAKONG_API_TOKEN not set — skipping');
      return null;
    }

    const meta = deal.khqr_payload_meta as
      | { md5?: string; khqr_string?: string }
      | null;
    const md5 = meta?.md5;

    if (!md5) {
      this.logger.warn('KhqrVerifier: no md5 in khqr_payload_meta');
      return null;
    }

    try {
      const resp = await fetch(`${BAKONG_API_URL}/check_transaction_by_md5`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ md5 }),
        signal: AbortSignal.timeout(12_000),
      });

      if (resp.status === 401) {
        this.logger.error('KhqrVerifier: BAKONG_API_TOKEN expired or invalid');
        return null;
      }
      if (resp.status === 403) {
        this.logger.error('KhqrVerifier: Bakong API blocked (non-Cambodia IP)');
        return null;
      }
      if (!resp.ok) {
        this.logger.warn(`KhqrVerifier: API returned HTTP ${resp.status}`);
        return null;
      }

      const body = (await resp.json()) as {
        responseCode: number;
        responseMessage?: string;
        data?: BakongPaymentData | null;
      };

      if (body.responseCode === 0 && body.data?.hash) {
        this.logger.log(
          `KhqrVerifier: payment CONFIRMED — hash=${body.data.hash} ` +
            `from=${body.data.fromAccountId} amount=${body.data.amount} ${body.data.currency}`,
        );
        return body.data.hash;
      }

      // responseCode === 1 → not yet paid
      this.logger.debug(
        `KhqrVerifier: not yet paid — ${body.responseMessage ?? 'UNPAID'}`,
      );
      return null;
    } catch (err) {
      this.logger.warn(`KhqrVerifier: request error — ${String(err)}`);
      return null;
    }
  }
}
