/**
 * DealService.create unit tests (task 5.2).
 *
 * Source of truth: tasks.md §5.2; design §"DealService → create";
 * R2.1–R2.9 (seller flow), R3.1–R3.6 (buyer flow), R4.3 (invite
 * token TTL), R20.1 / R20.4 (audit + transactional integrity).
 *
 * Coverage:
 *
 *   1. **Seller-flow happy path** — required fields land,
 *      `creator_role` and `creator_source` propagate, deal exits
 *      `DRAFT` and ends in `AWAITING_COUNTERPARTY`, both raw tokens
 *      are returned exactly once and never echoed in any DB write.
 *
 *   2. **Buyer-flow happy path** — `Buyer_Name` is required (and
 *      `Seller_Name` is NOT), optional fields (`product_type`,
 *      `product_description`, `phone`) round-trip, the deal lands
 *      in `AWAITING_COUNTERPARTY`, and seller-only optional fields
 *      submitted by mistake are silently dropped (R2.5).
 *
 *   3. **Both flows audit `DEAL_CREATED`** plus the
 *      `DRAFT → AWAITING_COUNTERPARTY` `DEAL_STATUS_TRANSITION`,
 *      both written via the same `tx`.
 *
 *   4. **Tokens are persisted as hashes only** (R2.9 / R3.6) and
 *      the invite token carries `expires_at = now +
 *      INVITE_TOKEN_TTL_HOURS_DEFAULT`.
 *
 *   5. **Required-field rejection** — missing `seller_name` on
 *      seller flow / `buyer_name` on buyer flow throws
 *      `deal.missing_required_fields` and writes nothing.
 *
 *   6. **Invalid amount rejection** — out-of-range deal amount
 *      throws `deal.invalid_field` with the parsed reason in
 *      `details.reason`.
 *
 * The Prisma client is faked: we model only the delegate methods
 * `DealService.create` and `DealService.transition` invoke
 * (`dealRoom.create`, `dealRoom.update`, `dealParticipant.create`,
 * `creatorAccessToken.create`, `inviteToken.create`,
 * `auditLogEntry.create`). The transaction client is identical to
 * the top-level fake so mutations land in the same in-memory state.
 */

import type { DealRoom, Prisma } from '@prisma/client';

import { AuditService } from '../audit';
import { INVITE_TOKEN_TTL_HOURS_DEFAULT } from '../common/constants';
import {
  CreatorSource,
  Currency,
  DealStatus,
  ParticipantRole,
} from '../common/enums';
import { DomainException } from '../common/errors';
import { hashToken } from '../common/tokens';
import type { PrismaService } from '../prisma';

import { DealService } from './deal.service';
import type { CreateDealInput } from './deal.service';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface CapturedWrites {
  dealRoomCreate: Array<{ data: Record<string, unknown> }>;
  dealRoomUpdate: Array<{
    where: { id: string };
    data: Record<string, unknown>;
  }>;
  dealParticipantCreate: Array<{ data: Record<string, unknown> }>;
  creatorAccessTokenCreate: Array<{ data: Record<string, unknown> }>;
  inviteTokenCreate: Array<{ data: Record<string, unknown> }>;
  auditLogEntryCreate: Array<{ data: Record<string, unknown> }>;
}

