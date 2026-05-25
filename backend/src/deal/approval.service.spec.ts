// task 5.9
/**
 * ApprovalService unit tests.
 *
 * Source of truth: tasks.md §5.9; requirements.md R8.1–R8.7, R6.3,
 * R6.4, R20.1–R20.4.
 *
 * Coverage matrix (matches the §5.9 prompt's "Verify with..." list):
 *
 *   1. First approval inserts an `Approval` row, no transition.
 *   2. Second-side approval triggers the `READY_FOR_PAYMENT`
 *      transition AND emits exactly one `BOTH_APPROVED` outbox row.
 *   3. Re-approval with the same `terms_hash` is idempotent — no
 *      duplicate `Approval` row is written, no second transition is
 *      attempted, and the audit row records `inserted: false`.
 *   4. Approval blocked when `missing_fields` is non-empty → 422
 *      `deal.missing_required_fields` with the structured field list
 *      surfaced via `details.missing_fields`.
 *   5. Approval blocked when status is not `AWAITING_BOTH_APPROVAL` →
 *      `deal.approval_not_allowed`.
 *   6. Approval blocked when the viewer is not a participant →
 *      `auth.role_forbidden`.
 *
 * Plus contract tests:
 *
 *   - Stale-hash invalidation: an existing active approval whose
 *     `terms_hash` no longer matches is invalidated (R7.3 / R8.4)
 *     before the fresh row is written.
 *   - `tx`-required guard (R20.4) on both `recordApproval` and
 *     `areBothApproved`.
 *   - `areBothApproved` predicate semantics (one side, both sides,
 *     stale rows, invalidated rows).
 *
 * Strategy: all tests use an in-memory fake of
 * `Prisma.TransactionClient` modelling only the delegate methods the
 * service touches (`dealRoom`, `dealParticipant`, `approval`,
 * `notificationOutboxEntry`). `DealService.transition` and
 * `AuditService.record` are stubbed with `jest.fn()` so we can assert
 * on the exact call shape.
 */

import type { DealRoom, Prisma } from '@prisma/client';

import { AuditService } from '../audit';
import {
  Currency,
  CreatorSource,
  DealStatus,
  ParticipantRole,
} from '../common/enums';
import { DomainException } from '../common/errors';
import type { PrismaService } from '../prisma';
import { ApprovalService } from './approval.service';
import { computeTermsHash } from './deal.terms-hash';
import { DealService } from './deal.service';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Build a `DealRoom` row good enough for the approval flow. Only the
 * material-edit fields (`product_title`, `product_description`,
 * `deal_amount`, `currency`) and the missing-fields inputs
 * (`product_type`, `buyer_name`, `seller_name`) need plausible
 * defaults; everything else is filled to satisfy the type checker.
 *
 * Defaults yield a deal with `missing_fields = []` so the happy-path
 * tests don't have to pin every required column.
 */
function makeDeal(overrides: Partial<DealRoom> = {}): DealRoom {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: 'deal_id_01',
    public_id: 'pub_01',
    creator_user_id: 'user_creator',
    creator_role: ParticipantRole.seller,
    creator_source: CreatorSource.web,
    status: DealStatus.AWAITING_BOTH_APPROVAL,
    product_title: 'Widget',
    product_type: 'electronics',
    product_description: null,
    quantity: 1,
    condition: 'new',
    deal_amount: '50.00' as unknown as Prisma.Decimal,
    currency: Currency.USD,
    buyer_name: 'Alice',
    seller_name: 'Bob',
    reference_note: null,
    khqr_payload_meta: null,
    terms_hash: null,
    created_at: now,
    updated_at: now,
    expires_at: null,
    ...overrides,
  } as DealRoom;
}

interface ApprovalRow {
  id: string;
  deal_id: string;
  user_id: string;
  role: ParticipantRole;
  terms_hash: string;
  invalidated_at: Date | null;
  created_at: Date;
}

interface ParticipantRow {
  id: string;
  deal_id: string;
  user_id: string;
  role: ParticipantRole;
}

