/**
 * DealService.transition unit tests.
 *
 * Source of truth: tasks.md §5.1; design §"DealService"; R20.1, R20.4;
 * AGENTS.md → "Backend Coding Rules" (#"Never perform status
 * transitions outside the Deal service's transition engine").
 *
 * The transition engine has four observable contracts:
 *
 *   1. Legal `(prev, next)` pair → updates the deal row AND records an
 *      audit row, both via the supplied `tx`.
 *   2. Illegal `(prev, next)` pair → throws
 *      `DomainException.badRequest('deal.invalid_state', …)` whose
 *      `details.allowed` lists the legal next statuses.
 *   3. Terminal `prev` (`RELEASED`, `REFUNDED`, `CANCELLED`,
 *      `EXPIRED`) → throws `DomainException.badRequest('deal.invalid_state', …)`
 *      with `details.terminal === true`. This is a stricter signal
 *      than (2): the deal is finalised and no further mutation will
 *      ever be legal, so the frontend can render "already finalised"
 *      copy instead of the generic illegal-transition message.
 *   4. Missing `tx` argument → throws synchronously, before any
 *      database call.
 *
 * Each block below pins one of those contracts. We use an in-memory
 * fake of `Prisma.TransactionClient` instead of mocking the entire
 * Prisma client because the service intentionally depends on **only**
 * the transaction client — that narrow dependency is part of the
 * contract we are verifying.
 */

import type { DealRoom, Prisma } from '@prisma/client';

import { AuditService } from '../audit';
import { DEAL_STATUS_TRANSITIONS } from '../common/constants';
import {
  Currency,
  CreatorSource,
  DealStatus,
  ParticipantRole,
} from '../common/enums';
import { DomainException } from '../common/errors';
import { DealService } from './deal.service';
import type { DealActor } from './deal.types';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Args passed to `tx.dealRoom.update(...)` by the service. */
type UpdateArgs = Parameters<Prisma.TransactionClient['dealRoom']['update']>[0];

interface FakeTx {
  dealRoom: {
    update: jest.Mock<Promise<DealRoom>, [UpdateArgs]>;
  };
  /** Captured `update(...)` calls, oldest-first. */
  updates: UpdateArgs[];
}

function makeFakeTx(updatedRow: DealRoom): FakeTx {
  const updates: UpdateArgs[] = [];
  const update = jest.fn(async (args: UpdateArgs) => {
    updates.push(args);
    // Echo back the row with the requested status applied so callers
    // observe the post-transition state — matches the real Prisma
    // behaviour closely enough for this unit test.
    const data = args.data as { status?: DealStatus };
    return {
      ...updatedRow,
      status: data.status ?? updatedRow.status,
    } satisfies DealRoom;
  });

  return {
    dealRoom: { update } as FakeTx['dealRoom'],
    updates,
  };
}

function asTx(fake: FakeTx): Prisma.TransactionClient {
  return fake as unknown as Prisma.TransactionClient;
}

/**
 * Build a `DealRoom` row good enough for the engine. Only `id` and
 * `status` are read by the service; the remaining fields are filled
 * with plausible defaults so the type-checker is happy.
 */
function makeDeal(overrides: Partial<DealRoom> = {}): DealRoom {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: 'deal_test_1',
    public_id: 'pub_test_1',
    creator_user_id: 'user_creator',
    creator_role: ParticipantRole.seller,
    creator_source: CreatorSource.web,
    status: DealStatus.AWAITING_BOTH_APPROVAL,
    product_title: 'Widget',
    product_type: 'physical',
    product_description: null,
    quantity: 1,
    condition: 'new',
    deal_amount: null,
    currency: Currency.USD,
    buyer_name: 'Buyer One',
    seller_name: 'Seller One',
    reference_note: null,
    khqr_payload_meta: null,
    terms_hash: null,
    created_at: now,
    updated_at: now,
    expires_at: null,
    ...overrides,
  } as DealRoom;
}

