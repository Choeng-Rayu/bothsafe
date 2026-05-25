/**
 * DealSectionPatchService unit tests (task 5.6).
 *
 * Source of truth: tasks.md §5.6; requirements.md R7.1–R7.7;
 * design.md §"DealService → patchProduct / patchParticipant".
 *
 * # Coverage
 *
 *   1. **R7.5 — locked_after_payment guard.** Edits in any post-
 *      payment status reject with `deal.locked_after_payment` and
 *      perform no writes.
 *   2. **R7.6 — non-participant rejected.** A user who is not a
 *      `DealParticipant` on the deal receives `auth.role_forbidden`.
 *   3. **R7.3 — material edit (product_title, product_description,
 *      deal_amount, currency).** Product patches that change any of
 *      these four fields invalidate approvals and revert status to
 *      `AWAITING_BOTH_APPROVAL`.
 *   4. **R7.4 — non-material edit (product_type, quantity,
 *      condition).** Product patches that touch only non-material
 *      fields preserve approvals and leave the status alone.
 *   5. **R7.4 (no-op canonical equivalence).** Re-POSTing the same
 *      `deal_amount` in a different lexical form ("12.30" vs stored
 *      `Decimal("12.3")`) does NOT register as a material edit.
 *   6. **R7.7 — invalid_field on out-of-range deal_amount.** A
 *      non-numeric / out-of-range amount surfaces
 *      `deal.invalid_field` with `details.reason`.
 *   7. **R7.2 + R7.6 — participant section ownership.** A buyer
 *      attempting to set `seller_name` (the other side's identity)
 *      is rejected with `auth.role_forbidden`. The own-side fields
 *      land on the `DealRoom` row and `DealParticipant` row
 *      respectively.
 *   8. **Delivery section.** All fields are non-material and
 *      preserve approvals + status (R7.4).
 *   9. **R7.6 — payout section is seller-only.** A buyer attempting
 *      a payout patch is rejected with `auth.role_forbidden`.
 *      Seller patches land on the `DealRoom` row.
 *
 * # Why fake the `tx`
 *
 * The service opens a `prisma.runInTransaction(...)` and then drives
 * `tx.dealRoom.{findUnique, update}`, `tx.dealParticipant.findUnique /
 * update`, `tx.approval.updateMany`, and `tx.auditLogEntry.create`
 * (via the DealService transition). We hand-fake the entire `tx`
 * surface so the test exercises the orchestration logic without a
 * real Prisma client.
 */

import type { DealParticipant, DealRoom, Prisma } from '@prisma/client';
import { Decimal } from 'decimal.js';

import type { AuthenticatedUser } from '../auth';
import {
  CreatorSource,
  Currency,
  DealStatus,
  ParticipantRole,
  PreferredLang,
} from '../common/enums';
import { DomainException } from '../common/errors';
import type { PrismaService } from '../prisma';

import { DealSectionPatchService } from './deal-section-patch.service';
import type { DealService } from './deal.service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEAL_ID = 'deal_id_1';
const PUBLIC_ID = 'pub_abc123';
const BUYER_USER_ID = 'user_buyer';
const SELLER_USER_ID = 'user_seller';
const STRANGER_USER_ID = 'user_stranger';

function makeDeal(overrides: Partial<DealRoom> = {}): DealRoom {
  const now = new Date('2026-06-01T00:00:00.000Z');
  return {
    id: DEAL_ID,
    public_id: PUBLIC_ID,
    creator_user_id: SELLER_USER_ID,
    creator_role: ParticipantRole.seller,
    creator_source: CreatorSource.web,
    status: DealStatus.AWAITING_BOTH_APPROVAL,
    product_title: 'Vintage Camera',
    product_type: 'electronics',
    product_description: 'Mint condition',
    quantity: 1,
    condition: 'used',
    // 2dp Decimal — stored value Prisma would return on read.
    deal_amount: new Decimal('150.00') as unknown as Prisma.Decimal,
    currency: Currency.USD,
    buyer_name: 'Alice',
    seller_name: 'Bob',
    delivery_method: null,
    delivery_address: null,
    delivery_note: null,
    payout_khqr: null,
    payout_bank_name: null,
    payout_account_name: null,
    payout_account_number: null,
    reference_note: null,
    khqr_payload_meta: null,
    terms_hash: 'old-hash',
    created_at: now,
    updated_at: now,
    expires_at: null,
    ...overrides,
  } as unknown as DealRoom;
}

