/**
 * Unit tests for `DealController.join` — task 5.8.
 *
 * Source of truth: tasks.md §5.8; requirements.md R5.1–R5.10;
 * design.md §"DealService → join".
 *
 * # Scope
 *
 * Pure unit tests against the controller. We hand-fake every
 * collaborator (`DealService`, `InviteService`, `AuditService`,
 * `PrismaService`) so the test exercises the controller's
 * orchestration logic — argument shapes, transaction boundary, error
 * envelope — without spinning up a real Prisma client.
 *
 * # Coverage
 *
 *   1. Happy path — the join transaction:
 *        - calls `inviteService.consume(rawInvite, currentUser.id, tx)`,
 *        - validates the deal_id matches the URL deal,
 *        - inserts the `DealParticipant` row,
 *        - mints a `ParticipantAccessToken` (raw returned, hash stored),
 *        - calls `dealService.transition(deal, AWAITING_BOTH_APPROVAL,
 *          actor, tx)`,
 *        - calls `auditService.record({action_type:
 *          'DEAL_PARTICIPANT_JOINED', ...}, tx)`,
 *        - enqueues `COUNTERPARTY_JOINED` outbox row,
 *        - returns the standard envelope plus
 *          `raw_participant_access_token`.
 *   2. Invalid invite — `InviteService.consume` throws
 *      `invite.consumed`; the controller surfaces it.
 *   3. Deal/invite mismatch — `consume` returns a `deal_id` that does
 *      not match the URL deal → `invite.invalid` 404.
 *   4. Already-joined (P2002 unique-violation on
 *      `dealParticipant.create`) → `deal.already_joined` 409.
 *   5. Missing deal → `deal.not_found` 404.
 *   6. Missing role-appropriate name → `join.invalid_field` 400.
 *
 * # Why fake the `tx`
 *
 * `runInTransaction` is mocked to invoke its callback with a fake
 * `tx` whose `dealRoom`, `dealParticipant`, `participantAccessToken`,
 * and `notificationOutboxEntry` delegates are jest mocks. This lets
 * us pin the order of writes and assert on the exact arguments
 * threaded through the transaction without a real database.
 */

import { Prisma, type DealRoom } from '@prisma/client';
import { Decimal } from 'decimal.js';

import type { AuditService } from '../audit';
import {
  Currency,
  CreatorSource,
  DealStatus,
  NotificationEvent,
  ParticipantRole,
} from '../common/enums';
import { DomainException } from '../common/errors';
import { hashToken } from '../common/tokens';
import type { PrismaService } from '../prisma';

import type { ApprovalService } from './approval.service';
import { DealController } from './deal.controller';
import type { DealService } from './deal.service';
import type { InviteService } from './invite.service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEAL_ID = 'deal_id_1';
const PUBLIC_ID = 'pub_abc123';
const CURRENT_USER_ID = 'user_joiner';
const CURRENT_USER_DISPLAY_NAME = 'Alice Joiner';
const RAW_INVITE = 'a'.repeat(24);

function makeDeal(overrides: Partial<DealRoom> = {}): DealRoom {
  const now = new Date('2026-06-01T00:00:00.000Z');
  return {
    id: DEAL_ID,
    public_id: PUBLIC_ID,
    creator_user_id: 'user_creator',
    creator_role: ParticipantRole.seller,
    creator_source: CreatorSource.web,
    status: DealStatus.AWAITING_COUNTERPARTY,
    product_title: 'Vintage Camera',
    product_type: 'electronics',
    product_description: null,
    quantity: 1,
    condition: 'used',
    deal_amount: new Decimal('150.00') as unknown as Prisma.Decimal,
    currency: Currency.USD,
    buyer_name: null,
    seller_name: 'Bob Seller',
    reference_note: null,
    khqr_payload_meta: null,
    terms_hash: null,
    created_at: now,
    updated_at: now,
    expires_at: null,
    ...overrides,
  } as unknown as DealRoom;
}

function makeUser(): {
  id: string;
  email: string | null;
  display_name: string | null;
  preferred_lang: 'km' | 'en' | 'zh';
  is_admin: boolean;
} {
  return {
    id: CURRENT_USER_ID,
    email: 'alice@example.com',
    display_name: CURRENT_USER_DISPLAY_NAME,
    preferred_lang: 'en',
    is_admin: false,
  };
}

