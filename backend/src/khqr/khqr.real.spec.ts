/**
 * KhqrGenerator real-integration unit tests.
 *
 * Verifies the real bakong-khqr library integration:
 *   - Generates a valid KHQR string (CRC-valid, correct format)
 *   - References the Bakong account id in the string
 *   - Includes the reference_note in the QR payload
 *   - Returns a valid md5 hash
 *   - KhqrVerifier degrades gracefully without BAKONG_API_TOKEN
 */

import type { DealRoom } from '@prisma/client';
import { Decimal } from 'decimal.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BakongKHQR } = require('bakong-khqr');

import type { PrismaService } from '../prisma';
import { KhqrGenerator, KhqrVerifier } from './khqr.service';

// Minimal Prisma fake — just needs dealRoom.findUnique to return null
// (no collision, so the first reference_note is always used)
const fakePrisma = {
  dealRoom: {
    findUnique: jest.fn().mockResolvedValue(null),
  },
} as unknown as PrismaService;

const BAKONG_ACCOUNT_ID_BACKUP = process.env.BAKONG_ACCOUNT_ID;

// QR PNG rendering via qrcode is slower than the default 5 s Jest timeout
jest.setTimeout(30_000);

beforeAll(() => {
  process.env.BAKONG_ACCOUNT_ID = 'choeng_rayu@aclb';  process.env.BAKONG_MERCHANT_NAME = 'BothSafe Escrow';
  process.env.BAKONG_MERCHANT_CITY = 'Phnom Penh';
});

afterAll(() => {
  if (BAKONG_ACCOUNT_ID_BACKUP !== undefined) {
    process.env.BAKONG_ACCOUNT_ID = BAKONG_ACCOUNT_ID_BACKUP;
  }
});

describe('KhqrGenerator.generate — real KHQR library (task 7.1)', () => {
  it('generates a CRC-valid KHQR string for a USD amount', async () => {
    const generator = new KhqrGenerator(fakePrisma);
    const result = await generator.generate({
      amount: '25.00',
      currency: 'USD',
      receiver: 'choeng_rayu@aclb',
    });

    expect(typeof result.khqrString).toBe('string');
    expect(result.khqrString.length).toBeGreaterThan(30);

    // Verify via the library's own CRC verifier
    const verification = BakongKHQR.verify(result.khqrString);
    expect(verification.isValid).toBe(true);

    // Verify it's a real PNG (magic bytes: 89 50 4E 47)
    expect(result.pngBuffer[0]).toBe(0x89);
    expect(result.pngBuffer[1]).toBe(0x50); // 'P'
    expect(result.pngBuffer[2]).toBe(0x4e); // 'N'
    expect(result.pngBuffer[3]).toBe(0x47); // 'G'
    expect(result.pngBuffer.length).toBeGreaterThan(1000); // real image, not a stub
  });

  it('generates a CRC-valid KHQR string for a KHR amount', async () => {
    const generator = new KhqrGenerator(fakePrisma);
    const result = await generator.generate({
      amount: '40000',
      currency: 'KHR',
      receiver: 'choeng_rayu@aclb',
    });

    const verification = BakongKHQR.verify(result.khqrString);
    expect(verification.isValid).toBe(true);
  });

  it('embeds the Bakong account ID and reference_note in the QR string', async () => {
    const generator = new KhqrGenerator(fakePrisma);
    const result = await generator.generate({
      amount: '10.00',
      currency: 'USD',
      receiver: 'choeng_rayu@aclb',
    });

    expect(result.khqrString).toContain('choeng_rayu@aclb');
    expect(result.khqrString).toContain(result.referenceNote);
  });

  it('returns a 16-char Crockford base32 reference_note', async () => {
    const generator = new KhqrGenerator(fakePrisma);
    const result = await generator.generate({
      amount: '50.00',
      currency: 'USD',
      receiver: 'choeng_rayu@aclb',
    });

    expect(result.referenceNote).toHaveLength(16);
    expect(result.referenceNote).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
  });

  it('returns a 32-char md5 hash for Bakong transaction lookup', async () => {
    const generator = new KhqrGenerator(fakePrisma);
    const result = await generator.generate({
      amount: '15.00',
      currency: 'USD',
      receiver: 'choeng_rayu@aclb',
    });

    expect(result.md5).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('KhqrVerifier — graceful degradation (task 7.3)', () => {
  it('returns null when BAKONG_API_TOKEN is not set', async () => {
    const savedToken = process.env.BAKONG_API_TOKEN;
    delete process.env.BAKONG_API_TOKEN;

    const verifier = new KhqrVerifier();
    const result = await verifier.verifyByReferenceNote({
      reference_note: 'REF1234567890ABCD',
      deal_amount: new Decimal('25.00'),
      currency: 'USD',
      khqr_payload_meta: { md5: 'abc123' },
    } as unknown as DealRoom);

    expect(result).toBeNull();

    if (savedToken !== undefined) {
      process.env.BAKONG_API_TOKEN = savedToken;
    }
  });

  it('returns null when khqr_payload_meta has no md5', async () => {
    const verifier = new KhqrVerifier();
    const result = await verifier.verifyByReferenceNote({
      reference_note: 'REF1234567890ABCD',
      deal_amount: new Decimal('25.00'),
      currency: 'USD',
      khqr_payload_meta: null,
    } as unknown as DealRoom);

    expect(result).toBeNull();
  });
});