function makeParticipant(
  role: ParticipantRole,
  userId: string,
): DealParticipant {
  return {
    id: `dp_${role}`,
    deal_id: DEAL_ID,
    user_id: userId,
    role,
    joined_at: new Date('2026-06-01T00:00:00.000Z'),
    phone: null,
    preferred_lang: null,
    telegram_chat_id: null,
    wechat_id: null,
    messenger_name: null,
  } as unknown as DealParticipant;
}

function makeAuthenticatedUser(id: string): AuthenticatedUser {
  return { id } as AuthenticatedUser;
}

// ---------------------------------------------------------------------------
// Fake Prisma transaction
// ---------------------------------------------------------------------------

interface FakeTxConfig {
  deal?: DealRoom | null;
  participant?: DealParticipant | null;
  /** Echo for `dealRoom.update` calls. */
  updatedDeal?: DealRoom;
}

function makeFakeTx(config: FakeTxConfig = {}) {
  const initialDeal =
    config.deal === null ? null : (config.deal ?? makeDeal());

  // Stateful tracker — every `dealRoom.update` mutates this so the fake
  // mirrors how Postgres would behave (later reads see earlier writes
  // inside the same tx). Critical for R7.3 product-patch flow:
  //   1. patchProduct's product_title update → status preserved.
  //   2. dealService.transition update → status flipped.
  //   3. refreshTermsHash update → terms_hash refreshed without
  //      clobbering the just-flipped status.
  // A non-stateful fake would let step 3 echo back the pre-step-2 row
  // and silently revert the transition, masking real bugs.
  let currentDeal: DealRoom | null = initialDeal;

  // Track all writes for assertion.
  const dealRoomUpdate = jest.fn(
    async (args: { where: { id: string }; data: Prisma.DealRoomUpdateInput }) => {
      const base = config.updatedDeal ?? currentDeal;
      if (!base) {
        throw new Error('test fake: dealRoom.update called with no base deal');
      }
      currentDeal = { ...base, ...(args.data as Partial<DealRoom>) } as DealRoom;
      return currentDeal;
    },
  );

  const participantFindUnique = jest.fn().mockResolvedValue(
    config.participant === null ? null : (config.participant ?? makeParticipant(ParticipantRole.buyer, BUYER_USER_ID)),
  );

  const tx = {
    dealRoom: {
      findUnique: jest.fn().mockResolvedValue(initialDeal),
      update: dealRoomUpdate,
    },
    dealParticipant: {
      findUnique: participantFindUnique,
      update: jest.fn().mockResolvedValue({}),
    },
    approval: {
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    auditLogEntry: {
      create: jest.fn().mockResolvedValue({ id: BigInt(1) }),
    },
  } as unknown as Prisma.TransactionClient;

  return { tx, deal: initialDeal };
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

interface BuildServiceOptions {
  txConfig?: FakeTxConfig;
}

function buildService(opts: BuildServiceOptions = {}) {
  const { tx, deal } = makeFakeTx(opts.txConfig);

  const prisma = {
    runInTransaction: jest.fn(
      async <T,>(fn: (txArg: Prisma.TransactionClient) => Promise<T>) => fn(tx),
    ),
  } as unknown as PrismaService;

  // `transition` returns the post-transition row. The fake routes the
  // status change through `tx.dealRoom.update` so the in-memory tx
  // state stays consistent with subsequent reads (e.g. the
  // `refreshTermsHash` update right after this call sees the new
  // status as the base, not the pre-transition value).
  const dealService = {
    transition: jest
      .fn()
      .mockImplementation(async (d: DealRoom, to: DealStatus) => {
        const result = (await (
          tx.dealRoom.update as jest.Mock
        )({
          where: { id: d.id },
          data: { status: to },
        })) as DealRoom;
        return result;
      }),
  } as unknown as DealService;

  const service = new DealSectionPatchService(prisma, dealService);

  return { service, tx, prisma, dealService, deal };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DealSectionPatchService — load + authorise', () => {
  it('R7.5: rejects edits in a post-payment status with deal.locked_after_payment', async () => {
    const lockedDeal = makeDeal({ status: DealStatus.PAID_ESCROWED });
    const { service, tx } = buildService({ txConfig: { deal: lockedDeal } });

    let caught: DomainException | undefined;
    try {
      await service.patchProduct(
        PUBLIC_ID,
        { product_title: 'New title' },
        makeAuthenticatedUser(BUYER_USER_ID),
      );
    } catch (err) {
      caught = err as DomainException;
    }

    expect(caught).toBeInstanceOf(DomainException);
    expect(caught?.code).toBe('deal.locked_after_payment');
    // No writes occurred.
    expect(tx.dealRoom.update).not.toHaveBeenCalled();
    expect(tx.approval.updateMany).not.toHaveBeenCalled();
  });

  it('R7.6: rejects non-participants with auth.role_forbidden', async () => {
    const { service, tx } = buildService({
      txConfig: {
        deal: makeDeal(),
        // No participant row → R7.6 rejection.
        participant: null,
      },
    });

    let caught: DomainException | undefined;
    try {
      await service.patchProduct(
        PUBLIC_ID,
        { product_title: 'New title' },
        makeAuthenticatedUser(STRANGER_USER_ID),
      );
    } catch (err) {
      caught = err as DomainException;
    }

    expect(caught).toBeInstanceOf(DomainException);
    expect(caught?.code).toBe('auth.role_forbidden');
    expect(tx.dealRoom.update).not.toHaveBeenCalled();
  });

  it('returns deal.not_found when the public_id does not match', async () => {
    const { service } = buildService({ txConfig: { deal: null } });

    let caught: DomainException | undefined;
    try {
      await service.patchProduct(
        PUBLIC_ID,
        { product_title: 'New title' },
        makeAuthenticatedUser(BUYER_USER_ID),
      );
    } catch (err) {
      caught = err as DomainException;
    }

    expect(caught).toBeInstanceOf(DomainException);
    expect(caught?.code).toBe('deal.not_found');
  });
});

describe('DealSectionPatchService.patchProduct (R7.1, R7.3, R7.4, R7.7)', () => {
  it('R7.3: a material edit (product_title) invalidates approvals and reverts to AWAITING_BOTH_APPROVAL', async () => {
    // Start in READY_FOR_PAYMENT — material edit must drag us back.
    const deal = makeDeal({ status: DealStatus.READY_FOR_PAYMENT });
    const { service, tx, dealService } = buildService({
      txConfig: { deal, participant: makeParticipant(ParticipantRole.buyer, BUYER_USER_ID) },
    });

    const result = await service.patchProduct(
      PUBLIC_ID,
      { product_title: 'New title' },
      makeAuthenticatedUser(BUYER_USER_ID),
    );

    // Approvals were invalidated.
    expect(tx.approval.updateMany).toHaveBeenCalledTimes(1);
    expect((tx.approval.updateMany as jest.Mock).mock.calls[0][0]).toMatchObject({
      where: { deal_id: DEAL_ID, invalidated_at: null },
      data: expect.objectContaining({ invalidated_at: expect.any(Date) }),
    });

    // Status was transitioned.
    expect(dealService.transition).toHaveBeenCalledTimes(1);
    expect((dealService.transition as jest.Mock).mock.calls[0][1]).toBe(
      DealStatus.AWAITING_BOTH_APPROVAL,
    );

    expect(result.deal.status).toBe(DealStatus.AWAITING_BOTH_APPROVAL);
  });

  it('R7.4: a non-material edit (product_type) preserves approvals and status', async () => {
    const { service, tx, dealService } = buildService();

    const result = await service.patchProduct(
      PUBLIC_ID,
      { product_type: 'phone' },
      makeAuthenticatedUser(BUYER_USER_ID),
    );

    // Approvals NOT invalidated.
    expect(tx.approval.updateMany).not.toHaveBeenCalled();
    // No status transition.
    expect(dealService.transition).not.toHaveBeenCalled();
    // Status preserved.
    expect(result.deal.status).toBe(DealStatus.AWAITING_BOTH_APPROVAL);
  });

  it('R7.4: re-POSTing the same canonical deal_amount (lexically different) is a no-op (no approval reset)', async () => {
    // Stored deal_amount = Decimal("150.00"), DTO supplies "150" — same
    // 2dp form once normalised, so this MUST NOT count as a material edit.
    const { service, tx, dealService } = buildService();

    await service.patchProduct(
      PUBLIC_ID,
      { deal_amount: '150' },
      makeAuthenticatedUser(BUYER_USER_ID),
    );

    expect(tx.approval.updateMany).not.toHaveBeenCalled();
    expect(dealService.transition).not.toHaveBeenCalled();
  });

  it('R7.3: a real deal_amount change DOES count as a material edit', async () => {
    // Start in READY_FOR_PAYMENT so a transition back to
    // AWAITING_BOTH_APPROVAL is required (R7.3). Starting in
    // AWAITING_BOTH_APPROVAL would short-circuit the transition (it
    // would be a no-op) and we wouldn't observe the transition call.
    const deal = makeDeal({ status: DealStatus.READY_FOR_PAYMENT });
    const { service, tx, dealService } = buildService({
      txConfig: { deal },
    });

    await service.patchProduct(
      PUBLIC_ID,
      { deal_amount: '200.00' },
      makeAuthenticatedUser(BUYER_USER_ID),
    );

    expect(tx.approval.updateMany).toHaveBeenCalledTimes(1);
    expect(dealService.transition).toHaveBeenCalledTimes(1);
    expect((dealService.transition as jest.Mock).mock.calls[0][1]).toBe(
      DealStatus.AWAITING_BOTH_APPROVAL,
    );
  });

  it('R7.7: rejects out-of-range deal_amount with deal.invalid_field and writes nothing', async () => {
    const { service, tx } = buildService();

    let caught: DomainException | undefined;
    try {
      await service.patchProduct(
        PUBLIC_ID,
        { deal_amount: '0' },
        makeAuthenticatedUser(BUYER_USER_ID),
      );
    } catch (err) {
      caught = err as DomainException;
    }

    expect(caught).toBeInstanceOf(DomainException);
    expect(caught?.code).toBe('deal.invalid_field');
    expect(caught?.details).toMatchObject({
      field: 'deal_amount',
      reason: 'money.out_of_range',
    });
    expect(tx.dealRoom.update).not.toHaveBeenCalled();
    expect(tx.approval.updateMany).not.toHaveBeenCalled();
  });
});

describe('DealSectionPatchService.patchParticipant (R7.2, R7.4, R7.6)', () => {
  it('R7.6: a buyer attempting to set seller_name is rejected with auth.role_forbidden', async () => {
    const { service, tx } = buildService({
      txConfig: {
        deal: makeDeal(),
        participant: makeParticipant(ParticipantRole.buyer, BUYER_USER_ID),
      },
    });

    let caught: DomainException | undefined;
    try {
      await service.patchParticipant(
        PUBLIC_ID,
        { seller_name: 'Hijack' },
        makeAuthenticatedUser(BUYER_USER_ID),
      );
    } catch (err) {
      caught = err as DomainException;
    }

    expect(caught).toBeInstanceOf(DomainException);
    expect(caught?.code).toBe('auth.role_forbidden');
    expect(tx.dealRoom.update).not.toHaveBeenCalled();
    expect(tx.dealParticipant.update).not.toHaveBeenCalled();
  });

  it('R7.2: a buyer setting buyer_name + buyer_phone + preferred_lang lands on the right rows; approvals preserved (R7.4)', async () => {
    const { service, tx, dealService } = buildService({
      txConfig: {
        deal: makeDeal(),
        participant: makeParticipant(ParticipantRole.buyer, BUYER_USER_ID),
      },
    });

    await service.patchParticipant(
      PUBLIC_ID,
      {
        buyer_name: 'Alice Updated',
        buyer_phone: '+855 12 345 678',
        preferred_lang: PreferredLang.km,
      },
      makeAuthenticatedUser(BUYER_USER_ID),
    );

    // buyer_name landed on the deal row.
    const dealUpdateArgs = (tx.dealRoom.update as jest.Mock).mock.calls.map(
      (c) => c[0],
    );
    const buyerNameUpdate = dealUpdateArgs.find(
      (args) => args.data?.buyer_name === 'Alice Updated',
    );
    expect(buyerNameUpdate).toBeDefined();

    // phone + preferred_lang landed on the participant row.
    expect(tx.dealParticipant.update).toHaveBeenCalledTimes(1);
    expect((tx.dealParticipant.update as jest.Mock).mock.calls[0][0]).toMatchObject({
      data: expect.objectContaining({
        phone: '+855 12 345 678',
        preferred_lang: PreferredLang.km,
      }),
    });

    // R7.4 — participant edits are non-material, approvals untouched.
    expect(tx.approval.updateMany).not.toHaveBeenCalled();
    expect(dealService.transition).not.toHaveBeenCalled();
  });
});

describe('DealSectionPatchService.patchDelivery (R7.1, R7.4)', () => {
  it('updates delivery fields on the deal row and preserves approvals + status', async () => {
    const { service, tx, dealService } = buildService();

    await service.patchDelivery(
      PUBLIC_ID,
      { delivery_method: 'Courier', delivery_address: '123 Sisowath' },
      makeAuthenticatedUser(BUYER_USER_ID),
    );

    expect(tx.dealRoom.update).toHaveBeenCalledTimes(1);
    expect((tx.dealRoom.update as jest.Mock).mock.calls[0][0]).toMatchObject({
      data: expect.objectContaining({
        delivery_method: 'Courier',
        delivery_address: '123 Sisowath',
      }),
    });

    // R7.4 — delivery fields are non-material.
    expect(tx.approval.updateMany).not.toHaveBeenCalled();
    expect(dealService.transition).not.toHaveBeenCalled();
  });
});

describe('DealSectionPatchService.patchPayout (R7.1, R7.4, R7.6)', () => {
  it('R7.6: a buyer attempting payout edits is rejected with auth.role_forbidden', async () => {
    const { service, tx } = buildService({
      txConfig: {
        deal: makeDeal(),
        participant: makeParticipant(ParticipantRole.buyer, BUYER_USER_ID),
      },
    });

    let caught: DomainException | undefined;
    try {
      await service.patchPayout(
        PUBLIC_ID,
        { payout_khqr: 'BAKONG-DATA' },
        makeAuthenticatedUser(BUYER_USER_ID),
      );
    } catch (err) {
      caught = err as DomainException;
    }

    expect(caught).toBeInstanceOf(DomainException);
    expect(caught?.code).toBe('auth.role_forbidden');
    expect(tx.dealRoom.update).not.toHaveBeenCalled();
  });

  it('a seller patching payout fields succeeds and preserves approvals', async () => {
    const { service, tx, dealService } = buildService({
      txConfig: {
        deal: makeDeal(),
        participant: makeParticipant(ParticipantRole.seller, SELLER_USER_ID),
      },
    });

    await service.patchPayout(
      PUBLIC_ID,
      {
        payout_khqr: 'BAKONG-DATA',
        payout_bank_name: 'ACLEDA',
        payout_account_number: '0123456789',
      },
      makeAuthenticatedUser(SELLER_USER_ID),
    );

    expect(tx.dealRoom.update).toHaveBeenCalledTimes(1);
    expect((tx.dealRoom.update as jest.Mock).mock.calls[0][0]).toMatchObject({
      data: expect.objectContaining({
        payout_khqr: 'BAKONG-DATA',
        payout_bank_name: 'ACLEDA',
        payout_account_number: '0123456789',
      }),
    });

    // R7.4 — payout fields are non-material.
    expect(tx.approval.updateMany).not.toHaveBeenCalled();
    expect(dealService.transition).not.toHaveBeenCalled();
  });
});