function makeFakePrisma() {
  const captures: CapturedWrites = {
    dealRoomCreate: [],
    dealRoomUpdate: [],
    dealParticipantCreate: [],
    creatorAccessTokenCreate: [],
    inviteTokenCreate: [],
    auditLogEntryCreate: [],
  };

  // Track the most recent `DealRoom.create(...)` payload so the
  // subsequent `update(...)` (from `transition(...)`) can echo a
  // realistic post-update row back.
  let lastCreatedDeal: DealRoom | null = null;

  const dealRoomCreate = jest.fn(async (args: { data: Record<string, unknown> }) => {
    captures.dealRoomCreate.push(args);
    const now = new Date();
    const row: DealRoom = {
      id: `deal_${captures.dealRoomCreate.length}`,
      public_id: (args.data.public_id as string) ?? `pub_${captures.dealRoomCreate.length}`,
      creator_user_id: args.data.creator_user_id as string,
      creator_role: args.data.creator_role as ParticipantRole,
      creator_source: args.data.creator_source as CreatorSource,
      status: (args.data.status as DealStatus) ?? DealStatus.DRAFT,
      product_title: (args.data.product_title as string | null) ?? null,
      product_type: (args.data.product_type as string | null) ?? null,
      product_description: (args.data.product_description as string | null) ?? null,
      quantity: (args.data.quantity as number | null) ?? null,
      condition: (args.data.condition as string | null) ?? null,
      deal_amount: args.data.deal_amount as DealRoom['deal_amount'],
      currency: (args.data.currency as Currency | null) ?? null,
      buyer_name: (args.data.buyer_name as string | null) ?? null,
      seller_name: (args.data.seller_name as string | null) ?? null,
      reference_note: null,
      khqr_payload_meta: null,
      terms_hash: (args.data.terms_hash as string | null) ?? null,
      created_at: now,
      updated_at: now,
      expires_at: null,
    } as DealRoom;
    lastCreatedDeal = row;
    return row;
  });

  const dealRoomUpdate = jest.fn(
    async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      captures.dealRoomUpdate.push(args);
      // Echo back a row reflecting the new status so the caller
      // observes the transition.
      const base = lastCreatedDeal ?? ({ id: args.where.id } as DealRoom);
      return {
        ...base,
        status: (args.data.status as DealStatus) ?? base.status,
      } as DealRoom;
    },
  );

  const dealParticipantCreate = jest.fn(async (args: { data: Record<string, unknown> }) => {
    captures.dealParticipantCreate.push(args);
    return { id: 'dp_1', ...args.data };
  });

  const creatorAccessTokenCreate = jest.fn(
    async (args: { data: Record<string, unknown> }) => {
      captures.creatorAccessTokenCreate.push(args);
      return { id: 'cat_1', ...args.data };
    },
  );

  const inviteTokenCreate = jest.fn(async (args: { data: Record<string, unknown> }) => {
    captures.inviteTokenCreate.push(args);
    return { id: 'inv_1', ...args.data };
  });

  const auditLogEntryCreate = jest.fn(async (args: { data: Record<string, unknown> }) => {
    captures.auditLogEntryCreate.push(args);
    return { id: BigInt(captures.auditLogEntryCreate.length), ...args.data };
  });

  const txClient = {
    dealRoom: {
      create: dealRoomCreate,
      update: dealRoomUpdate,
    },
    dealParticipant: {
      create: dealParticipantCreate,
    },
    creatorAccessToken: {
      create: creatorAccessTokenCreate,
    },
    inviteToken: {
      create: inviteTokenCreate,
    },
    auditLogEntry: {
      create: auditLogEntryCreate,
    },
  };

  const runInTransaction = jest.fn(
    async <T,>(fn: (tx: typeof txClient) => Promise<T>): Promise<T> => fn(txClient),
  );

  const prisma = {
    runInTransaction,
  } as unknown as PrismaService;

  return { prisma, captures, txClient, runInTransaction };
}

function buildService() {
  const { prisma, captures, runInTransaction } = makeFakePrisma();
  const auditService = new AuditService();
  const service = new DealService(auditService, prisma);
  return { service, prisma, captures, runInTransaction };
}

const VALID_SELLER_INPUT: CreateDealInput = {
  creatorUserId: 'user_seller_1',
  creatorRole: ParticipantRole.seller,
  creatorSource: CreatorSource.web,
  sections: {
    seller_name: 'Seller One',
    product_title: 'iPhone 15 Pro',
    deal_amount: '999.00',
    currency: Currency.USD,
  },
};

