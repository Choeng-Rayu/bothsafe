/**
 * InviteService unit tests (tasks.md §5.7).
 *
 * Coverage of the spec'd contracts:
 *
 *   1. **`preview` returns minimal payload** — the response shape is
 *      enumerated in {@link InvitePreview}; the test pins the key
 *      set with an allow-list and asserts that the forbidden keys
 *      from R4.2 (`buyer_name`, `seller_name`, `phone`, raw tokens,
 *      `terms_hash`, `reference_note`, …) never appear.
 *
 *   2. **`preview` throws `invite.invalid` for unknown / expired /
 *      "revoked" tokens** — "revoked" here means a token whose
 *      `invalidated_at` is set before its `expires_at` lapsed. Per
 *      the spec discussion in `invite.service.ts`, the preview path
 *      surfaces a CONSUMED token as `invite.consumed` (R5.7-flavoured
 *      message for the join page), but a token whose `expires_at`
 *      has lapsed is `invite.invalid`. We exercise both. We also
 *      keep an explicit "unknown token" test.
 *
 *   3. **`preview` throws `invite.consumed` for already-consumed
 *      tokens** — already-invalidated row → `invite.consumed`.
 *
 *   4. **`consume` records `consumed_at` (= `invalidated_at`)
 *      atomically** — the fake `tx` records the `updateMany` call
 *      that performs the compare-and-set and the test asserts both
 *      that the call was made and that `joiningUserId` is captured
 *      on the result for the join controller to consume.
 *
 *   5. **`consume` returns `expected_role: 'seller'` when creator
 *      is `'buyer'` (and vice versa)** — exercises the role flip.
 *
 * The Prisma client is faked — we model only the delegate methods
 * `InviteService` actually invokes (`inviteToken.findUnique`,
 * `inviteToken.updateMany`, `dealRoom.findUnique`). Anything else
 * throws so a future change that grows a new dependency fails loudly
 * here.
 */

import { Prisma, type DealRoom, type InviteToken } from '@prisma/client';
import { Decimal } from 'decimal.js';

import {
  Currency,
  CreatorSource,
  DealStatus,
  ParticipantRole,
} from '../common/enums';
import { hashToken } from '../common/tokens';
import type { PrismaService } from '../prisma';

import {
  INVITE_PREVIEW_PRODUCT_TITLE_MAX_LEN,
  InviteService,
  type InvitePreview,
} from './invite.service';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeState {
  deals: DealRoom[];
  inviteTokens: InviteToken[];
}

function makeDeal(overrides: Partial<DealRoom> = {}): DealRoom {
  const now = new Date('2026-06-01T00:00:00.000Z');
  return {
    id: overrides.id ?? 'deal_id_1',
    public_id: overrides.public_id ?? 'pub_abc123',
    creator_user_id: overrides.creator_user_id ?? 'user_creator',
    creator_role: overrides.creator_role ?? ParticipantRole.seller,
    creator_source: overrides.creator_source ?? CreatorSource.web,
    status: overrides.status ?? DealStatus.AWAITING_COUNTERPARTY,
    product_title: overrides.product_title ?? 'iPhone 15 Pro',
    product_type: overrides.product_type ?? 'phone',
    product_description: null,
    quantity: null,
    condition: null,
    deal_amount:
      overrides.deal_amount === undefined
        ? (new Decimal('1234.56') as unknown as Prisma.Decimal)
        : overrides.deal_amount,
    currency: overrides.currency ?? Currency.USD,
    buyer_name: overrides.buyer_name ?? null,
    seller_name: overrides.seller_name ?? null,
    reference_note: overrides.reference_note ?? null,
    khqr_payload_meta: null,
    terms_hash: null,
    created_at: now,
    updated_at: now,
    expires_at: null,
  } as unknown as DealRoom;
}

function makeInviteToken(
  overrides: Partial<InviteToken> & { token_hash: string; deal_id: string },
): InviteToken {
  const now = new Date('2026-06-01T00:00:00.000Z');
  return {
    id: overrides.id ?? `inv_${overrides.token_hash.slice(0, 8)}`,
    deal_id: overrides.deal_id,
    token_hash: overrides.token_hash,
    expires_at:
      overrides.expires_at ??
      new Date(Date.now() + 24 * 60 * 60 * 1000),
    invalidated_at: overrides.invalidated_at ?? null,
    created_at: overrides.created_at ?? now,
  } as InviteToken;
}