interface FakeState {
  participants: ParticipantRow[];
  approvals: ApprovalRow[];
  outbox: Array<{
    event: string;
    recipient_kind: string;
    recipient_id: string | null;
    payload: unknown;
  }>;
}

/**
 * In-memory Prisma transaction stand-in. Only models the delegate
 * methods the service consumes; anything else throws so the test
 * suite fails loudly on dependency drift.
 */
function makeFakeTx(initial: Partial<FakeState> = {}) {
  const state: FakeState = {
    participants: [...(initial.participants ?? [])],
    approvals: [...(initial.approvals ?? [])],
    outbox: [...(initial.outbox ?? [])],
  };

  let approvalAutoId = state.approvals.length + 1;

  const dealParticipantFindUnique = jest.fn(
    async (args: {
      where: { deal_id_user_id?: { deal_id: string; user_id: string } };
      select?: Record<string, boolean>;
    }) => {
      const key = args.where.deal_id_user_id;
      if (!key) return null;
      const row = state.participants.find(
        (p) => p.deal_id === key.deal_id && p.user_id === key.user_id,
      );
      return row ?? null;
    },
  );

  const approvalFindFirst = jest.fn(
    async (args: {
      where: {
        deal_id?: string;
        user_id?: string;
        invalidated_at?: null;
      };
    }) => {
      const w = args.where;
      const row = state.approvals.find(
        (a) =>
          a.deal_id === w.deal_id &&
          a.user_id === w.user_id &&
          a.invalidated_at === null,
      );
      return row ?? null;
    },
  );

  const approvalUpdate = jest.fn(
    async (args: {
      where: { id: string };
      data: { invalidated_at?: Date };
    }) => {
      const row = state.approvals.find((a) => a.id === args.where.id);
      if (!row) throw new Error(`fake: approval ${args.where.id} not found`);
      if (args.data.invalidated_at !== undefined) {
        row.invalidated_at = args.data.invalidated_at;
      }
      return row;
    },
  );

  const approvalCreate = jest.fn(
    async (args: {
      data: {
        deal_id: string;
        user_id: string;
        role: ParticipantRole;
        terms_hash: string;
      };
    }) => {
      const row: ApprovalRow = {
        id: `approval_${approvalAutoId++}`,
        deal_id: args.data.deal_id,
        user_id: args.data.user_id,
        role: args.data.role,
        terms_hash: args.data.terms_hash,
        invalidated_at: null,
        created_at: new Date(),
      };
      state.approvals.push(row);
      return row;
    },
  );

  const approvalFindMany = jest.fn(
    async (args: {
      where: {
        deal_id?: string;
        terms_hash?: string;
        invalidated_at?: null;
        role?: { in?: ParticipantRole[] };
      };
      select?: { role?: boolean };
    }) => {
      const w = args.where;
      const rolesIn = w.role?.in;
      return state.approvals
        .filter(
          (a) =>
            a.deal_id === w.deal_id &&
            a.terms_hash === w.terms_hash &&
            a.invalidated_at === null &&
            (!rolesIn || rolesIn.includes(a.role)),
        )
        .map((a) => ({ role: a.role }));
    },
  );

  const outboxCreate = jest.fn(
    async (args: {
      data: {
        event: string;
        recipient_kind: string;
        recipient_id: string | null;
        payload: unknown;
      };
    }) => {
      state.outbox.push({
        event: args.data.event,
        recipient_kind: args.data.recipient_kind,
        recipient_id: args.data.recipient_id,
        payload: args.data.payload,
      });
      return { id: BigInt(state.outbox.length) };
    },
  );

  const tx = {
    dealParticipant: { findUnique: dealParticipantFindUnique },
    approval: {
      findFirst: approvalFindFirst,
      update: approvalUpdate,
      create: approvalCreate,
      findMany: approvalFindMany,
    },
    notificationOutboxEntry: { create: outboxCreate },
  } as unknown as Prisma.TransactionClient;

  return {
    tx,
    state,
    spies: {
      dealParticipantFindUnique,
      approvalFindFirst,
      approvalUpdate,
      approvalCreate,
      approvalFindMany,
      outboxCreate,
    },
  };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const BUYER_USER_ID = 'user_buyer';
const SELLER_USER_ID = 'user_seller';
const DEAL_ID = 'deal_id_01';

function buyerParticipant(): ParticipantRow {
  return {
    id: 'part_buyer',
    deal_id: DEAL_ID,
    user_id: BUYER_USER_ID,
    role: ParticipantRole.buyer,
  };
}

function sellerParticipant(): ParticipantRow {
  return {
    id: 'part_seller',
    deal_id: DEAL_ID,
    user_id: SELLER_USER_ID,
    role: ParticipantRole.seller,
  };
}

function makeService() {
  const auditService = {
    record: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Pick<AuditService, 'record'>>;

  // We construct a real `DealService` and spy on `transition` so the
  // composition surface (Audit + Deal + Approval) matches production.
  // `PrismaService` is unused in `transition` (the engine receives the
  // tx client directly from the caller — see `deal.service.ts`), so we
  // pass an empty stub.
  const prismaStub = {} as unknown as PrismaService;
  const dealService = new DealService(
    auditService as unknown as AuditService,
    prismaStub,
  );
  const transitionSpy = jest
    .spyOn(dealService, 'transition')
    .mockImplementation(
      async (deal, to /* , actor, _tx */) =>
        ({ ...deal, status: to }) as DealRoom,
    );

  const service = new ApprovalService(
    dealService,
    auditService as unknown as AuditService,
  );

  return { service, dealService, auditService, transitionSpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApprovalService.recordApproval', () => {
  // -------------------------------------------------------------------------
  // 1. First approval — inserts a row, no transition
  // -------------------------------------------------------------------------
  it('inserts an Approval row and does NOT transition the deal on the first side', async () => {
    const deal = makeDeal();
    const fake = makeFakeTx({
      participants: [buyerParticipant(), sellerParticipant()],
      // Buyer is the only one approving so far.
      approvals: [],
    });
    const { service, transitionSpy, auditService } = makeService();

    const result = await service.recordApproval(
      deal,
      { id: BUYER_USER_ID },
      fake.tx,
    );

    expect(result.inserted).toBe(true);
    expect(result.transitioned).toBe(false);
    // Deal returned is the original (unmodified) row.
    expect(result.deal.status).toBe(DealStatus.AWAITING_BOTH_APPROVAL);

    // Approval row was created with the canonical hash.
    expect(fake.spies.approvalCreate).toHaveBeenCalledTimes(1);
    expect(fake.state.approvals).toHaveLength(1);
    expect(fake.state.approvals[0]).toMatchObject({
      deal_id: DEAL_ID,
      user_id: BUYER_USER_ID,
      role: ParticipantRole.buyer,
      terms_hash: computeTermsHash(deal),
      invalidated_at: null,
    });

    // No transition, no outbox row.
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(fake.state.outbox).toHaveLength(0);

    // Audit row was written exactly once with the inserted=true flag.
    expect(auditService.record).toHaveBeenCalledTimes(1);
    const [auditEntry, auditTx] = auditService.record.mock.calls[0];
    expect(auditEntry).toMatchObject({
      action_type: 'DEAL_APPROVAL',
      actor_user_id: BUYER_USER_ID,
      actor_role: ParticipantRole.buyer,
      deal_id: DEAL_ID,
      metadata: {
        terms_hash: computeTermsHash(deal),
        inserted: true,
      },
    });
    expect(auditTx).toBe(fake.tx);
  });

  // -------------------------------------------------------------------------
  // 2. Second-side approval — transition + outbox
  // -------------------------------------------------------------------------
  it('triggers READY_FOR_PAYMENT and enqueues exactly one BOTH_APPROVED outbox row when the second side approves', async () => {
    const deal = makeDeal();
    const termsHash = computeTermsHash(deal);

    const fake = makeFakeTx({
      participants: [buyerParticipant(), sellerParticipant()],
      // Buyer already approved; seller is approving now.
      approvals: [
        {
          id: 'approval_buyer_existing',
          deal_id: DEAL_ID,
          user_id: BUYER_USER_ID,
          role: ParticipantRole.buyer,
          terms_hash: termsHash,
          invalidated_at: null,
          created_at: new Date(),
        },
      ],
    });
    const { service, transitionSpy } = makeService();

    const result = await service.recordApproval(
      deal,
      { id: SELLER_USER_ID },
      fake.tx,
    );

    expect(result.inserted).toBe(true);
    expect(result.transitioned).toBe(true);
    expect(result.deal.status).toBe(DealStatus.READY_FOR_PAYMENT);

    // The transition engine was invoked with the correct args.
    expect(transitionSpy).toHaveBeenCalledTimes(1);
    expect(transitionSpy).toHaveBeenCalledWith(
      deal,
      DealStatus.READY_FOR_PAYMENT,
      { user_id: SELLER_USER_ID, role: ParticipantRole.seller },
      fake.tx,
    );

    // Exactly one BOTH_APPROVED outbox row was emitted (R8.5).
    expect(fake.state.outbox).toHaveLength(1);
    expect(fake.state.outbox[0]).toMatchObject({
      event: 'BOTH_APPROVED',
      recipient_kind: 'deal_participants',
      recipient_id: null,
      payload: {
        deal_id: DEAL_ID,
        actor_user_id: SELLER_USER_ID,
        terms_hash: termsHash,
      },
    });

    // Both approval rows now exist on the same hash.
    expect(fake.state.approvals).toHaveLength(2);
    expect(
      fake.state.approvals.map((a) => a.role).sort(),
    ).toEqual([ParticipantRole.buyer, ParticipantRole.seller].sort());
  });

  // -------------------------------------------------------------------------
  // 3. Idempotent re-approval (R8.7)
  // -------------------------------------------------------------------------
  it('is idempotent on re-approval with the same terms_hash — no duplicate row, no second transition, no extra outbox', async () => {
    const deal = makeDeal();
    const termsHash = computeTermsHash(deal);

    const fake = makeFakeTx({
      participants: [buyerParticipant(), sellerParticipant()],
      // Buyer already approved — same hash.
      approvals: [
        {
          id: 'approval_buyer_existing',
          deal_id: DEAL_ID,
          user_id: BUYER_USER_ID,
          role: ParticipantRole.buyer,
          terms_hash: termsHash,
          invalidated_at: null,
          created_at: new Date(),
        },
      ],
    });
    const { service, transitionSpy, auditService } = makeService();

    const result = await service.recordApproval(
      deal,
      { id: BUYER_USER_ID },
      fake.tx,
    );

    expect(result.inserted).toBe(false);
    expect(result.transitioned).toBe(false);

    // No new approval row created (idempotent path skipped the create).
    expect(fake.spies.approvalCreate).not.toHaveBeenCalled();
    expect(fake.state.approvals).toHaveLength(1);

    // No transition (only buyer has approved — seller is still missing).
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(fake.state.outbox).toHaveLength(0);

    // Audit row still written, with inserted: false (so reviewers can
    // distinguish the no-op from the create path).
    expect(auditService.record).toHaveBeenCalledTimes(1);
    const [auditEntry] = auditService.record.mock.calls[0];
    expect(auditEntry).toMatchObject({
      action_type: 'DEAL_APPROVAL',
      metadata: { inserted: false, terms_hash: termsHash },
    });
  });

  // -------------------------------------------------------------------------
  // Stale-hash replacement (R7.3 / R8.4 invariant)
  // -------------------------------------------------------------------------
  it('invalidates a stale-hash existing approval and inserts a fresh row when the deal terms have changed since', async () => {
    const deal = makeDeal();
    const currentHash = computeTermsHash(deal);
    const staleHash = 'stale_hash_value_64_chars_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

    const fake = makeFakeTx({
      participants: [buyerParticipant(), sellerParticipant()],
      approvals: [
        {
          id: 'approval_buyer_stale',
          deal_id: DEAL_ID,
          user_id: BUYER_USER_ID,
          role: ParticipantRole.buyer,
          terms_hash: staleHash,
          invalidated_at: null,
          created_at: new Date('2025-12-31'),
        },
      ],
    });
    const { service } = makeService();

    const result = await service.recordApproval(
      deal,
      { id: BUYER_USER_ID },
      fake.tx,
    );

    expect(result.inserted).toBe(true);

    // Stale row was invalidated, fresh row inserted with current hash.
    expect(fake.spies.approvalUpdate).toHaveBeenCalledTimes(1);
    expect(fake.spies.approvalCreate).toHaveBeenCalledTimes(1);

    const stale = fake.state.approvals.find((a) => a.id === 'approval_buyer_stale');
    expect(stale?.invalidated_at).toBeInstanceOf(Date);

    const fresh = fake.state.approvals.find(
      (a) => a.user_id === BUYER_USER_ID && a.terms_hash === currentHash,
    );
    expect(fresh).toBeDefined();
    expect(fresh?.invalidated_at).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 4. Missing fields → 422 deal.missing_required_fields
  // -------------------------------------------------------------------------
  it('rejects with 422 deal.missing_required_fields when missing_fields is non-empty', async () => {
    // Drop `product_type` so the missing-fields predicate fires.
    const deal = makeDeal({ product_type: null });
    const fake = makeFakeTx({
      participants: [buyerParticipant(), sellerParticipant()],
    });
    const { service, transitionSpy, auditService } = makeService();

    let caught: unknown;
    try {
      await service.recordApproval(deal, { id: BUYER_USER_ID }, fake.tx);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DomainException);
    const e = caught as DomainException;
    expect(e.code).toBe('deal.missing_required_fields');
    expect(e.getStatus()).toBe(422);
    expect(e.details).toEqual({
      missing_fields: expect.arrayContaining(['Product_Type']),
    });

    // No DB writes happened past the precondition checks.
    expect(fake.spies.approvalCreate).not.toHaveBeenCalled();
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(fake.state.outbox).toHaveLength(0);
    expect(auditService.record).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. Wrong status → deal.approval_not_allowed
  // -------------------------------------------------------------------------
  it('rejects deal.approval_not_allowed when status is not AWAITING_BOTH_APPROVAL', async () => {
    const deal = makeDeal({ status: DealStatus.READY_FOR_PAYMENT });
    const fake = makeFakeTx({
      participants: [buyerParticipant(), sellerParticipant()],
    });
    const { service, auditService } = makeService();

    let caught: unknown;
    try {
      await service.recordApproval(deal, { id: BUYER_USER_ID }, fake.tx);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DomainException);
    const e = caught as DomainException;
    expect(e.code).toBe('deal.approval_not_allowed');
    // 409 (status precondition / state-machine conflict).
    expect(e.getStatus()).toBe(409);
    expect(e.details).toEqual({ current: DealStatus.READY_FOR_PAYMENT });

    // Nothing past the status guard runs.
    expect(fake.spies.dealParticipantFindUnique).not.toHaveBeenCalled();
    expect(fake.spies.approvalCreate).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6. Non-participant → auth.role_forbidden
  // -------------------------------------------------------------------------
  it('rejects auth.role_forbidden when the viewer is not a deal participant', async () => {
    const deal = makeDeal();
    const fake = makeFakeTx({
      // Only buyer + seller are participants — the viewer below is neither.
      participants: [buyerParticipant(), sellerParticipant()],
    });
    const { service, auditService } = makeService();

    let caught: unknown;
    try {
      await service.recordApproval(deal, { id: 'user_outsider' }, fake.tx);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DomainException);
    const e = caught as DomainException;
    expect(e.code).toBe('auth.role_forbidden');
    expect(e.getStatus()).toBe(403);

    // Approval was never created and no audit row was written.
    expect(fake.spies.approvalCreate).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // tx required (R20.4)
  // -------------------------------------------------------------------------
  it('throws synchronously when tx is missing (R20.4)', async () => {
    const deal = makeDeal();
    const { service } = makeService();

    await expect(
      service.recordApproval(
        deal,
        { id: BUYER_USER_ID },
        null as unknown as Prisma.TransactionClient,
      ),
    ).rejects.toThrow(/tx is required/i);

    await expect(
      service.recordApproval(
        deal,
        { id: BUYER_USER_ID },
        undefined as unknown as Prisma.TransactionClient,
      ),
    ).rejects.toThrow(/tx is required/i);
  });
});

// ---------------------------------------------------------------------------
// areBothApproved predicate
// ---------------------------------------------------------------------------

describe('ApprovalService.areBothApproved', () => {
  it('returns false when neither side has approved the current hash', async () => {
    const fake = makeFakeTx({ approvals: [] });
    const { service } = makeService();

    await expect(
      service.areBothApproved(DEAL_ID, 'h_current', fake.tx),
    ).resolves.toBe(false);
  });

  it('returns false when only one side has an active approval', async () => {
    const fake = makeFakeTx({
      approvals: [
        {
          id: 'a1',
          deal_id: DEAL_ID,
          user_id: BUYER_USER_ID,
          role: ParticipantRole.buyer,
          terms_hash: 'h_current',
          invalidated_at: null,
          created_at: new Date(),
        },
      ],
    });
    const { service } = makeService();

    await expect(
      service.areBothApproved(DEAL_ID, 'h_current', fake.tx),
    ).resolves.toBe(false);
  });

  it('returns true when buyer AND seller hold active approvals matching the supplied hash', async () => {
    const fake = makeFakeTx({
      approvals: [
        {
          id: 'a1',
          deal_id: DEAL_ID,
          user_id: BUYER_USER_ID,
          role: ParticipantRole.buyer,
          terms_hash: 'h_current',
          invalidated_at: null,
          created_at: new Date(),
        },
        {
          id: 'a2',
          deal_id: DEAL_ID,
          user_id: SELLER_USER_ID,
          role: ParticipantRole.seller,
          terms_hash: 'h_current',
          invalidated_at: null,
          created_at: new Date(),
        },
      ],
    });
    const { service } = makeService();

    await expect(
      service.areBothApproved(DEAL_ID, 'h_current', fake.tx),
    ).resolves.toBe(true);
  });

  it('ignores invalidated approvals even when both sides exist', async () => {
    const fake = makeFakeTx({
      approvals: [
        {
          id: 'a1',
          deal_id: DEAL_ID,
          user_id: BUYER_USER_ID,
          role: ParticipantRole.buyer,
          terms_hash: 'h_current',
          // Stale.
          invalidated_at: new Date(),
          created_at: new Date(),
        },
        {
          id: 'a2',
          deal_id: DEAL_ID,
          user_id: SELLER_USER_ID,
          role: ParticipantRole.seller,
          terms_hash: 'h_current',
          invalidated_at: null,
          created_at: new Date(),
        },
      ],
    });
    const { service } = makeService();

    await expect(
      service.areBothApproved(DEAL_ID, 'h_current', fake.tx),
    ).resolves.toBe(false);
  });

  it('ignores approvals tied to a different terms_hash', async () => {
    const fake = makeFakeTx({
      approvals: [
        {
          id: 'a1',
          deal_id: DEAL_ID,
          user_id: BUYER_USER_ID,
          role: ParticipantRole.buyer,
          terms_hash: 'h_old',
          invalidated_at: null,
          created_at: new Date(),
        },
        {
          id: 'a2',
          deal_id: DEAL_ID,
          user_id: SELLER_USER_ID,
          role: ParticipantRole.seller,
          terms_hash: 'h_current',
          invalidated_at: null,
          created_at: new Date(),
        },
      ],
    });
    const { service } = makeService();

    await expect(
      service.areBothApproved(DEAL_ID, 'h_current', fake.tx),
    ).resolves.toBe(false);
  });

  it('throws synchronously when tx is missing (R20.4)', async () => {
    const { service } = makeService();

    await expect(
      service.areBothApproved(
        DEAL_ID,
        'h_current',
        null as unknown as Prisma.TransactionClient,
      ),
    ).rejects.toThrow(/tx is required/i);
  });
});
