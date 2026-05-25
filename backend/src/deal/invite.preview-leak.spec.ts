/**
 * Focused leak-invariant tests for `InviteService.preview` (task 5.14).
 *
 * Source of truth: tasks.md §5.14; requirements.md R4.2, R4.3.
 *
 * # Why a separate file
 *
 * `invite.service.spec.ts` already covers the happy-path projection
 * shape and individual error envelopes. This file adds **property-
 * style** leak coverage:
 *
 *   - Generate many synthetic deals with adversarial honeypot values
 *     in every non-public column (buyer_name, seller_name, phone,
 *     creator_user_id, reference_note, terms_hash, khqr metadata,
 *     etc.).
 *   - Run `preview(rawToken)` against each.
 *   - Assert the entire JSON serialisation NEVER contains any
 *     honeypot byte sequence — including the raw invite token, the
 *     token hash, and any participant identity.
 *
 * # Properties verified
 *
 *   1. **Allow-list closure** — every key on the preview response
 *      is in the canonical `InvitePreview` allow-list.
 *   2. **Forbidden-key absence** — every forbidden key from R4.2 is
 *      missing on the response (`buyer_name`, raw tokens, etc.).
 *   3. **Substring leak absence** — for every honeypot string
 *      embedded in non-public columns, the JSON-serialised response
 *      contains no occurrence of it (defends against an accidental
 *      `select: { ... }` widening that copies a forbidden field).
 *   4. **Error-path silence** — when the token is invalid /
 *      expired / consumed / bound to a terminal-status deal, the
 *      thrown `DomainException` body MUST NOT contain any deal
 *      data, participant identity, or token material (R4.3).
 *
 * Validates: R4.2 (no participant identities or tokens in the
 * preview), R4.3 (invalid-token responses leak nothing).
 */

import * as fc from 'fast-check';
import {
  Prisma,
  type DealRoom,
  type InviteToken,
} from '@prisma/client';
import { Decimal } from 'decimal.js';

import {
  Currency,
  CreatorSource,
  DealStatus,
  ParticipantRole,
} from '../common/enums';
import { DomainException } from '../common/errors';
import { hashToken } from '../common/tokens';
import type { PrismaService } from '../prisma';

import { InviteService, type InvitePreview } from './invite.service';

// ---------------------------------------------------------------------------
// Public-allow-list and forbidden keys — ground truth for R4.2
// ---------------------------------------------------------------------------

const PREVIEW_ALLOWED_KEYS: ReadonlySet<keyof InvitePreview> = new Set([
  'deal_public_id',
  'deal_amount',
  'currency',
  'currency_display',
  'product_title',
  'expected_role',
]);

const PREVIEW_FORBIDDEN_KEYS: readonly string[] = [
  'buyer_name',
  'seller_name',
  'phone',
  'phone_number',
  'preferred_lang',
  'creator_user_id',
  'creator_id',
  'creator_role',
  'token',
  'token_hash',
  'raw_invite_token',
  'invite_token',
  'creator_access_token',
  'participant_access_token',
  'reference_note',
  'khqr_payload_meta',
  'khqr_string',
  'terms_hash',
  'deal_id',
  'id',
  'expires_at',
  'invalidated_at',
  'created_at',
  'updated_at',
  'status',
];

// ---------------------------------------------------------------------------
// Fixtures and fakes
// ---------------------------------------------------------------------------

function makeFakePrisma(opts: {
  deal: DealRoom;
  inviteToken: InviteToken | null;
}): PrismaService {
  return {
    inviteToken: {
      findUnique: jest.fn(async () => opts.inviteToken),
    },
    dealRoom: {
      findUnique: jest.fn(async () => opts.deal),
    },
  } as unknown as PrismaService;
}

interface SyntheticDealOpts {
  honeypots: {
    buyer_name: string;
    seller_name: string;
    creator_user_id: string;
    reference_note: string;
    terms_hash: string;
  };
  productTitle: string;
  dealAmountCents: number;
  currency: Currency;
  creatorRole: ParticipantRole;
  status: DealStatus;
}