interface FakeTxConfig {
  deal?: DealRoom | null;
  /**
   * When set, `dealParticipant.create` rejects with this error to
   * simulate a P2002 unique-violation race.
   */
  participantCreateError?: unknown;
}

function makeFakeTx(config: FakeTxConfig = {}) {
  const deal = config.deal === null ? null : (config.deal ?? makeDeal());
  const dealAfterUpdate = deal
    ? makeDeal({
        ...deal,
        status: DealStatus.AWAITING_BOTH_APPROVAL,
      })
    : null;

  const participantCreate = jest.fn();
  if (config.participantCreateError !== undefined) {
    participantCreate.mockRejectedValue(config.participantCreateError);
  } else {
    participantCreate.mockResolvedValue({ id: 'part_1' });
  }

  const dealRoomFindUnique = jest
    .fn()
    // First call: pre-write read by `public_id`.
    .mockResolvedValueOnce(deal)
    // Second call: post-write read by `id` (after `transition` flipped status).
    .mockResolvedValueOnce(dealAfterUpdate);

  const dealRoomUpdate = jest
    .fn()
    .mockImplementation(async (args: { data: Partial<DealRoom> }) => ({
      ...deal,
      ...args.data,
    }));

  const tx = {
    dealRoom: {
      findUnique: dealRoomFindUnique,
      update: dealRoomUpdate,
    },
    dealParticipant: {
      create: participantCreate,
    },
    participantAccessToken: {
      create: jest.fn().mockResolvedValue({ id: 'pat_1' }),
    },
    notificationOutboxEntry: {
      create: jest.fn().mockResolvedValue({ id: BigInt(1) }),
    },
  } as unknown as Prisma.TransactionClient;

  return { tx, deal, dealAfterUpdate };
}

interface BuildControllerOptions {
  txConfig?: FakeTxConfig;
  inviteConsumeResult?: { deal_id: string; expected_role: ParticipantRole };
  inviteConsumeError?: unknown;
  /** Override the deal returned by `dealService.transition`. */
  transitionedDeal?: DealRoom;
}