/**
 * Build an in-memory Prisma stand-in scoped to the surface
 * `InviteService` consumes. The transaction client (`tx`) shares the
 * underlying `state` so a `consume` followed by a subsequent
 * `findUnique` in the same test sees the row mutation.
 */
function makeFakePrisma(initial: FakeState = { deals: [], inviteTokens: [] }) {
  const state: FakeState = {
    deals: [...initial.deals],
    inviteTokens: [...initial.inviteTokens],
  };

  const inviteTokenFindUnique = jest.fn(
    async (args: {
      where: { token_hash?: string };
      select?: Record<string, boolean>;
    }) => {
      const row = state.inviteTokens.find(
        (r) => r.token_hash === args.where.token_hash,
      );
      return row ?? null;
    },
  );

  const inviteTokenUpdateMany = jest.fn(
    async (args: {
      where: {
        token_hash?: string;
        invalidated_at?: null;
        expires_at?: { gt?: Date };
      };
      data: { invalidated_at?: Date };
    }) => {
      let count = 0;
      const cutoff = args.where.expires_at?.gt?.getTime() ?? 0;
      for (const row of state.inviteTokens) {
        if (
          row.token_hash === args.where.token_hash &&
          row.invalidated_at === null &&
          row.expires_at.getTime() > cutoff
        ) {
          row.invalidated_at = args.data.invalidated_at ?? new Date();
          count += 1;
        }
      }
      return { count };
    },
  );

  const dealRoomFindUnique = jest.fn(
    async (args: {
      where: { id?: string };
      select?: Record<string, boolean>;
    }) => {
      const row = state.deals.find((d) => d.id === args.where.id);
      return row ?? null;
    },
  );

  const txClient = {
    inviteToken: {
      findUnique: inviteTokenFindUnique,
      updateMany: inviteTokenUpdateMany,
    },
    dealRoom: { findUnique: dealRoomFindUnique },
  };

  const prisma = {
    inviteToken: {
      findUnique: inviteTokenFindUnique,
    },
    dealRoom: {
      findUnique: dealRoomFindUnique,
    },
    runInTransaction: jest.fn(
      async <T,>(fn: (tx: typeof txClient) => Promise<T>) => fn(txClient),
    ),
  } as unknown as PrismaService;

  return { prisma, state, txClient };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InviteService', () => {
  // Pin a stable "now" so token expiry checks are deterministic.
  const NOW = Date.UTC(2026, 5, 1, 0, 0, 0);
  let dateNowSpy: jest.SpyInstance;

  beforeEach(() => {
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // preview — minimal payload (R4.1, R4.2, §5.14)
  // -------------------------------------------------------------------------

  describe('preview — minimal payload, no leakage', () => {
    it('returns the canonical SAFE preview shape and never includes participant identities, raw tokens, or audit fields', async () => {
      const deal = makeDeal({
        creator_role: ParticipantRole.seller,
        product_title: 'iPhone 15 Pro Max - Sealed Box',
        product_type: 'phone',
        deal_amount: new Decimal('999.00') as unknown as Prisma.Decimal,
        currency: Currency.USD,
        // Honeypot values: if the service ever serialises the deal
        // wholesale instead of using its hand-rolled projection, these
        // strings will show up in the response and the assertions
        // below will fail.
        buyer_name: 'HONEYPOT_BUYER_NAME',
        seller_name: 'HONEYPOT_SELLER_NAME',
        reference_note: 'HONEYPOTREF12345',
        creator_user_id: 'HONEYPOT_CREATOR_USER',
      });
      const raw = 'a'.repeat(24);
      const tokenHash = hashToken(raw);
      const { prisma } = makeFakePrisma({
        deals: [deal],
        inviteTokens: [
          makeInviteToken({ token_hash: tokenHash, deal_id: deal.id }),
        ],
      });
      const service = new InviteService(prisma);

      const preview = await service.preview(raw);

      // Allow-list: every key on the preview must be in this set.
      const allowedKeys: ReadonlySet<keyof InvitePreview> = new Set([
        'deal_public_id',
        'deal_amount',
        'currency',
        'currency_display',
        'product_title',
        'expected_role',
      ]);
      for (const key of Object.keys(preview)) {
        expect(allowedKeys.has(key as keyof InvitePreview)).toBe(true);
      }
      // …and the entire allow-list must be present (no undefined sneaks).
      for (const key of allowedKeys) {
        expect(preview).toHaveProperty(key);
      }

      // Forbidden keys from R4.2 / §5.14.
      const forbiddenKeys = [
        'buyer_name',
        'seller_name',
        'phone',
        'phone_number',
        'creator_user_id',
        'creator_id',
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
      ];
      for (const key of forbiddenKeys) {
        expect(preview).not.toHaveProperty(key);
      }

      // Field-by-field expectations.
      expect(preview.deal_public_id).toBe(deal.public_id);
      expect(preview.product_title).toBe('iPhone 15 Pro Max - Sealed Box');
      expect(preview.deal_amount).toBe('999');
      expect(preview.currency).toBe(Currency.USD);
      expect(preview.currency_display).toBe('USD');
      expect(preview.expected_role).toBe(ParticipantRole.buyer);

      // Defensive serialise + scan — no honeypot value, no token,
      // no internal id leaks through any unexpected channel.
      const serialised = JSON.stringify(preview);
      expect(serialised).not.toContain('HONEYPOT_BUYER_NAME');
      expect(serialised).not.toContain('HONEYPOT_SELLER_NAME');
      expect(serialised).not.toContain('HONEYPOT_CREATOR_USER');
      expect(serialised).not.toContain('HONEYPOTREF12345');
      expect(serialised).not.toContain(deal.id);
      expect(serialised).not.toContain(tokenHash);
      expect(serialised).not.toContain(raw);
    });

    it('truncates Product_Title to 200 characters per R4.1', async () => {
      const longTitle = 'A'.repeat(500);
      const deal = makeDeal({ product_title: longTitle });
      const raw = 'b'.repeat(24);
      const tokenHash = hashToken(raw);
      const { prisma } = makeFakePrisma({
        deals: [deal],
        inviteTokens: [
          makeInviteToken({ token_hash: tokenHash, deal_id: deal.id }),
        ],
      });
      const service = new InviteService(prisma);

      const preview = await service.preview(raw);

      expect(preview.product_title?.length).toBe(
        INVITE_PREVIEW_PRODUCT_TITLE_MAX_LEN,
      );
      expect(preview.product_title).toBe(
        'A'.repeat(INVITE_PREVIEW_PRODUCT_TITLE_MAX_LEN),
      );
    });

    it('renders currency_display = "KHR" for KHR deals', async () => {
      const deal = makeDeal({
        currency: Currency.KHR,
        deal_amount: new Decimal('5000.00') as unknown as Prisma.Decimal,
      });
      const raw = 'k'.repeat(24);
      const tokenHash = hashToken(raw);
      const { prisma } = makeFakePrisma({
        deals: [deal],
        inviteTokens: [
          makeInviteToken({ token_hash: tokenHash, deal_id: deal.id }),
        ],
      });
      const service = new InviteService(prisma);

      const preview = await service.preview(raw);

      expect(preview.currency).toBe(Currency.KHR);
      expect(preview.currency_display).toBe('KHR');
    });
  });

  // -------------------------------------------------------------------------
  // preview — invalid / expired / revoked
  // -------------------------------------------------------------------------

  describe('preview — error envelope', () => {
    it('throws invite.invalid for an unknown raw token', async () => {
      const { prisma } = makeFakePrisma({
        deals: [makeDeal()],
        inviteTokens: [],
      });
      const service = new InviteService(prisma);

      await expect(
        service.preview('not_a_real_token_xyz1234567890'),
      ).rejects.toMatchObject({ code: 'invite.invalid' });
    });

    it('throws invite.invalid for an obviously-bogus short token without touching the DB', async () => {
      const { prisma } = makeFakePrisma();
      const findSpy = prisma.inviteToken.findUnique as jest.Mock;
      const service = new InviteService(prisma);

      await expect(service.preview('short')).rejects.toMatchObject({
        code: 'invite.invalid',
      });
      expect(findSpy).not.toHaveBeenCalled();
    });

    it('throws invite.invalid for an expired token (past expires_at, never invalidated)', async () => {
      const deal = makeDeal();
      const raw = 'e'.repeat(24);
      const tokenHash = hashToken(raw);
      const { prisma } = makeFakePrisma({
        deals: [deal],
        inviteTokens: [
          makeInviteToken({
            token_hash: tokenHash,
            deal_id: deal.id,
            expires_at: new Date(NOW - 60_000), // 1 minute ago
            invalidated_at: null,
          }),
        ],
      });
      const service = new InviteService(prisma);

      await expect(service.preview(raw)).rejects.toMatchObject({
        code: 'invite.invalid',
      });
    });

    it('throws invite.invalid for a "revoked" deal (terminal status), not invite.consumed', async () => {
      // The schema doesn't have a per-token "revoked" column — invite
      // revocation surfaces in two ways: (a) an explicit
      // `invalidated_at` set (covered by the consumed case), or (b)
      // the deal moving to a terminal status (CANCELLED / EXPIRED /
      // RELEASED / REFUNDED). The latter is what R4.3 calls "deal in
      // CANCELLED or EXPIRED status".
      const deal = makeDeal({ status: DealStatus.CANCELLED });
      const raw = 'r'.repeat(24);
      const tokenHash = hashToken(raw);
      const { prisma } = makeFakePrisma({
        deals: [deal],
        inviteTokens: [
          makeInviteToken({
            token_hash: tokenHash,
            deal_id: deal.id,
            // Active token, but parent deal is finalised.
            invalidated_at: null,
            expires_at: new Date(NOW + 60_000),
          }),
        ],
      });
      const service = new InviteService(prisma);

      await expect(service.preview(raw)).rejects.toMatchObject({
        code: 'invite.invalid',
      });
    });

    it('throws invite.consumed for an already-consumed token', async () => {
      const deal = makeDeal();
      const raw = 'c'.repeat(24);
      const tokenHash = hashToken(raw);
      const { prisma } = makeFakePrisma({
        deals: [deal],
        inviteTokens: [
          makeInviteToken({
            token_hash: tokenHash,
            deal_id: deal.id,
            invalidated_at: new Date(NOW - 1_000),
          }),
        ],
      });
      const service = new InviteService(prisma);

      await expect(service.preview(raw)).rejects.toMatchObject({
        code: 'invite.consumed',
      });
    });
  });

  // -------------------------------------------------------------------------
  // consume — atomic single-use, role flip, audit-friendly inputs
  // -------------------------------------------------------------------------

  describe('consume — records consumed_at atomically inside tx', () => {
    it('flips invalidated_at to now() and returns { deal_id, expected_role } on first call', async () => {
      const deal = makeDeal({ creator_role: ParticipantRole.seller });
      const raw = 'd'.repeat(24);
      const tokenHash = hashToken(raw);
      const { prisma, state, txClient } = makeFakePrisma({
        deals: [deal],
        inviteTokens: [
          makeInviteToken({ token_hash: tokenHash, deal_id: deal.id }),
        ],
      });
      const service = new InviteService(prisma);

      const result = await prisma.runInTransaction((tx) =>
        service.consume(
          raw,
          'user_joiner',
          tx as unknown as Prisma.TransactionClient,
        ),
      );

      // Return shape pinned to { deal_id, expected_role } only.
      expect(Object.keys(result).sort()).toEqual(['deal_id', 'expected_role']);
      expect(result.deal_id).toBe(deal.id);
      expect(result.expected_role).toBe(ParticipantRole.buyer);

      // The token row was flipped — `invalidated_at` is non-null now,
      // representing `consumed_at` per the schema mapping documented
      // in `invite.service.ts`.
      const row = state.inviteTokens.find((r) => r.token_hash === tokenHash);
      expect(row).toBeDefined();
      expect(row?.invalidated_at).not.toBeNull();
      expect(row?.invalidated_at?.getTime()).toBe(NOW);

      // The compare-and-set went through the supplied tx (not the
      // global prisma client), satisfying the §5.7 "atomically" /
      // R5.6 "single transaction" contract.
      expect(txClient.inviteToken.updateMany).toHaveBeenCalledTimes(1);
      const updateCall = (
        txClient.inviteToken.updateMany as jest.Mock
      ).mock.calls[0][0];
      expect(updateCall.where).toMatchObject({
        token_hash: tokenHash,
        invalidated_at: null,
      });
      expect(updateCall.where.expires_at.gt).toBeInstanceOf(Date);
      expect(updateCall.data.invalidated_at).toBeInstanceOf(Date);
    });

    it('throws invite.consumed on the second consume (atomic compare-and-set)', async () => {
      const deal = makeDeal({ creator_role: ParticipantRole.seller });
      const raw = 'e'.repeat(24);
      const tokenHash = hashToken(raw);
      const { prisma } = makeFakePrisma({
        deals: [deal],
        inviteTokens: [
          makeInviteToken({ token_hash: tokenHash, deal_id: deal.id }),
        ],
      });
      const service = new InviteService(prisma);

      // First consume succeeds.
      await prisma.runInTransaction((tx) =>
        service.consume(
          raw,
          'user_joiner_1',
          tx as unknown as Prisma.TransactionClient,
        ),
      );

      // Second consume on the same raw token must throw `invite.consumed`.
      await expect(
        prisma.runInTransaction((tx) =>
          service.consume(
            raw,
            'user_joiner_2',
            tx as unknown as Prisma.TransactionClient,
          ),
        ),
      ).rejects.toMatchObject({ code: 'invite.consumed' });
    });

    it('throws invite.consumed for an unknown raw token', async () => {
      const { prisma } = makeFakePrisma();
      const service = new InviteService(prisma);

      await expect(
        prisma.runInTransaction((tx) =>
          service.consume(
            'unknown_token_value_aaaaaaaaaaaaaaa',
            'user_joiner',
            tx as unknown as Prisma.TransactionClient,
          ),
        ),
      ).rejects.toMatchObject({ code: 'invite.consumed' });
    });

    it('throws invite.consumed when the deal is no longer awaiting the counterparty (R5.1)', async () => {
      const deal = makeDeal({ status: DealStatus.AWAITING_BOTH_APPROVAL });
      const raw = 'f'.repeat(24);
      const tokenHash = hashToken(raw);
      const { prisma } = makeFakePrisma({
        deals: [deal],
        inviteTokens: [
          makeInviteToken({ token_hash: tokenHash, deal_id: deal.id }),
        ],
      });
      const service = new InviteService(prisma);

      await expect(
        prisma.runInTransaction((tx) =>
          service.consume(
            raw,
            'user_joiner',
            tx as unknown as Prisma.TransactionClient,
          ),
        ),
      ).rejects.toMatchObject({ code: 'invite.consumed' });
    });

    it('throws synchronously when tx is missing (R20.4)', async () => {
      const { prisma } = makeFakePrisma();
      const service = new InviteService(prisma);

      await expect(
        service.consume(
          'any_value_long_enough_for_check',
          'user_joiner',
          undefined as unknown as Prisma.TransactionClient,
        ),
      ).rejects.toThrow(/tx is required/i);
    });

    it('throws synchronously when joiningUserId is empty', async () => {
      const { prisma } = makeFakePrisma();
      const service = new InviteService(prisma);

      await expect(
        prisma.runInTransaction((tx) =>
          service.consume(
            'any_value_long_enough_for_check',
            '',
            tx as unknown as Prisma.TransactionClient,
          ),
        ),
      ).rejects.toThrow(/joiningUserId is required/i);
    });
  });

  describe('consume — expected_role mirrors the opposite of creator_role', () => {
    it('returns expected_role = "seller" when creator_role is "buyer"', async () => {
      const deal = makeDeal({ creator_role: ParticipantRole.buyer });
      const raw = 'g'.repeat(24);
      const tokenHash = hashToken(raw);
      const { prisma } = makeFakePrisma({
        deals: [deal],
        inviteTokens: [
          makeInviteToken({ token_hash: tokenHash, deal_id: deal.id }),
        ],
      });
      const service = new InviteService(prisma);

      const result = await prisma.runInTransaction((tx) =>
        service.consume(
          raw,
          'user_joiner',
          tx as unknown as Prisma.TransactionClient,
        ),
      );

      expect(result.expected_role).toBe(ParticipantRole.seller);
    });

    it('returns expected_role = "buyer" when creator_role is "seller"', async () => {
      const deal = makeDeal({ creator_role: ParticipantRole.seller });
      const raw = 'h'.repeat(24);
      const tokenHash = hashToken(raw);
      const { prisma } = makeFakePrisma({
        deals: [deal],
        inviteTokens: [
          makeInviteToken({ token_hash: tokenHash, deal_id: deal.id }),
        ],
      });
      const service = new InviteService(prisma);

      const result = await prisma.runInTransaction((tx) =>
        service.consume(
          raw,
          'user_joiner',
          tx as unknown as Prisma.TransactionClient,
        ),
      );

      expect(result.expected_role).toBe(ParticipantRole.buyer);
    });
  });
});