function makeSyntheticDeal(opts: SyntheticDealOpts): DealRoom {
  const dollars = Math.floor(opts.dealAmountCents / 100);
  const fraction = (opts.dealAmountCents % 100).toString().padStart(2, '0');
  const amountStr = `${dollars}.${fraction}`;
  const now = new Date('2026-06-01T00:00:00.000Z');

  return {
    id: 'deal_id_1',
    public_id: 'pub_xyz',
    creator_user_id: opts.honeypots.creator_user_id,
    creator_role: opts.creatorRole,
    creator_source: CreatorSource.web,
    status: opts.status,
    product_title: opts.productTitle,
    product_type: 'electronics',
    product_description: null,
    quantity: 1,
    condition: null,
    deal_amount: new Decimal(amountStr) as unknown as Prisma.Decimal,
    currency: opts.currency,
    buyer_name: opts.honeypots.buyer_name,
    seller_name: opts.honeypots.seller_name,
    delivery_method: null,
    delivery_address: null,
    delivery_note: null,
    payout_khqr: null,
    payout_bank_name: null,
    payout_account_name: null,
    payout_account_number: null,
    reference_note: opts.honeypots.reference_note,
    khqr_payload_meta: null,
    terms_hash: opts.honeypots.terms_hash,
    created_at: now,
    updated_at: now,
    expires_at: null,
  } as unknown as DealRoom;
}

const RAW_INVITE = 'invite_raw_token_aaaaaaaaaaaa';
const TOKEN_HASH = hashToken(RAW_INVITE);

