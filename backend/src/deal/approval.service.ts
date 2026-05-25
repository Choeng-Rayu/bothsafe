// task 5.9
/**
 * ApprovalService — owner of the participant approval flow.
 *
 * Source of truth: tasks.md §5.9; design §"DealService → approve";
 * requirements.md R8.1–R8.7, R6.3, R6.4, R20.1–R20.4.
 *
 * # Responsibility
 *
 * Records a single participant's "I approve these terms" intent against
 * the current `DealRoom.terms_hash` snapshot, drives the
 * `AWAITING_BOTH_APPROVAL → READY_FOR_PAYMENT` transition when both
 * sides hold active approvals matching the current hash, and emits the
 * `BOTH_APPROVED` notification outbox row exactly once per transition.
 *
 * The service deliberately does NOT load the deal by `public_id`; the
 * caller (`DealController`) is expected to have already obtained the
 * row inside the same transaction. That split keeps the service's
 * inputs testable without mocking a `dealRoom.findUnique` and lets
 * controller-level concerns (404 mapping, request shape) stay in the
 * controller.
 *
 * # Why a separate service rather than a `DealService` method
 *
 * `DealService` already owns the canonical state-machine transition
 * engine plus the pure helpers (`computeTermsHash`,
 * `computeMissingFields`, `computeAllowedActions`). Approval is a
 * standalone domain action with multi-step transactional semantics
 * (R8.1 hash snapshot, R8.4 invalidation on stale hash, R8.7
 * idempotency, R8.5 single outbox emission). Inlining all of that into
 * `DealService` would bloat its surface and tangle the transition
 * engine with approval-specific row management. Keeping it in
 * `ApprovalService` mirrors the same pattern used for `InviteService`
 * (task 5.7) — both live inside the deal module's DI graph but own
 * dedicated tables.
 *
 * # Why `tx` is required
 *
 * R20.1–R20.4 require that the approval insert, the matching audit
 * row, the (optional) transition update, and the (optional) outbox
 * enqueue all commit or roll back together. The only way to guarantee
 * that is by sharing a single Prisma `$transaction`. This service
 * therefore mirrors the `tx`-required signature already used by
 * {@link AuditService.record}, {@link DealService.transition}, and
 * {@link InviteService.consume}: passing `null`/`undefined` throws
 * synchronously before any DB call.
 *
 * # Outbox emission
 *
 * Task 10.1 introduces `NotificationOutboxService.enqueue(...)`. Until
 * that service exists, the `BOTH_APPROVED` row is inserted directly
 * via `tx.notificationOutboxEntry.create(...)` so the approval flow is
 * self-contained and testable today. Replace with the service call
 * when 10.1 lands; the outbox row shape (event + recipient_kind +
 * payload) is already canonical.
 */

import { Injectable } from '@nestjs/common';
import type { DealParticipant, DealRoom, Prisma } from '@prisma/client';

import { AuditService } from '../audit';
import { DealStatus, NotificationEvent, ParticipantRole } from '../common/enums';
import { DomainException } from '../common/errors';
import { computeMissingFields } from './deal.missing-fields';
import { computeTermsHash } from './deal.terms-hash';
import { DealService } from './deal.service';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal "who is approving" descriptor accepted by
 * {@link ApprovalService.recordApproval}. The service performs the
 * `DealParticipant` lookup itself so callers only need to pass the
 * authenticated user's id; the service then enforces the
 * "must be a deal participant" predicate (R8.6).
 *
 * We accept just `{ id }` rather than the full Prisma `User` row so:
 *   - controller call sites can pass `currentUser` straight through,
 *   - future bot / system flows can synthesise an actor without
 *     materialising a full user row,
 *   - and unit tests don't have to fabricate the wider `User` shape.
 */
export interface ApprovalViewer {
  id: string;
}