const ACTOR: DealActor = {
  user_id: 'user_actor',
  role: ParticipantRole.seller,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DealService.transition', () => {
  let auditService: jest.Mocked<Pick<AuditService, 'record'>>;
  let service: DealService;

  beforeEach(() => {
    auditService = {
      record: jest.fn().mockResolvedValue(undefined),
    };
    // task 5.2 — `DealService` now also takes a `PrismaService` for
    // the `create(...)` method. The transition tests don't exercise
    // it, so we pass an empty stand-in cast to the type — the
    // constructor stores it without invoking it.
    service = new DealService(
      auditService as unknown as AuditService,
      {} as unknown as import('../prisma').PrismaService,
    );
  });

  describe('legal transition (DRAFT → AWAITING_COUNTERPARTY)', () => {
    it('updates the deal row and records a matching audit row in the same tx (R20.1)', async () => {
      const deal = makeDeal({ status: DealStatus.DRAFT });
      const fake = makeFakeTx(deal);

      const result = await service.transition(
        deal,
        DealStatus.AWAITING_COUNTERPARTY,
        ACTOR,
        asTx(fake),
      );

      // Update was issued through the supplied tx.
      expect(fake.updates).toHaveLength(1);
      expect(fake.updates[0].where).toEqual({ id: deal.id });
      expect(fake.updates[0].data).toEqual({
        status: DealStatus.AWAITING_COUNTERPARTY,
      });

      // Returned row reflects the new status.
      expect(result.status).toBe(DealStatus.AWAITING_COUNTERPARTY);

      // Audit row written via the same tx with the correct
      // prev/new/actor metadata.
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const [entry, txArg] = auditService.record.mock.calls[0];
      expect(entry).toEqual({
        action_type: 'DEAL_STATUS_TRANSITION',
        actor_user_id: ACTOR.user_id,
        actor_role: ACTOR.role,
        deal_id: deal.id,
        prev_status: DealStatus.DRAFT,
        new_status: DealStatus.AWAITING_COUNTERPARTY,
      });
      expect(txArg).toBe(asTx(fake));
    });

    it('handles the material-edit revert path (READY_FOR_PAYMENT → AWAITING_BOTH_APPROVAL, R7.3)', async () => {
      const deal = makeDeal({ status: DealStatus.READY_FOR_PAYMENT });
      const fake = makeFakeTx(deal);

      const result = await service.transition(
        deal,
        DealStatus.AWAITING_BOTH_APPROVAL,
        ACTOR,
        asTx(fake),
      );

      expect(result.status).toBe(DealStatus.AWAITING_BOTH_APPROVAL);
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const [entry] = auditService.record.mock.calls[0];
      expect(entry).toMatchObject({
        prev_status: DealStatus.READY_FOR_PAYMENT,
        new_status: DealStatus.AWAITING_BOTH_APPROVAL,
      });
    });

    it('records null actor fields verbatim for system-initiated transitions', async () => {
      const deal = makeDeal({ status: DealStatus.AWAITING_COUNTERPARTY });
      const fake = makeFakeTx(deal);

      await service.transition(
        deal,
        DealStatus.EXPIRED,
        // System actors (e.g. the invite-expiry sweeper) pass an
        // empty actor; the audit row records null/null per R20.1.
        {},
        asTx(fake),
      );

      const [entry] = auditService.record.mock.calls[0];
      expect(entry).toMatchObject({
        actor_user_id: null,
        actor_role: null,
        prev_status: DealStatus.AWAITING_COUNTERPARTY,
        new_status: DealStatus.EXPIRED,
      });
    });
  });

  describe('illegal transition (DRAFT → PAID_ESCROWED)', () => {
    it('throws DomainException.badRequest with code "deal.invalid_state"', async () => {
      const deal = makeDeal({ status: DealStatus.DRAFT });
      const fake = makeFakeTx(deal);

      await expect(
        service.transition(
          deal,
          DealStatus.PAID_ESCROWED,
          ACTOR,
          asTx(fake),
        ),
      ).rejects.toBeInstanceOf(DomainException);

      // No DB writes attempted.
      expect(fake.updates).toHaveLength(0);
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('exposes current/requested/allowed in details so the frontend can render an actionable message', async () => {
      const deal = makeDeal({ status: DealStatus.DRAFT });
      const fake = makeFakeTx(deal);

      let caught: DomainException | undefined;
      try {
        await service.transition(
          deal,
          DealStatus.PAID_ESCROWED, // not allowed from DRAFT
          ACTOR,
          asTx(fake),
        );
      } catch (err) {
        caught = err as DomainException;
      }

      expect(caught).toBeInstanceOf(DomainException);
      expect(caught?.code).toBe('deal.invalid_state');
      expect(caught?.getStatus()).toBe(400);
      expect(caught?.details).toEqual({
        current: DealStatus.DRAFT,
        requested: DealStatus.PAID_ESCROWED,
        allowed: DEAL_STATUS_TRANSITIONS[DealStatus.DRAFT],
      });
    });

    it('rejects an out-of-order request from the middle of the flow (PAID_ESCROWED → READY_FOR_PAYMENT)', async () => {
      const deal = makeDeal({ status: DealStatus.PAID_ESCROWED });
      const fake = makeFakeTx(deal);

      await expect(
        service.transition(
          deal,
          DealStatus.READY_FOR_PAYMENT, // not in PAID_ESCROWED's allowed set
          ACTOR,
          asTx(fake),
        ),
      ).rejects.toMatchObject({ code: 'deal.invalid_state' });

      expect(fake.updates).toHaveLength(0);
      expect(auditService.record).not.toHaveBeenCalled();
    });
  });

  describe('terminal status blocks any transition', () => {
    it('refuses every transition out of RELEASED with terminal: true in details', async () => {
      const deal = makeDeal({ status: DealStatus.RELEASED });
      const fake = makeFakeTx(deal);

      let caught: DomainException | undefined;
      try {
        await service.transition(
          deal,
          DealStatus.DISPUTED,
          ACTOR,
          asTx(fake),
        );
      } catch (err) {
        caught = err as DomainException;
      }

      expect(caught).toBeInstanceOf(DomainException);
      expect(caught?.code).toBe('deal.invalid_state');
      expect(caught?.details).toEqual({
        current: DealStatus.RELEASED,
        requested: DealStatus.DISPUTED,
        allowed: DEAL_STATUS_TRANSITIONS[DealStatus.RELEASED],
        terminal: true,
      });

      expect(fake.updates).toHaveLength(0);
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it.each([
      DealStatus.RELEASED,
      DealStatus.REFUNDED,
      DealStatus.CANCELLED,
      DealStatus.EXPIRED,
    ])('blocks transitions from terminal status %s', async (terminal) => {
      const deal = makeDeal({ status: terminal });
      const fake = makeFakeTx(deal);

      await expect(
        service.transition(
          deal,
          DealStatus.AWAITING_BOTH_APPROVAL,
          ACTOR,
          asTx(fake),
        ),
      ).rejects.toMatchObject({
        code: 'deal.invalid_state',
        details: expect.objectContaining({ terminal: true }),
      });

      expect(fake.updates).toHaveLength(0);
      expect(auditService.record).not.toHaveBeenCalled();
    });
  });

  describe('missing tx (R20.4)', () => {
    it('throws synchronously when tx is null and never touches the audit service', async () => {
      const deal = makeDeal({ status: DealStatus.AWAITING_BOTH_APPROVAL });

      await expect(
        service.transition(
          deal,
          DealStatus.READY_FOR_PAYMENT,
          ACTOR,
          null as unknown as Prisma.TransactionClient,
        ),
      ).rejects.toThrow(/tx is required/i);

      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('throws synchronously when tx is undefined', async () => {
      const deal = makeDeal({ status: DealStatus.AWAITING_BOTH_APPROVAL });

      await expect(
        service.transition(
          deal,
          DealStatus.READY_FOR_PAYMENT,
          ACTOR,
          undefined as unknown as Prisma.TransactionClient,
        ),
      ).rejects.toThrow(/tx is required/i);

      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('mentions R20.1/R20.4 so the contract is discoverable from the stack trace', async () => {
      const deal = makeDeal({ status: DealStatus.AWAITING_BOTH_APPROVAL });

      await expect(
        service.transition(
          deal,
          DealStatus.READY_FOR_PAYMENT,
          ACTOR,
          undefined as unknown as Prisma.TransactionClient,
        ),
      ).rejects.toThrow(/R20\.1|R20\.4/);
    });
  });
});