function makeInviteToken(overrides: Partial<InviteToken> = {}): InviteToken {
  return {
    id: 'inv_1',
    deal_id: 'deal_id_1',
    token_hash: TOKEN_HASH,
    expires_at: new Date('2027-06-01T00:00:00.000Z'),
    invalidated_at: null,
    created_at: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  } as InviteToken;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Honeypot string — distinctive prefix so `JSON.stringify` checks are reliable. */
const honeypotArb = (label: string) =>
  fc
    .string({ minLength: 4, maxLength: 16 })
    .filter((s) => /^[A-Za-z0-9_-]+$/.test(s) && s.length >= 4)
    .map((s) => `HONEYPOT_${label}_${s}`);

const syntheticDealArb: fc.Arbitrary<SyntheticDealOpts> = fc.record({
  honeypots: fc.record({
    buyer_name: honeypotArb('BUYER'),
    seller_name: honeypotArb('SELLER'),
    creator_user_id: honeypotArb('CREATOR_USER'),
    reference_note: honeypotArb('REF'),
    terms_hash: honeypotArb('HASH'),
  }),
  productTitle: fc
    .string({ minLength: 1, maxLength: 60 })
    .filter((s) => s.trim().length > 0),
  dealAmountCents: fc.integer({ min: 1, max: 1_000_000_00 }),
  currency: fc.constantFrom(Currency.USD, Currency.KHR),
  creatorRole: fc.constantFrom(ParticipantRole.buyer, ParticipantRole.seller),
  status: fc.constantFrom(
    DealStatus.AWAITING_COUNTERPARTY,
    DealStatus.AWAITING_BOTH_APPROVAL,
    DealStatus.READY_FOR_PAYMENT,
  ),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InviteService.preview — leak invariants (task 5.14, R4.2/R4.3)', () => {
  it('preview never includes any forbidden key for any synthetic deal', async () => {
    await fc.assert(
      fc.asyncProperty(syntheticDealArb, async (opts) => {
        const deal = makeSyntheticDeal(opts);
        const prisma = makeFakePrisma({
          deal,
          inviteToken: makeInviteToken(),
        });
        const service = new InviteService(prisma);

        const preview = await service.preview(RAW_INVITE);

        // Allow-list closure.
        for (const key of Object.keys(preview)) {
          expect(PREVIEW_ALLOWED_KEYS.has(key as keyof InvitePreview)).toBe(true);
        }
        // Forbidden-key absence.
        for (const key of PREVIEW_FORBIDDEN_KEYS) {
          expect(preview).not.toHaveProperty(key);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('preview JSON contains none of the honeypot values from non-public columns', async () => {
    await fc.assert(
      fc.asyncProperty(syntheticDealArb, async (opts) => {
        const deal = makeSyntheticDeal(opts);
        const prisma = makeFakePrisma({
          deal,
          inviteToken: makeInviteToken(),
        });
        const service = new InviteService(prisma);

        const preview = await service.preview(RAW_INVITE);
        const serialised = JSON.stringify(preview);

        // None of the honeypot strings — including raw / hashed
        // tokens — should appear in the serialised response.
        const forbidden = [
          opts.honeypots.buyer_name,
          opts.honeypots.seller_name,
          opts.honeypots.creator_user_id,
          opts.honeypots.reference_note,
          opts.honeypots.terms_hash,
          RAW_INVITE,
          TOKEN_HASH,
        ];
        for (const needle of forbidden) {
          expect(serialised.includes(needle)).toBe(false);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('error-path responses (invalid / expired / consumed / terminal) leak no deal or token bytes', async () => {
    const opts: SyntheticDealOpts = {
      honeypots: {
        buyer_name: 'HONEYPOT_BUYER_X',
        seller_name: 'HONEYPOT_SELLER_X',
        creator_user_id: 'HONEYPOT_CREATOR_X',
        reference_note: 'HONEYPOT_REF_X',
        terms_hash: 'HONEYPOT_HASH_X',
      },
      productTitle: 'HONEYPOT_TITLE_X',
      dealAmountCents: 12345,
      currency: Currency.USD,
      creatorRole: ParticipantRole.buyer,
      status: DealStatus.CANCELLED, // terminal
    };
    const deal = makeSyntheticDeal(opts);

    const cases: Array<{
      label: string;
      inviteToken: InviteToken | null;
      dealOverride?: DealRoom;
      expectedCode: string;
    }> = [
      {
        label: 'unknown token',
        inviteToken: null,
        expectedCode: 'invite.invalid',
      },
      {
        label: 'consumed token',
        inviteToken: makeInviteToken({ invalidated_at: new Date() }),
        expectedCode: 'invite.consumed',
      },
      {
        label: 'expired token',
        inviteToken: makeInviteToken({
          expires_at: new Date('2020-01-01T00:00:00.000Z'),
        }),
        expectedCode: 'invite.invalid',
      },
      {
        label: 'terminal-status deal (CANCELLED)',
        inviteToken: makeInviteToken(),
        dealOverride: deal,
        expectedCode: 'invite.invalid',
      },
    ];

    for (const tc of cases) {
      const prisma = makeFakePrisma({
        deal: tc.dealOverride ?? deal,
        inviteToken: tc.inviteToken,
      });
      const service = new InviteService(prisma);

      let caught: DomainException | undefined;
      try {
        await service.preview(RAW_INVITE);
      } catch (err) {
        caught = err as DomainException;
      }

      expect(caught).toBeInstanceOf(DomainException);
      expect(caught?.code).toBe(tc.expectedCode);

      // The error envelope must not contain any honeypot byte from the
      // deal nor the raw / hashed invite token.
      const envelope = JSON.stringify(caught?.getResponse?.() ?? {});
      const forbidden = [
        opts.honeypots.buyer_name,
        opts.honeypots.seller_name,
        opts.honeypots.creator_user_id,
        opts.honeypots.reference_note,
        opts.honeypots.terms_hash,
        opts.productTitle,
        RAW_INVITE,
        TOKEN_HASH,
      ];
      for (const needle of forbidden) {
        expect(envelope.includes(needle)).toBe(false);
      }
    }
  });
});