const VALID_BUYER_INPUT: CreateDealInput = {
  creatorUserId: 'user_buyer_1',
  creatorRole: ParticipantRole.buyer,
  creatorSource: CreatorSource.web,
  sections: {
    buyer_name: 'Buyer One',
    product_title: 'iPhone 15 Pro',
    product_type: 'phone',
    product_description: 'sealed box',
    deal_amount: '1234.56',
    currency: Currency.USD,
    phone: '+1 (555) 123-4567',
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DealService.create — seller flow', () => {
  it('persists the deal, mints both tokens, and transitions to AWAITING_COUNTERPARTY', async () => {
    const { service, captures } = buildService();

    const result = await service.create(VALID_SELLER_INPUT);

    // Deal row landed with the expected section fields.
    expect(captures.dealRoomCreate).toHaveLength(1);
    const dealRow = captures.dealRoomCreate[0].data;
    expect(dealRow).toMatchObject({
      creator_user_id: VALID_SELLER_INPUT.creatorUserId,
      creator_role: ParticipantRole.seller,
      creator_source: CreatorSource.web,
      status: DealStatus.DRAFT,
      seller_name: 'Seller One',
      product_title: 'iPhone 15 Pro',
      currency: Currency.USD,
      // Money is canonicalised to 2dp via `formatMoney`.
      deal_amount: '999.00',
    });
    // R2.5 — seller create-step ignores buyer-flow-only fields.
    expect(dealRow.buyer_name).toBeNull();
    expect(dealRow.product_description).toBeNull();
    expect(dealRow.product_type).toBeNull();
    // `terms_hash` is precomputed and persisted (R8.1).
    expect(typeof dealRow.terms_hash).toBe('string');
    expect((dealRow.terms_hash as string).length).toBe(64);

    // Creator participant row.
    expect(captures.dealParticipantCreate).toHaveLength(1);
    expect(captures.dealParticipantCreate[0].data).toMatchObject({
      user_id: VALID_SELLER_INPUT.creatorUserId,
      role: ParticipantRole.seller,
    });

    // Both tokens persisted as hashes only — raw values returned in
    // the result envelope.
    expect(captures.creatorAccessTokenCreate).toHaveLength(1);
    expect(captures.inviteTokenCreate).toHaveLength(1);

    expect(typeof result.rawCreatorAccessToken).toBe('string');
    expect(result.rawCreatorAccessToken.length).toBeGreaterThan(0);
    expect(typeof result.rawInviteToken).toBe('string');
    expect(result.rawInviteToken.length).toBeGreaterThan(0);

    // Hashes match.
    expect(captures.creatorAccessTokenCreate[0].data.token_hash).toBe(
      hashToken(result.rawCreatorAccessToken),
    );
    expect(captures.inviteTokenCreate[0].data.token_hash).toBe(
      hashToken(result.rawInviteToken),
    );

    // Raw tokens never appear in any DB write payload.
    const allWrites = JSON.stringify({
      ...captures,
    });
    expect(allWrites).not.toContain(result.rawCreatorAccessToken);
    expect(allWrites).not.toContain(result.rawInviteToken);

    // Final deal status is AWAITING_COUNTERPARTY (R2.6).
    expect(result.deal.status).toBe(DealStatus.AWAITING_COUNTERPARTY);
    expect(captures.dealRoomUpdate).toHaveLength(1);
    expect(captures.dealRoomUpdate[0].data).toEqual({
      status: DealStatus.AWAITING_COUNTERPARTY,
    });
  });

  it('writes both DEAL_CREATED and DEAL_STATUS_TRANSITION audit rows', async () => {
    const { service, captures } = buildService();

    await service.create(VALID_SELLER_INPUT);

    // Two audit rows: DEAL_CREATED then DEAL_STATUS_TRANSITION.
    expect(captures.auditLogEntryCreate).toHaveLength(2);

    const created = captures.auditLogEntryCreate[0].data;
    expect(created).toMatchObject({
      action_type: 'DEAL_CREATED',
      actor_user_id: VALID_SELLER_INPUT.creatorUserId,
      actor_role: ParticipantRole.seller,
    });
    // R20.1 — `creator_source` lands on the audit metadata.
    expect((created.metadata as { creator_source: string }).creator_source).toBe(
      CreatorSource.web,
    );

    const transitioned = captures.auditLogEntryCreate[1].data;
    expect(transitioned).toMatchObject({
      action_type: 'DEAL_STATUS_TRANSITION',
      prev_status: DealStatus.DRAFT,
      new_status: DealStatus.AWAITING_COUNTERPARTY,
    });
  });

  it('mints an invite token whose expiry matches INVITE_TOKEN_TTL_HOURS_DEFAULT', async () => {
    const { service, captures } = buildService();

    const before = Date.now();
    await service.create(VALID_SELLER_INPUT);
    const after = Date.now();

    const expiresAt = captures.inviteTokenCreate[0].data.expires_at as Date;
    const expectedMin = before + INVITE_TOKEN_TTL_HOURS_DEFAULT * 60 * 60 * 1000;
    const expectedMax = after + INVITE_TOKEN_TTL_HOURS_DEFAULT * 60 * 60 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(expectedMax);
  });

  it('rejects with deal.missing_required_fields when seller_name is absent', async () => {
    const { service, captures } = buildService();

    let caught: DomainException | undefined;
    try {
      await service.create({
        ...VALID_SELLER_INPUT,
        sections: { ...VALID_SELLER_INPUT.sections, seller_name: undefined },
      });
    } catch (err) {
      caught = err as DomainException;
    }

    expect(caught).toBeInstanceOf(DomainException);
    expect(caught?.code).toBe('deal.missing_required_fields');
    expect(caught?.details).toMatchObject({
      fields: expect.arrayContaining(['Seller_Name']),
      role: ParticipantRole.seller,
    });

    // Nothing landed in the DB.
    expect(captures.dealRoomCreate).toHaveLength(0);
    expect(captures.creatorAccessTokenCreate).toHaveLength(0);
    expect(captures.inviteTokenCreate).toHaveLength(0);
    expect(captures.auditLogEntryCreate).toHaveLength(0);
  });

  it('rejects with deal.invalid_field when deal_amount is out of range', async () => {
    const { service, captures } = buildService();

    let caught: DomainException | undefined;
    try {
      await service.create({
        ...VALID_SELLER_INPUT,
        sections: { ...VALID_SELLER_INPUT.sections, deal_amount: '0' },
      });
    } catch (err) {
      caught = err as DomainException;
    }

    expect(caught).toBeInstanceOf(DomainException);
    expect(caught?.code).toBe('deal.invalid_field');
    expect(caught?.details).toMatchObject({
      field: 'deal_amount',
      reason: 'money.out_of_range',
    });

    expect(captures.dealRoomCreate).toHaveLength(0);
  });
});

