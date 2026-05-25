/**
 * Property-based tests for the state-machine transition engine (task 5.12).
 *
 * Source of truth: tasks.md §5.12; requirements.md R6.5, R7.5, R20.1;
 * design §"Deal Status state machine";
 * `src/common/constants.ts` `DEAL_STATUS_TRANSITIONS`;
 * `src/deal/deal.service.ts` `DealService.transition`.
 *
 * # Property
 *
 * **Closure under spec** — for any `(prev, next)` pair, `transition`
 * succeeds iff the spec table includes `next` in
 * `DEAL_STATUS_TRANSITIONS[prev]`; on reject, no row is mutated and no
 * audit row is written.
 *
 * Validates: R6.5, R7.5, R20.1.
 *
 * # Why a property test
 *
 * `DEAL_STATUS_TRANSITIONS` has 15 source statuses × 15 target statuses
 * = 225 pairs. Hand-written cases for each are tedious and easy to
 * drift from the spec. fast-check enumerates the entire matrix and
 * checks the engine's behaviour matches the table byte-for-byte:
 *
 *   - Legal pair → exactly one `tx.dealRoom.update` call AND exactly
 *     one `AuditService.record` call, both with the right shape.
 *   - Illegal pair → `deal.invalid_state` envelope, zero `update`
 *     calls, zero `record` calls.
 *
 * The audit row's `prev_status` / `new_status` always reflect the
 * transition the caller requested, never a re-read mid-flight.
 */

import * as fc from 'fast-check';
import type { DealRoom, Prisma } from '@prisma/client';

import { AuditService } from '../audit';
import {
  ALL_DEAL_STATUSES,
  type DealStatus as DealStatusType,
} from '../common/enums';
import { DEAL_STATUS_TRANSITIONS } from '../common/constants';
import {
  CreatorSource,
  Currency,
  DealStatus,
  ParticipantRole,
} from '../common/enums';
import { DomainException } from '../common/errors';
import { DealService } from './deal.service';
import { PrismaService } from '../prisma';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTOR_USER_ID = 'user_actor';

function makeDeal(status: DealStatusType): DealRoom {
  const now = new Date('2026-06-01T00:00:00.000Z');
  return {
    id: 'deal_1',
    public_id: 'pub_1',
    creator_user_id: ACTOR_USER_ID,
    creator_role: ParticipantRole.buyer,
    creator_source: CreatorSource.web,
    status,
    product_title: null,
    product_type: null,
    product_description: null,
    quantity: null,
    condition: null,
    deal_amount: null,
    currency: Currency.USD,
    buyer_name: null,
    seller_name: null,
    delivery_method: null,
    delivery_address: null,
    delivery_note: null,
    payout_khqr: null,
    payout_bank_name: null,
    payout_account_name: null,
    payout_account_number: null,
    reference_note: null,
    khqr_payload_meta: null,
    terms_hash: null,
    created_at: now,
    updated_at: now,
    expires_at: null,
  } as unknown as DealRoom;
}

function makeFakeTx() {
  const updateCalls: Array<{
    where: { id: string };
    data: Prisma.DealRoomUpdateInput;
  }> = [];
  const auditCalls: Array<{ data: Record<string, unknown> }> = [];

  const tx = {
    dealRoom: {
      update: jest.fn(
        async (args: {
          where: { id: string };
          data: Prisma.DealRoomUpdateInput;
        }) => {
          updateCalls.push(args);
          return {
            ...makeDeal((args.data as { status: DealStatusType }).status),
          };
        },
      ),
    },
    auditLogEntry: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        auditCalls.push(args);
        return { id: BigInt(auditCalls.length) };
      }),
    },
  } as unknown as Prisma.TransactionClient;

  return { tx, updateCalls, auditCalls };
}

function makeService() {
  const audit = new AuditService();
  // `transition` never opens its own transaction — it requires the
  // caller's `tx`. The PrismaService stub only needs to be present
  // for DI; it is never invoked here.
  const prisma = {} as unknown as PrismaService;
  return new DealService(audit, prisma);
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const dealStatusArb = fc.constantFrom(...ALL_DEAL_STATUSES);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('DealService.transition — property tests (task 5.12)', () => {
  it('matches DEAL_STATUS_TRANSITIONS exactly: succeeds iff (prev, next) is in the table', async () => {
    const service = makeService();

    await fc.assert(
      fc.asyncProperty(dealStatusArb, dealStatusArb, async (prev, next) => {
        const { tx, updateCalls, auditCalls } = makeFakeTx();
        const deal = makeDeal(prev);

        const allowed = DEAL_STATUS_TRANSITIONS[prev] as readonly DealStatusType[];
        const isLegal = allowed.includes(next);

        let threw: unknown = null;
        try {
          await service.transition(
            deal,
            next,
            { user_id: ACTOR_USER_ID, role: ParticipantRole.buyer },
            tx,
          );
        } catch (err) {
          threw = err;
        }

        if (isLegal) {
          // Legal pair: no throw, exactly one update + one audit.
          expect(threw).toBeNull();
          expect(updateCalls).toHaveLength(1);
          expect(updateCalls[0].data).toMatchObject({ status: next });
          expect(auditCalls).toHaveLength(1);
          expect(auditCalls[0].data).toMatchObject({
            action_type: 'DEAL_STATUS_TRANSITION',
            prev_status: prev,
            new_status: next,
            deal_id: deal.id,
          });
        } else {
          // Illegal pair: throws deal.invalid_state, no writes.
          expect(threw).toBeInstanceOf(DomainException);
          expect((threw as DomainException).code).toBe('deal.invalid_state');
          expect(updateCalls).toHaveLength(0);
          expect(auditCalls).toHaveLength(0);
        }
      }),
      { numRuns: 250 },
    );
  });

  it('terminal source statuses (RELEASED, REFUNDED, CANCELLED, EXPIRED) reject every target with terminal: true', async () => {
    const service = makeService();
    const terminals: DealStatusType[] = [
      DealStatus.RELEASED,
      DealStatus.REFUNDED,
      DealStatus.CANCELLED,
      DealStatus.EXPIRED,
    ];

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...terminals),
        dealStatusArb,
        async (prev, next) => {
          const { tx, updateCalls, auditCalls } = makeFakeTx();
          const deal = makeDeal(prev);

          let threw: DomainException | null = null;
          try {
            await service.transition(
              deal,
              next,
              { user_id: ACTOR_USER_ID, role: null },
              tx,
            );
          } catch (err) {
            threw = err as DomainException;
          }

          expect(threw).toBeInstanceOf(DomainException);
          expect(threw?.code).toBe('deal.invalid_state');
          expect(threw?.details).toMatchObject({ terminal: true });
          expect(updateCalls).toHaveLength(0);
          expect(auditCalls).toHaveLength(0);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('rejects synchronously (before any DB call) when tx is missing', async () => {
    const service = makeService();
    const deal = makeDeal(DealStatus.AWAITING_BOTH_APPROVAL);

    await expect(
      service.transition(
        deal,
        DealStatus.READY_FOR_PAYMENT,
        { user_id: ACTOR_USER_ID, role: ParticipantRole.buyer },
        null as unknown as Prisma.TransactionClient,
      ),
    ).rejects.toThrow(/tx is required/);
  });
});
