/**
 * Property-based tests for `ApprovalService.areBothApproved` (task 5.13).
 *
 * Source of truth: tasks.md §5.13; requirements.md R8.3, R8.4, R8.7;
 * `src/deal/approval.service.ts`.
 *
 * # Property
 *
 * **Both-approved iff matching active approvals** —
 * `areBothApproved(deal_id, terms_hash, tx)` is `true` exactly when
 * the latest non-invalidated approval per role has
 * `terms_hash === deal.terms_hash`.
 *
 * Concretely, given a synthetic set of `Approval` rows for a deal:
 *
 *   - `true` iff there exists at least one `Approval` row with
 *     `role === 'buyer' AND invalidated_at IS NULL AND terms_hash === H`
 *     AND at least one row with
 *     `role === 'seller' AND invalidated_at IS NULL AND terms_hash === H`.
 *   - `false` otherwise (missing one role, only invalidated rows, or
 *     mismatched hashes).
 *
 * Validates: R8.3 (both-approved gate), R8.4 (invalidation invariant),
 * R8.7 (idempotency on resubmit).
 *
 * # Why fake the `tx`
 *
 * `areBothApproved` calls `tx.approval.findMany({ where: { deal_id,
 * terms_hash, invalidated_at: null, role: { in: ['buyer','seller'] }
 * } })`. We hand-fake the filter logic in-memory so the property runs
 * without a real Postgres connection. The fake mirrors the real
 * Prisma predicate exactly so the test exercises the service's
 * post-filter aggregation logic (the buyer/seller flag merge).
 */

import * as fc from 'fast-check';
import type { Prisma } from '@prisma/client';

import { ParticipantRole } from '../common/enums';
import { ApprovalService } from './approval.service';

// ---------------------------------------------------------------------------
// Synthetic approval row + reference oracle
// ---------------------------------------------------------------------------

interface SyntheticApproval {
  role: ParticipantRole;
  terms_hash: string;
  invalidated_at: Date | null;
}

function expectedBothApproved(
  rows: readonly SyntheticApproval[],
  hash: string,
): boolean {
  const hasBuyer = rows.some(
    (r) =>
      r.role === ParticipantRole.buyer &&
      r.invalidated_at === null &&
      r.terms_hash === hash,
  );
  const hasSeller = rows.some(
    (r) =>
      r.role === ParticipantRole.seller &&
      r.invalidated_at === null &&
      r.terms_hash === hash,
  );
  return hasBuyer && hasSeller;
}

// ---------------------------------------------------------------------------
// Fake tx — implements the same filter as the real Prisma `findMany`
// ---------------------------------------------------------------------------

function makeFakeTxFromRows(rows: readonly SyntheticApproval[]) {
  const tx = {
    approval: {
      findMany: jest.fn(
        async (args: {
          where: {
            deal_id: string;
            terms_hash: string;
            invalidated_at: null;
            role: { in: ParticipantRole[] };
          };
          select: { role: true };
        }) => {
          // Implement the filter exactly as the schema would.
          return rows
            .filter(
              (r) =>
                r.invalidated_at === null &&
                r.terms_hash === args.where.terms_hash &&
                args.where.role.in.includes(r.role),
            )
            .map((r) => ({ role: r.role }));
        },
      ),
    },
  } as unknown as Prisma.TransactionClient;

  return tx;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const hashArb = fc.constantFrom('hash_A', 'hash_B', 'hash_C');
const roleArb = fc.constantFrom(ParticipantRole.buyer, ParticipantRole.seller);
const invalidatedArb = fc.oneof(
  fc.constant<Date | null>(null),
  fc.constant<Date | null>(new Date('2026-06-01T00:00:00.000Z')),
);

const approvalRowArb: fc.Arbitrary<SyntheticApproval> = fc.record({
  role: roleArb,
  terms_hash: hashArb,
  invalidated_at: invalidatedArb,
});

const approvalRowsArb: fc.Arbitrary<SyntheticApproval[]> = fc.array(
  approvalRowArb,
  { maxLength: 10 },
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApprovalService.areBothApproved — property tests (task 5.13)', () => {
  const service = new ApprovalService(null as never, null as never);

  it('true iff at least one active buyer + one active seller approval match the target hash', async () => {
    await fc.assert(
      fc.asyncProperty(approvalRowsArb, hashArb, async (rows, hash) => {
        const tx = makeFakeTxFromRows(rows);
        const actual = await service.areBothApproved('deal_1', hash, tx);
        const expected = expectedBothApproved(rows, hash);
        expect(actual).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it('false when both approvals are invalidated, regardless of hash match', async () => {
    await fc.assert(
      fc.asyncProperty(hashArb, async (hash) => {
        const rows: SyntheticApproval[] = [
          {
            role: ParticipantRole.buyer,
            terms_hash: hash,
            invalidated_at: new Date(),
          },
          {
            role: ParticipantRole.seller,
            terms_hash: hash,
            invalidated_at: new Date(),
          },
        ];
        const tx = makeFakeTxFromRows(rows);
        const actual = await service.areBothApproved('deal_1', hash, tx);
        expect(actual).toBe(false);
      }),
      { numRuns: 30 },
    );
  });

  it('false when only one role has an active matching approval', async () => {
    await fc.assert(
      fc.asyncProperty(roleArb, hashArb, async (oneRole, hash) => {
        const rows: SyntheticApproval[] = [
          { role: oneRole, terms_hash: hash, invalidated_at: null },
        ];
        const tx = makeFakeTxFromRows(rows);
        const actual = await service.areBothApproved('deal_1', hash, tx);
        expect(actual).toBe(false);
      }),
      { numRuns: 30 },
    );
  });

  it('true when exactly one active approval per role matches the hash', async () => {
    await fc.assert(
      fc.asyncProperty(hashArb, async (hash) => {
        const rows: SyntheticApproval[] = [
          {
            role: ParticipantRole.buyer,
            terms_hash: hash,
            invalidated_at: null,
          },
          {
            role: ParticipantRole.seller,
            terms_hash: hash,
            invalidated_at: null,
          },
        ];
        const tx = makeFakeTxFromRows(rows);
        const actual = await service.areBothApproved('deal_1', hash, tx);
        expect(actual).toBe(true);
      }),
      { numRuns: 30 },
    );
  });

  it('false when active approvals exist but their hash does not match the deal hash', async () => {
    const rows: SyntheticApproval[] = [
      {
        role: ParticipantRole.buyer,
        terms_hash: 'old_hash',
        invalidated_at: null,
      },
      {
        role: ParticipantRole.seller,
        terms_hash: 'old_hash',
        invalidated_at: null,
      },
    ];
    const tx = makeFakeTxFromRows(rows);
    const actual = await service.areBothApproved('deal_1', 'new_hash', tx);
    expect(actual).toBe(false);
  });

  it('rejects synchronously when tx is missing', async () => {
    await expect(
      service.areBothApproved(
        'deal_1',
        'h',
        null as unknown as Prisma.TransactionClient,
      ),
    ).rejects.toThrow(/tx is required/);
  });
});