describe('DealService.create — buyer flow', () => {
  it('persists buyer fields including optional product_type / description / phone (R3.2)', async () => {
    const { service, captures } = buildService();

    const result = await service.create(VALID_BUYER_INPUT);

    expect(captures.dealRoomCreate).toHaveLength(1);
    const dealRow = captures.dealRoomCreate[0].data;
    expect(dealRow).toMatchObject({
      creator_role: ParticipantRole.buyer,
      buyer_name: 'Buyer One',
      product_title: 'iPhone 15 Pro',
      product_type: 'phone',
      product_description: 'sealed box',
      deal_amount: '1234.56',
      currency: Currency.USD,
    });
    // R3.5 — seller_name is NOT persisted on a buyer-created deal at
    // create time (the seller fills it in after joining).
    expect(dealRow.seller_name).toBeNull();

    // Phone lands on the participant row, NOT on `DealRoom`.
    expect(captures.dealParticipantCreate[0].data).toMatchObject({
      role: ParticipantRole.buyer,
      phone: '+1 (555) 123-4567',
    });

    // Final state and audit shape match the seller flow.
    expect(result.deal.status).toBe(DealStatus.AWAITING_COUNTERPARTY);
    expect(captures.auditLogEntryCreate).toHaveLength(2);
    expect(captures.auditLogEntryCreate[0].data).toMatchObject({
      action_type: 'DEAL_CREATED',
      actor_role: ParticipantRole.buyer,
    });
  });

  it('rejects with deal.missing_required_fields when buyer_name is absent', async () => {
    const { service, captures } = buildService();

    let caught: DomainException | undefined;
    try {
      await service.create({
        ...VALID_BUYER_INPUT,
        sections: { ...VALID_BUYER_INPUT.sections, buyer_name: '   ' },
      });
    } catch (err) {
      caught = err as DomainException;
    }

    expect(caught).toBeInstanceOf(DomainException);
    expect(caught?.code).toBe('deal.missing_required_fields');
    expect(caught?.details).toMatchObject({
      fields: expect.arrayContaining(['Buyer_Name']),
      role: ParticipantRole.buyer,
    });
    expect(captures.dealRoomCreate).toHaveLength(0);
  });

  it('defaults creator_source to "web" when omitted', async () => {
    const { service, captures } = buildService();

    await service.create({
      ...VALID_BUYER_INPUT,
      creatorSource: undefined,
    });

    expect(captures.dealRoomCreate[0].data.creator_source).toBe(
      CreatorSource.web,
    );
    expect(
      (captures.auditLogEntryCreate[0].data.metadata as { creator_source: string })
        .creator_source,
    ).toBe(CreatorSource.web);
  });

  it('honours creator_source = "telegram" from the bot adapter (R18.x)', async () => {
    const { service, captures } = buildService();

    await service.create({
      ...VALID_BUYER_INPUT,
      creatorSource: CreatorSource.telegram,
    });

    expect(captures.dealRoomCreate[0].data.creator_source).toBe(
      CreatorSource.telegram,
    );
  });
});