function buildController(opts: BuildControllerOptions = {}) {
  const { tx, deal, dealAfterUpdate } = makeFakeTx(opts.txConfig);

  const prisma = {
    runInTransaction: jest.fn(
      async <T,>(fn: (txArg: Prisma.TransactionClient) => Promise<T>) =>
        fn(tx),
    ),
  } as unknown as PrismaService;

  const dealService = {
    transition: jest
      .fn()
      .mockResolvedValue(opts.transitionedDeal ?? dealAfterUpdate ?? deal),
    computeAllowedActions: jest
      .fn()
      .mockReturnValue(['edit_product', 'edit_participant', 'approve']),
  } as unknown as DealService;

  const inviteService = {
    consume: jest.fn(),
  } as unknown as InviteService;
  if (opts.inviteConsumeError !== undefined) {
    (inviteService.consume as jest.Mock).mockRejectedValue(
      opts.inviteConsumeError,
    );
  } else {
    (inviteService.consume as jest.Mock).mockResolvedValue(
      opts.inviteConsumeResult ?? {
        deal_id: DEAL_ID,
        expected_role: ParticipantRole.buyer,
      },
    );
  }

  const auditService = {
    record: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuditService;

  // The 5.9 sibling's controller also injects ApprovalService — provide a
  // stub so the constructor signature is satisfied; `join` never calls it.
  const approvalService = {
    recordApproval: jest.fn(),
  } as unknown as ApprovalService;

  // task 5.6 sibling — `DealSectionPatchService` is injected last; the
  // join flow never invokes it, so a bare stub satisfies the
  // constructor signature.
  const sectionPatchService = {
    patchProduct: jest.fn(),
    patchParticipant: jest.fn(),
    patchDelivery: jest.fn(),
    patchPayout: jest.fn(),
  } as unknown as import('./deal-section-patch.service').DealSectionPatchService;

  const controller = new DealController(
    dealService,
    approvalService,
    prisma,
    inviteService,
    auditService,
    sectionPatchService,
  );

  return {
    controller,
    tx,
    prisma,
    dealService,
    inviteService,
    auditService,
    deal,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DealController.join (task 5.8)', () => {
  // -------------------------------------------------------------------------
  // 1. Happy path
  // -------------------------------------------------------------------------
  it('runs the full join transaction: consume → participant insert → token mint → transition → audit → response', async () => {
    const { controller, tx, prisma, dealService, inviteService, auditService } =
      buildController();

    const result = await controller.join(
      PUBLIC_ID,
      {
        invite: RAW_INVITE,
        buyer_name: 'Alice Joiner',
        phone: '+855 12 345 678',
      },
      makeUser() as never,
    );

    // The controller opened exactly one transaction.
    expect(prisma.runInTransaction).toHaveBeenCalledTimes(1);

    // 1. Pre-write deal lookup by public_id.
    expect((tx.dealRoom.findUnique as jest.Mock).mock.calls[0][0]).toEqual({
      where: { public_id: PUBLIC_ID },
    });

    // 2. consume(rawInvite, currentUser.id, tx).
    expect(inviteService.consume).toHaveBeenCalledTimes(1);
    expect((inviteService.consume as jest.Mock).mock.calls[0]).toEqual([
      RAW_INVITE,
      CURRENT_USER_ID,
      tx,
    ]);

    // 3. DealParticipant insert with correct role + phone.
    expect(tx.dealParticipant.create).toHaveBeenCalledTimes(1);
    expect((tx.dealParticipant.create as jest.Mock).mock.calls[0][0]).toEqual({
      data: {
        deal_id: DEAL_ID,
        user_id: CURRENT_USER_ID,
        role: ParticipantRole.buyer,
        phone: '+855 12 345 678',
      },
    });

    // 4. Name backfill on the deal row (buyer_name was null).
    expect(tx.dealRoom.update).toHaveBeenCalledTimes(1);
    expect((tx.dealRoom.update as jest.Mock).mock.calls[0][0]).toEqual({
      where: { id: DEAL_ID },
      data: { buyer_name: 'Alice Joiner' },
    });

    // 5. ParticipantAccessToken mint — hash stored, raw returned in response.
    expect(tx.participantAccessToken.create).toHaveBeenCalledTimes(1);
    const tokenCall = (tx.participantAccessToken.create as jest.Mock).mock
      .calls[0][0];
    expect(tokenCall.data.deal_id).toBe(DEAL_ID);
    expect(tokenCall.data.user_id).toBe(CURRENT_USER_ID);
    // The stored value must be a SHA-256 hex digest (64 lowercase hex chars).
    expect(tokenCall.data.token_hash).toMatch(/^[0-9a-f]{64}$/);
    // The raw token must be in the response and match the stored hash.
    expect(typeof result.raw_participant_access_token).toBe('string');
    expect(hashToken(result.raw_participant_access_token)).toBe(
      tokenCall.data.token_hash,
    );

    // 6. Status transition: AWAITING_COUNTERPARTY → AWAITING_BOTH_APPROVAL.
    expect(dealService.transition).toHaveBeenCalledTimes(1);
    const [transitionDeal, transitionTo, transitionActor, transitionTx] =
      (dealService.transition as jest.Mock).mock.calls[0];
    expect(transitionDeal.id).toBe(DEAL_ID);
    expect(transitionTo).toBe(DealStatus.AWAITING_BOTH_APPROVAL);
    expect(transitionActor).toEqual({
      user_id: CURRENT_USER_ID,
      role: ParticipantRole.buyer,
    });
    expect(transitionTx).toBe(tx);

    // 7. Audit row: DEAL_PARTICIPANT_JOINED with metadata.invite_consumed.
    expect(auditService.record).toHaveBeenCalledTimes(1);
    const [auditEntry, auditTx] =
      (auditService.record as jest.Mock).mock.calls[0];
    expect(auditEntry).toMatchObject({
      action_type: 'DEAL_PARTICIPANT_JOINED',
      actor_user_id: CURRENT_USER_ID,
      actor_role: ParticipantRole.buyer,
      deal_id: DEAL_ID,
      metadata: { invite_consumed: true },
    });
    expect(auditTx).toBe(tx);

    // 8. COUNTERPARTY_JOINED outbox row.
    expect(tx.notificationOutboxEntry.create).toHaveBeenCalledTimes(1);
    const outboxCall = (tx.notificationOutboxEntry.create as jest.Mock).mock
      .calls[0][0];
    expect(outboxCall.data.event).toBe(NotificationEvent.COUNTERPARTY_JOINED);
    expect(outboxCall.data.payload).toMatchObject({
      deal_id: DEAL_ID,
      actor_user_id: CURRENT_USER_ID,
      joined_role: ParticipantRole.buyer,
    });

    // 9. Response envelope shape.
    expect(result.deal.public_id).toBe(PUBLIC_ID);
    expect(result.deal.status).toBe(DealStatus.AWAITING_BOTH_APPROVAL);
    expect(Array.isArray(result.missing_fields)).toBe(true);
    expect(Array.isArray(result.allowed_actions)).toBe(true);
    expect(typeof result.raw_participant_access_token).toBe('string');
  });

  // -------------------------------------------------------------------------
  // 2. Invalid invite token
  // -------------------------------------------------------------------------
  it('propagates invite.consumed when InviteService.consume rejects', async () => {
    const { controller, tx } = buildController({
      inviteConsumeError: DomainException.badRequest('invite.consumed'),
    });

    await expect(
      controller.join(
        PUBLIC_ID,
        { invite: RAW_INVITE, buyer_name: 'Alice' },
        makeUser() as never,
      ),
    ).rejects.toMatchObject({ code: 'invite.consumed' });

    // The participant row, token mint, transition, audit, and outbox
    // writes must not run after consume fails.
    expect(tx.dealParticipant.create).not.toHaveBeenCalled();
    expect(tx.participantAccessToken.create).not.toHaveBeenCalled();
    expect(tx.notificationOutboxEntry.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. Deal / invite mismatch
  // -------------------------------------------------------------------------
  it('throws invite.invalid when consume returns a deal_id that does not match the URL deal', async () => {
    const { controller, tx } = buildController({
      inviteConsumeResult: {
        deal_id: 'some_other_deal',
        expected_role: ParticipantRole.buyer,
      },
    });

    await expect(
      controller.join(
        PUBLIC_ID,
        { invite: RAW_INVITE, buyer_name: 'Alice' },
        makeUser() as never,
      ),
    ).rejects.toMatchObject({ code: 'invite.invalid' });

    expect(tx.dealParticipant.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. Already joined — P2002 unique-violation race
  // -------------------------------------------------------------------------
  it('throws deal.already_joined on a P2002 unique-violation from dealParticipant.create', async () => {
    const p2002 = Object.assign(new Error('Unique constraint failed'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
    });

    const { controller, tx, dealService, auditService } = buildController({
      txConfig: { participantCreateError: p2002 },
    });

    await expect(
      controller.join(
        PUBLIC_ID,
        { invite: RAW_INVITE, buyer_name: 'Alice' },
        makeUser() as never,
      ),
    ).rejects.toMatchObject({ code: 'deal.already_joined' });

    // No follow-up writes happened — the conflict aborted the
    // transaction at step 5.
    expect(tx.participantAccessToken.create).not.toHaveBeenCalled();
    expect(dealService.transition).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. Missing deal
  // -------------------------------------------------------------------------
  it('throws deal.not_found when the public_id does not resolve to a deal', async () => {
    const { controller, tx, inviteService } = buildController({
      txConfig: { deal: null },
    });

    await expect(
      controller.join(
        'pub_does_not_exist',
        { invite: RAW_INVITE, buyer_name: 'Alice' },
        makeUser() as never,
      ),
    ).rejects.toMatchObject({ code: 'deal.not_found' });

    // We bail before consume is called, so the invite token is left
    // intact for a potential retry against the right deal.
    expect(inviteService.consume).not.toHaveBeenCalled();
    expect(tx.dealParticipant.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6. Missing role-appropriate name (R5.3 / R5.4 / R5.10)
  // -------------------------------------------------------------------------
  it('throws join.invalid_field when the role-appropriate name is missing', async () => {
    const { controller, tx } = buildController({
      // The invite resolved to `seller`, but the body only carries
      // `buyer_name` — that field is wrong-role and must be ignored.
      inviteConsumeResult: {
        deal_id: DEAL_ID,
        expected_role: ParticipantRole.seller,
      },
    });

    await expect(
      controller.join(
        PUBLIC_ID,
        { invite: RAW_INVITE, buyer_name: 'Alice' },
        makeUser() as never,
      ),
    ).rejects.toMatchObject({ code: 'join.invalid_field' });

    expect(tx.dealParticipant.create).not.toHaveBeenCalled();
  });
});