/**
 * Outcome of `recordApproval`. Carries the (possibly-transitioned)
 * deal row plus a small telemetry triple that lets callers distinguish:
 *
 *   - `inserted`     — true when a fresh `Approval` row was created
 *                      (either no prior active approval, or a stale
 *                      hash was invalidated and replaced). False on
 *                      idempotent re-approval (R8.7).
 *   - `transitioned` — true exactly when `areBothApproved` flipped to
 *                      true and the engine moved the deal to
 *                      `READY_FOR_PAYMENT`. False otherwise.
 *   - `terms_hash`   — the hash actually written/matched on this call.
 *                      Surfaces in the audit row metadata so reviewers
 *                      can correlate approval rows with material edits
 *                      after the fact.
 *
 * Returned as a struct rather than a tuple so future fields (e.g., the
 * just-inserted approval row's id) can be added without churning every
 * call site.
 */
export interface ApprovalResult {
  deal: DealRoom;
  inserted: boolean;
  transitioned: boolean;
  terms_hash: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Owner of the {@link Prisma.DealParticipant}-scoped approval flow on
 * `DealRoom`. Stateless — all state lives in Postgres and is reached
 * through the caller-supplied `Prisma.TransactionClient`.
 */
@Injectable()
export class ApprovalService {
  constructor(
    private readonly dealService: DealService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Record the viewer's approval of the supplied deal's current terms,
   * driving the both-approved transition + outbox emission when
   * applicable.
   *
   * Validation order (mirrors tasks.md §5.9 step list):
   *
   *   1. `tx` must be supplied (R20.4) — synchronous throw.
   *   2. Deal must be in `AWAITING_BOTH_APPROVAL` (R8.2) — else
   *      `deal.approval_not_allowed` 409.
   *   3. Viewer must be a `DealParticipant` with role `buyer` or
   *      `seller` for this deal (R8.6) — else `auth.role_forbidden`
   *      403.
   *   4. `computeMissingFields(deal)` must be empty (R6.3) — else
   *      `deal.missing_required_fields` 422 with
   *      `details: { missing_fields }`.
   *   5. Compute the canonical `terms_hash` (R8.1).
   *   6. Look up the viewer's currently-active approval row
   *      `(deal_id, user_id, invalidated_at IS NULL)`. R8.7
   *      idempotency:
   *        - exists with same hash → no-op insert (skip step 7).
   *        - exists with different hash → invalidate it, then insert.
   *        - no existing → insert.
   *   7. Insert the new `Approval { deal_id, user_id, role, terms_hash }`
   *      (`created_at` is filled by Postgres `default now()`).
   *   8. If both buyer and seller now hold an active approval with
   *      this hash, run `DealService.transition(deal, READY_FOR_PAYMENT,
   *      actor, tx)` and enqueue exactly one `BOTH_APPROVED` outbox
   *      row (R8.3, R8.5).
   *   9. Write an audit row via {@link AuditService.record} with
   *      `action_type: 'DEAL_APPROVAL'` and metadata
   *      `{ terms_hash, inserted }` (R20.1).
   *
   * The audit row is written even on idempotent retries so the audit
   * trail records the user's intent to approve. The metadata
   * `inserted` flag distinguishes the two cases and gives reviewers a
   * cheap way to filter the noise.
   *
   * @returns {@link ApprovalResult} — the (possibly-transitioned)
   *   deal row plus telemetry for the caller to drive its response
   *   shape (`message_key`, `allowed_actions`, etc.). Callers that
   *   only care about the deal can read `result.deal` directly.
   * @throws `Error` synchronously when `tx` is missing/null.
   * @throws `DomainException.conflict('deal.approval_not_allowed')`
   *   when the deal is not in `AWAITING_BOTH_APPROVAL`.
   * @throws `DomainException.forbidden('auth.role_forbidden')` when
   *   the viewer is not a buyer/seller participant of this deal.
   * @throws `DomainException.unprocessable('deal.missing_required_fields',
   *   { details: { missing_fields } })` when any required field is
   *   absent at approval time.
   */
  async recordApproval(
    deal: DealRoom,
    viewer: ApprovalViewer,
    tx: Prisma.TransactionClient,
  ): Promise<ApprovalResult> {
    if (!tx) {
      // R20.4 — the approval insert, audit row, optional transition,
      // and optional outbox row MUST commit together. Without a `tx`
      // we cannot guarantee that.
      throw new Error(
        'ApprovalService.recordApproval: tx is required; the approval insert, audit row, transition, and outbox row MUST share the originating transaction (R20.1, R20.4).',
      );
    }

    // Step 2 — R8.2: status precondition.
    if (deal.status !== DealStatus.AWAITING_BOTH_APPROVAL) {
      throw DomainException.conflict('deal.approval_not_allowed', {
        details: { current: deal.status },
      });
    }

    // Step 3 — R8.6: must be a buyer/seller participant of this deal.
    // We use `findUnique` against the composite UNIQUE
    // `(deal_id, user_id)` index so the lookup is a single keyed read.
    const participant = await tx.dealParticipant.findUnique({
      where: {
        deal_id_user_id: {
          deal_id: deal.id,
          user_id: viewer.id,
        },
      },
    });

    if (
      !participant ||
      (participant.role !== ParticipantRole.buyer &&
        participant.role !== ParticipantRole.seller)
    ) {
      throw DomainException.forbidden('auth.role_forbidden');
    }

    // Step 4 — R6.3: missing-fields gate. We surface
    // `deal.missing_required_fields` (422) with the structured list so
    // the frontend can highlight exactly which fields the participant
    // still needs to fill in. Without this gate a participant could
    // approve a half-filled deal and then be surprised when the
    // status fails to flip to `READY_FOR_PAYMENT`.
    const missingFields = computeMissingFields(deal);
    if (missingFields.length > 0) {
      throw DomainException.unprocessable('deal.missing_required_fields', {
        details: { missing_fields: [...missingFields] },
      });
    }

    // Step 5 — R8.1: canonical terms hash.
    const termsHash = computeTermsHash(deal);

    // Step 6 + 7 — R8.7 idempotency / stale-hash invalidation.
    const inserted = await this.upsertApproval(
      deal.id,
      viewer.id,
      participant.role,
      termsHash,
      tx,
    );

    // Step 9 — R20.1 audit. We record on every call (including
    // idempotent retries) so the audit trail captures user intent.
    // The `inserted` flag distinguishes the two cases for reviewers.
    await this.auditService.record(
      {
        action_type: 'DEAL_APPROVAL',
        actor_user_id: viewer.id,
        actor_role: participant.role,
        deal_id: deal.id,
        metadata: { terms_hash: termsHash, inserted },
      },
      tx,
    );

    // Step 8 — R8.3 / R8.5: both-approved transition + single outbox.
    let updatedDeal: DealRoom = deal;
    let transitioned = false;
    if (await this.areBothApproved(deal.id, termsHash, tx)) {
      updatedDeal = await this.dealService.transition(
        deal,
        DealStatus.READY_FOR_PAYMENT,
        { user_id: viewer.id, role: participant.role },
        tx,
      );
      await this.enqueueBothApproved(deal.id, viewer.id, termsHash, tx);
      transitioned = true;
    }

    return {
      deal: updatedDeal,
      inserted,
      transitioned,
      terms_hash: termsHash,
    };
  }

  /**
   * Predicate: does the deal currently have BOTH an active buyer
   * approval AND an active seller approval whose `terms_hash` matches
   * the supplied `termsHash`?
   *
   * "Active" means `invalidated_at IS NULL`. Material edits (R7.3)
   * flip `invalidated_at` so a stale approval is no longer counted —
   * see `DealService.computeTermsHash` and the section-patch path
   * (task 5.6) for the matching invalidation logic.
   *
   * The query is bounded by the `(deal_id)` index on the `approval`
   * table; we read at most a handful of rows per deal so a small
   * `findMany` + in-memory role check is fine. We could replace this
   * with a `groupBy({ by: ['role'] })` but the row volume does not
   * justify the extra surface.
   *
   * Static-style helper on the service (rather than a free function)
   * so callers that already have an `ApprovalService` instance can use
   * it without re-importing — it's the same shape as
   * `DealService.transition` and friends.
   *
   * @param dealId    Internal `DealRoom.id` (not `public_id`).
   * @param termsHash Hash to match against `Approval.terms_hash`.
   * @param tx        Prisma transaction client.
   * @returns         `true` iff both `buyer` and `seller` have an
   *                  active approval matching the hash.
   * @throws          `Error` synchronously when `tx` is missing/null.
   */
  async areBothApproved(
    dealId: string,
    termsHash: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    if (!tx) {
      throw new Error(
        'ApprovalService.areBothApproved: tx is required; approval state must be read inside the originating transaction so it observes uncommitted writes (R8.3, R8.7).',
      );
    }

    const approvals = await tx.approval.findMany({
      where: {
        deal_id: dealId,
        terms_hash: termsHash,
        invalidated_at: null,
        // Defensive: only count buyer/seller approvals. The schema
        // technically allows any `ParticipantRole` value but the deal
        // flow only ever inserts `buyer` / `seller` rows.
        role: { in: [ParticipantRole.buyer, ParticipantRole.seller] },
      },
      select: { role: true },
    });

    let hasBuyer = false;
    let hasSeller = false;
    for (const row of approvals) {
      if (row.role === ParticipantRole.buyer) hasBuyer = true;
      else if (row.role === ParticipantRole.seller) hasSeller = true;
    }
    return hasBuyer && hasSeller;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Create or refresh the viewer's active approval row.
   *
   * Returns `true` when a new `Approval` row was inserted, `false`
   * when an existing same-hash row was kept (R8.7 idempotency). The
   * caller uses this flag for audit metadata.
   *
   * Stale-hash handling (`existing.terms_hash !== termsHash`): we
   * invalidate the prior row and insert a fresh one rather than
   * overwriting the existing row's `terms_hash`, because:
   *
   *   - the original row's `created_at` records when the participant
   *     first approved that exact hash, which we want to preserve in
   *     the audit timeline;
   *   - `invalidated_at` is the canonical signal for "stale approval"
   *     (R7.3, R8.4) used by `areBothApproved` and the section-patch
   *     path; mutating `terms_hash` in place would break that
   *     invariant.
   */
  private async upsertApproval(
    dealId: string,
    userId: string,
    role: DealParticipant['role'],
    termsHash: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const existing = await tx.approval.findFirst({
      where: {
        deal_id: dealId,
        user_id: userId,
        invalidated_at: null,
      },
    });

    if (existing && existing.terms_hash === termsHash) {
      // R8.7 — idempotent: same user, same hash, already active. No
      // duplicate row, no further mutation. The caller's audit row
      // still records the call attempt with `inserted: false`.
      return false;
    }

    if (existing) {
      // Same user, different hash — the prior approval is stale
      // because the deal's terms have changed since it was recorded.
      // Invalidate it before inserting the fresh approval so the
      // active-approval predicate (R8.3, R8.4) keeps a clean
      // "exactly one active approval per (deal, user)" invariant.
      await tx.approval.update({
        where: { id: existing.id },
        data: { invalidated_at: new Date() },
      });
    }

    await tx.approval.create({
      data: {
        deal_id: dealId,
        user_id: userId,
        role,
        terms_hash: termsHash,
      },
    });
    return true;
  }

  /**
   * Enqueue exactly one `BOTH_APPROVED` outbox row inside the caller
   * transaction (R8.5).
   *
   * Direct insert into `notification_outbox_entry` because
   * `NotificationOutboxService` (task 10.1) is not built yet. When it
   * lands, swap this for `notificationOutboxService.enqueue(...)` —
   * the row shape (event + recipient_kind + payload) is already
   * canonical.
   *
   * `recipient_kind: 'deal_participants'` is a sentinel the future
   * drainer (task 10.2) will resolve into the deal's buyer + seller
   * by walking the participant roster. We deliberately do NOT
   * pre-fan-out to per-recipient rows here — that would couple the
   * approval flow to the participant resolution rules and break
   * cleanly when those rules change (e.g., adding silent observers).
   */
  private async enqueueBothApproved(
    dealId: string,
    actorUserId: string,
    termsHash: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.notificationOutboxEntry.create({
      data: {
        event: NotificationEvent.BOTH_APPROVED,
        recipient_kind: 'deal_participants',
        recipient_id: null,
        payload: {
          deal_id: dealId,
          actor_user_id: actorUserId,
          terms_hash: termsHash,
        },
      },
    });
  }
}