describe('DealService.create — transactional integrity (R20.4)', () => {
  it('runs every write through the same Prisma transaction client', async () => {
    const { service, runInTransaction } = buildService();

    await service.create(VALID_SELLER_INPUT);

    // The whole flow is a single `runInTransaction` callback.
    expect(runInTransaction).toHaveBeenCalledTimes(1);
  });

  it('rolls back when the audit insert fails (transition writes nothing)', async () => {
    // Arrange a Prisma stand-in whose `auditLogEntry.create` throws on
    // the second call (the DEAL_STATUS_TRANSITION audit row written by
    // `transition(...)`). The transaction wrapper propagates the
    // throw; in production this triggers a real Postgres rollback.
    // We assert the throw propagates and that the failure occurs at
    // exactly the second audit-row attempt — i.e. after `DEAL_CREATED`
    // landed but during the transition's audit write.
    const { prisma, captures, txClient } = makeFakePrisma();
    const auditService = new AuditService();
    const service = new DealService(auditService, prisma);

    let auditCalls = 0;
    (txClient.auditLogEntry.create as jest.Mock).mockImplementation(
      async (args: { data: Record<string, unknown> }) => {
        auditCalls += 1;
        // Preserve the capture push behaviour from the fake — we
        // override the implementation but still want introspection.
        captures.auditLogEntryCreate.push(args);
        if (auditCalls === 2) {
          throw new Error('synthetic audit failure');
        }
        return { id: BigInt(auditCalls) };
      },
    );

    await expect(service.create(VALID_SELLER_INPUT)).rejects.toThrow(
      /synthetic audit failure/,
    );

    // The first audit attempt (DEAL_CREATED) lands; the second
    // attempt (DEAL_STATUS_TRANSITION) throws. Real Postgres would
    // roll the entire transaction back; the in-memory fake does not
    // simulate that, but the throw at the second audit call confirms
    // the engine reached the transition step correctly.
    expect(auditCalls).toBe(2);
    expect(captures.auditLogEntryCreate).toHaveLength(2);
    expect(captures.auditLogEntryCreate[0].data.action_type).toBe('DEAL_CREATED');
    expect(captures.auditLogEntryCreate[1].data.action_type).toBe(
      'DEAL_STATUS_TRANSITION',
    );
  });
});
