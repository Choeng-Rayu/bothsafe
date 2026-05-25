/**
 * DealService — owner of the Deal Room state machine.
 *
 * Source of truth: design §"DealService (`src/deal/`)"; tasks.md §5.1
 * (this file), §5.3, §5.4, §5.5 (parallel sibling tasks that append to
 * the same class).
 *
 * Acceptance criteria covered by this file:
 *   - R20.1 — every Deal_Status mutation writes an `AuditLogEntry` in
 *             the same database transaction as the update.
 *   - R20.4 — audit failures roll the originating mutation back: the
 *             audit insert and the deal update share a single Prisma
 *             `$transaction`, supplied by the caller.
 *   - design §"Deal Status state machine" — `(prev, next)` pairs are
 *             validated against `DEAL_STATUS_TRANSITIONS`.
 *
 * ## Single transition engine
 *
 * AGENTS.md → "Backend Coding Rules" is explicit:
 *
 *   > Never perform status transitions outside the Deal service's
 *   > transition engine.
 *
 * Every status mutation in the codebase therefore funnels through
 * {@link DealService.transition}. That centralisation is the only place
 * we can guarantee:
 *
 *   1. The transition is admissible per the canonical state-machine
 *      table (`DEAL_STATUS_TRANSITIONS`, design §"Deal Status state
 *      machine").
 *   2. The matching `AuditLogEntry` lands in the same transaction as
 *      the deal update (R20.1, R20.4).
 *   3. The "previous" and "new" statuses on the audit row reflect the
 *      values the caller actually saw at decision time, not whatever
 *      we re-read from the database mid-flight.
 *
 * ## Why `tx` is required
 *
 * The transition engine never opens its own transaction. Callers
 * (`WalletService.payDealFromWallet`, `InviteService.consume`,
 * approval/patch helpers, etc.) already run multi-step writes inside a
 * `prisma.$transaction(...)` callback; passing the same client through
 * is what lets the audit row share that transaction. If we accepted a
 * no-`tx` call site we would either commit the audit row independently
 * (breaking R20.4 — see `audit.service.ts` for the matching argument)
 * or open a second, nested transaction that cannot atomically roll
 * back with the caller's other writes.
 *
 * The signature therefore mirrors {@link AuditService.record}: `tx` is
 * required, and a missing/null value throws synchronously **before**
 * touching the database.
 *
 * ## Sibling tasks
 *
 * The other Deal-module agents (5.3, 5.4, 5.5) append additional
 * methods to this class — `computeTermsHash`, `computeMissingFields`,
 * `computeAllowedActions`. To keep that parallel work conflict-free,
 * this file deliberately defines **only** the constructor and the
 * single `transition` method. New methods should be appended below
 * the existing ones in declaration order matching the task numbers.
 */

import { Injectable } from '@nestjs/common';
import type { DealRoom, Prisma } from '@prisma/client';

import { AuditService } from '../audit';
import {
  canTransition,
  DEAL_STATUS_TRANSITIONS,
  INVITE_TOKEN_TTL_HOURS_DEFAULT,
  type AllowedAction,
  type DealRequiredField,
} from '../common/constants';
import {
  CreatorSource,
  Currency,
  DealStatus,
  isTerminalDealStatus,
  ParticipantRole,
  PreferredLang,
} from '../common/enums';
import { DomainException } from '../common/errors';
import {
  assertValidDealAmount,
  formatMoney,
  type MoneyInput,
} from '../common/money';
import { PrismaService } from '../prisma';
import {
  generatePublicId,
  generateRawToken,
  hashToken,
} from '../common/tokens';
import {
  computeAllowedActions,
  type DealAllowedActionsInput,
  type DealViewer,
} from './deal.allowed-actions';
import {
  computeMissingFields as computeMissingFieldsFn,
  type DealMissingFieldsInput,
} from './deal.missing-fields';
import {
  computeTermsHash as computeTermsHashFn,
  type TermsHashInput,
} from './deal.terms-hash';
import type { DealActor } from './deal.types';

/**
 * Owner of every `Deal_Status` mutation. Stateless — all state lives in
 * Postgres and is reached through the caller-supplied
 * `Prisma.TransactionClient`.
 */
@Injectable()
export class DealService {
  constructor(
    private readonly auditService: AuditService,
    // task 5.2 — `create` opens a `prisma.runInTransaction` (R20.4) so
    // the deal row, the creator-side participant, both raw tokens, the
    // initial `DRAFT → AWAITING_COUNTERPARTY` transition, and the
    // `DEAL_CREATED` audit row commit together. Sibling tasks (5.6
    // section patches, 5.8 join, 5.9 approval) reuse `this.prisma`
    // through their own transaction callbacks.
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Atomically transition a deal from its current status to `to`,
   * recording a matching `AuditLogEntry` row in the same database
   * transaction.
   *
   * Validation order is significant:
   *
   *   1. Reject a missing transaction synchronously (R20.4). We do this
   *      before the state-machine check so a forgotten `tx` argument
   *      always fails the same way regardless of whether the rest of
   *      the call would have been valid.
   *   2. Reject transitions out of a terminal status
   *      ({@link isTerminalDealStatus}) with
   *      `DomainException.badRequest('deal.invalid_state', …)`.
   *      Terminal states (`RELEASED`, `REFUNDED`, `CANCELLED`,
   *      `EXPIRED`) are sinks — see design §"Deal Status state
   *      machine" — so we surface a distinct, dedicated rejection
   *      with `details.terminal: true` rather than letting it fall
   *      through to the generic illegal-transition branch.
   *   3. Reject illegal `(prev, next)` pairs with
   *      `DomainException.badRequest('deal.invalid_state', …)`. The
   *      response body's `details.allowed` lists the legal next
   *      statuses for the current state so the frontend can surface a
   *      precise message ("waiting for both approvals", "deal already
   *      paid", …) without re-deriving the state machine.
   *   4. Update the deal row, then write the audit row. Both writes go
   *      through `tx`, so a failure in either rolls back the entire
   *      caller transaction (R20.1, R20.4).
   *
   * The function intentionally does **not** re-read the deal before
   * updating: callers obtain the row via `tx.dealRoom.findUnique(...)`
   * (typically with `SELECT ... FOR UPDATE` semantics in their own
   * flow) and the `prev_status` recorded on the audit row reflects the
   * value they observed. If a concurrent transition lands between the
   * caller's read and our update, the unique constraint on
   * `DealRoom.id` and the row-level lock held by `tx` ensure we never
   * silently overwrite a competing change — Postgres serialises the
   * two transactions.
   *
   * @param deal   The deal row the caller already loaded inside `tx`.
   *               Its `status` field is treated as the previous status.
   * @param to     Target `DealStatus`. Validated against
   *               `DEAL_STATUS_TRANSITIONS[deal.status]`.
   * @param actor  `DealActor` performing the transition (see
   *               {@link DealActor} for the rationale behind the shape).
   * @param tx     Prisma transaction client. Required (R20.4).
   * @returns      The updated `DealRoom` row.
   * @throws       `DomainException.badRequest('deal.invalid_state', …)`
   *               when `(deal.status → to)` is not in the transitions
   *               table, or when `deal.status` is terminal. The
   *               `details` payload includes `current`, `requested`,
   *               `allowed`, and (for terminal statuses) `terminal:
   *               true` so callers and the frontend can render an
   *               actionable message.
   * @throws       `Error` synchronously when `tx` is missing/null.
   */
  async transition(
    deal: DealRoom,
    to: DealStatus,
    actor: DealActor,
    tx: Prisma.TransactionClient,
  ): Promise<DealRoom> {
    if (!tx) {
      // R20.4 — the deal update and matching audit row MUST commit
      // together. Without a `tx` we cannot guarantee that.
      throw new Error(
        'DealService.transition: tx is required; the deal status update and audit row MUST share the originating transaction (R20.1, R20.4).',
      );
    }

    const from = deal.status as DealStatus;

    // Terminal-state guard. Equivalent to `canTransition` returning
    // false (terminal rows are mapped to `[]` in
    // `DEAL_STATUS_TRANSITIONS`) but we surface it explicitly so the
    // error payload carries `terminal: true` and the frontend can
    // render a "deal already finalised" message instead of the
    // generic illegal-transition copy.
    if (isTerminalDealStatus(from)) {
      throw DomainException.badRequest('deal.invalid_state', {
        details: {
          current: from,
          requested: to,
          allowed: DEAL_STATUS_TRANSITIONS[from],
          terminal: true,
        },
      });
    }

    if (!canTransition(from, to)) {
      throw DomainException.badRequest('deal.invalid_state', {
        details: {
          current: from,
          requested: to,
          allowed: DEAL_STATUS_TRANSITIONS[from],
        },
      });
    }

    const updated = await tx.dealRoom.update({
      where: { id: deal.id },
      // `updated_at` is `@updatedAt` in `schema.prisma`, so Prisma
      // bumps it automatically on every `update(...)` call. We
      // intentionally do NOT pass it explicitly to avoid clobbering
      // Prisma's millisecond-precision value with our coarser one.
      data: { status: to },
    });

    await this.auditService.record(
      {
        action_type: 'DEAL_STATUS_TRANSITION',
        actor_user_id: actor.user_id ?? null,
        actor_role: actor.role ?? null,
        deal_id: deal.id,
        prev_status: from,
        new_status: to,
      },
      tx,
    );

    return updated;
  }

  // task 5.5 — allowed-actions entry point on the service -------------

  /**
   * Compute the viewer-scoped allowed actions for a deal. Pure
   * delegation onto {@link computeAllowedActions} — see that module
   * for the full per-status × role matrix and rationale.
   *
   * Source of truth: design §"Standard `DealRoomResponse` shape →
   * `AllowedAction`"; tasks.md §5.5; R6.3, R9.1, R12.1, R13.1, R17.1.
   *
   * Wallet-balance / currency / KHQR-availability gates are NOT
   * applied here — those surface as request-time errors from the
   * matching service. The frontend renders the action list verbatim.
   *
   * `viewer.role === null` (anonymous) and `viewer.role === 'admin'`
   * always return `[]`. Anonymous viewers must join the deal first;
   * admins use the dedicated admin endpoints.
   */
  computeAllowedActions(
    deal: DealAllowedActionsInput,
    viewer: DealViewer,
  ): readonly AllowedAction[] {
    return computeAllowedActions(deal, viewer);
  }

  // task 5.3 — terms-hash entry point on the service ---------------------

  /**
   * Canonical SHA-256 fingerprint of a deal's material-edit fields
   * (`product_title`, `product_description`, `deal_amount`,
   * `currency`). Static so callers can hash a deal without injecting
   * `DealService` (the same pure helper is also exported as
   * {@link computeTermsHashFn} from `./deal.terms-hash` and re-exported
   * from the module barrel).
   *
   * The two surfaces — the static method and the standalone export —
   * delegate to the same implementation, so they always agree
   * byte-for-byte. Use whichever fits the call site:
   *
   *   - Static (`DealService.computeTermsHash(deal)`) reads naturally
   *     from inside Deal-module code and from tests that already have
   *     a `DealService` reference.
   *   - Standalone (`import { computeTermsHash } from '../deal'`) is
   *     the right choice for adapters and bot handlers that want to
   *     compute the hash without touching the Nest DI container.
   *
   * See `deal.terms-hash.ts` for the full canonicalisation contract
   * (alphabetical key order, money normalisation via `formatMoney`,
   * verbatim string handling, lowercase 64-char hex output) and R8.1
   * for the requirements link.
   */
  static computeTermsHash(deal: TermsHashInput): string {
    return computeTermsHashFn(deal);
  }

  // task 5.4 — missing-fields entry point on the service ----------------

  /**
   * Returns the subset of `DEAL_REQUIRED_FIELDS` (Product_Title,
   * Product_Type, Deal_Amount, Buyer_Name, Seller_Name) that is
   * currently empty on the supplied deal, preserving the canonical
   * declaration order. Pure delegation onto {@link computeMissingFieldsFn}
   * — see `./deal.missing-fields.ts` for the full emptiness predicate.
   *
   * Source of truth: design §"DealService → computeMissingFields";
   * tasks.md §5.4; R6.1 (required-field set + emptiness rules) and
   * R6.5 (the missing-field array drives the
   * `READY_FOR_PAYMENT → AWAITING_BOTH_APPROVAL` revert path).
   *
   * Static so callers can compute the missing list without injecting
   * `DealService`. The standalone export (`computeMissingFields` from
   * `../deal`) and this method delegate to the same implementation
   * and always agree.
   *
   * @returns A frozen-shape `readonly` array. Callers that need a
   *   mutable copy should spread it.
   */
  static computeMissingFields(
    deal: DealMissingFieldsInput,
  ): readonly DealRequiredField[] {
    return computeMissingFieldsFn(deal);
  }

  // task 5.2 — DealService.create (seller flow + buyer flow) -------------

  /**
   * Create a fresh `DealRoom` and the surrounding scaffolding (creator
   * participant row, creator access token, invite token, initial
   * audit row, and the `DRAFT → AWAITING_COUNTERPARTY` transition) in
   * a single Prisma `$transaction`.
   *
   * Source of truth: tasks.md §5.2; design §"DealService → create";
   * R2.1–R2.9 (seller flow); R3.1–R3.6 (buyer flow); R4.3 (invite
   * token TTL); R20.1, R20.4 (audit + transactional integrity).
   *
   * ## Why everything goes inside one transaction (R20.4)
   *
   * The deal create flow performs **six** writes that must all commit
   * or all roll back:
   *
   *   1. `DealRoom` — the deal row itself, with `status: 'DRAFT'`.
   *   2. `DealParticipant` — the creator's seat (one buyer XOR one
   *      seller per deal, enforced by the `(deal_id, role)` UNIQUE).
   *   3. `CreatorAccessToken` — the creator's private link token,
   *      stored as a SHA-256 hash; raw value returned exactly once
   *      (R2.9 / R3.6).
   *   4. `InviteToken` — the counterparty's single-use link token,
   *      also hash-only with `expires_at = now + INVITE_TOKEN_TTL_HOURS`
   *      (R4.3 / R5.6).
   *   5. `AuditLogEntry` (`DEAL_CREATED`) — records who created the
   *      deal and through which surface (`creator_source`).
   *   6. `AuditLogEntry` (`DEAL_STATUS_TRANSITION`) + `DealRoom`
   *      update — written by `transition(...)` for the
   *      `DRAFT → AWAITING_COUNTERPARTY` step (R20.1).
   *
   * If any one of those writes fails (unique violation on
   * `public_id`, transient FK error, audit insert raising), every
   * preceding write rolls back. That guarantees we never leave a
   * `DealRoom` row without its creator participant, never mint a
   * raw access token whose hashed twin doesn't exist on disk, and
   * never publish an audit row out of sync with the actual state
   * change.
   *
   * ## Field-validation strategy
   *
   * The DTO (`CreateDealDto`) has already done all the cheap shape
   * checks: enum membership, length bounds, regex shape on the
   * money string. This method layers on the role-aware checks that
   * the DTO can't express:
   *
   *   - Seller flow (R2.1, R2.3) requires `seller_name`,
   *     `product_title`, `deal_amount`, `currency`. R2.5 says the
   *     seller create-step ignores optional fields outside that set
   *     ("phone, product type, product description, payout KHQR,
   *     payout bank info"). We honour R2.5 by dropping
   *     `product_description`, `quantity`, and `condition` from the
   *     persisted row when `creator_role === 'seller'` — those land
   *     during the patch flow (task 5.6) instead.
   *
   *   - Buyer flow (R3.1, R3.3) requires `buyer_name`,
   *     `product_title`, `deal_amount`, `currency` and accepts
   *     `buyer_phone`, `product_type`, `product_description` as
   *     optional fields per R3.2.
   *
   *   - Money: `assertValidDealAmount(...)` enforces the
   *     `[0.01, 999_999_999.99]` range and at-most-2-decimal
   *     precision (R2.1 / R3.1). On failure we surface
   *     `deal.invalid_field` with the parsed range hints in
   *     `details`.
   *
   * Anything outside the canonical set (the DTO does NOT model
   * payout fields) is silently absent — `CreateDealDto` deliberately
   * has no `payout_*` fields, so R2.5's "ignore and not persist" is
   * inherent in the wire shape.
   *
   * ## Token strategy (R2.9, R3.6, R4.3)
   *
   * Both the creator access token and the invite token use the
   * shared `generateRawToken()` (cuid v2) primitive. We hash with
   * `hashToken(raw)` before persisting and return the raw values in
   * the result envelope **exactly once**. Callers MUST NOT log
   * those raw values. The invite token gets `expires_at = now +
   * INVITE_TOKEN_TTL_HOURS_DEFAULT` (default 72 h, R4.3) sourced
   * from `INVITE_TOKEN_TTL_HOURS_DEFAULT` so the constant has a
   * single declaration site; environment-driven overrides land in
   * task 5.7 / `app.config.inviteTokenTtlHours` if/when needed.
   *
   * The creator access token does NOT expire on its own (R3.6 — the
   * link is private to the creator and is revoked at deal lifecycle
   * boundaries). No `expires_at` column exists on
   * `CreatorAccessToken`; we deliberately keep it that way.
   *
   * ## `terms_hash` is computed pre-transition
   *
   * `computeTermsHash` is pure and only reads the four material-edit
   * fields (`product_title`, `product_description`, `deal_amount`,
   * `currency`). We compute it once before the transaction opens so
   * the value lands on the initial `DealRoom.create` payload — the
   * approval state machine (R8.1) compares each `Approval.terms_hash`
   * snapshot against this value going forward.
   *
   * @param input  See {@link CreateDealInput}. The caller resolves
   *               the authenticated user id ahead of this call.
   * @returns      {@link CreateDealResult} with the persisted deal
   *               and the two raw tokens. Both raw values are
   *               surfaced exactly once and MUST NOT be logged.
   * @throws       `DomainException.badRequest('deal.missing_required_fields', …)`
   *               when role-conditional required fields are missing.
   * @throws       `DomainException.badRequest('deal.invalid_field', …)`
   *               when the deal amount falls outside the legal
   *               range / precision, or any other field-level
   *               invariant fails.
   */
  async create(input: CreateDealInput): Promise<CreateDealResult> {
    const { creatorUserId, creatorRole, creatorSource } = input;

    if (typeof creatorUserId !== 'string' || creatorUserId.length === 0) {
      // Programmer-error guard — the auth controller resolves the
      // session before invoking us; an empty/invalid id is a bug.
      throw new Error('DealService.create: creatorUserId is required (non-empty string).');
    }

    if (
      creatorRole !== ParticipantRole.buyer &&
      creatorRole !== ParticipantRole.seller
    ) {
      // R2.6 / R3.5 — only buyer or seller can create a deal. Admin
      // creation is not part of the spec; reject defensively before
      // any DB work.
      throw DomainException.badRequest('deal.invalid_field', {
        details: { field: 'creator_role', allowed: ['buyer', 'seller'] },
      });
    }

    // Role-conditional field selection (R2.5 + R3.2). The seller flow
    // ignores buyer-flow optional fields; the buyer flow ignores
    // seller-flow optional fields. We project the wire payload onto
    // the role-specific subset before any validation runs so error
    // messages mention only fields the caller is allowed to set.
    const sections = pickSections(input.sections, creatorRole);

    // Role-conditional required-field check (R2.3 / R3.3). The DTO
    // already enforced length / shape; we now verify the role-aware
    // required set. Returns the canonical `Missing_*` field names
    // for the response envelope.
    const missing = collectMissingRequired(sections, creatorRole);
    if (missing.length > 0) {
      throw DomainException.badRequest('deal.missing_required_fields', {
        details: { fields: missing, role: creatorRole },
      });
    }

    // Money validation (R2.1 / R3.1). We re-run `assertValidDealAmount`
    // here — the DTO regex only enforces shape, not range. A value of
    // `'1000000000.00'` parses fine but is out of range.
    let dealAmountString: string;
    try {
      const parsed = assertValidDealAmount(sections.deal_amount as MoneyInput);
      dealAmountString = formatMoney(parsed);
    } catch (error) {
      // Any failure from `parseMoney` / `assertValidDealAmount` maps
      // to `deal.invalid_field` per R2.4 / R3.3. The `RangeError`
      // message (`'money.invalid'` / `'money.out_of_range'`) is
      // surfaced in `details.reason` so the frontend can render a
      // precise message.
      const reason =
        error instanceof RangeError ? error.message : 'money.invalid';
      throw DomainException.badRequest('deal.invalid_field', {
        details: { field: 'deal_amount', reason },
      });
    }

    // Pre-compute the canonical fields that land on `DealRoom`. We
    // do this outside the transaction so the closure captures stable
    // values (cuid generation, hashing, terms-hash) and the tx
    // window stays as small as possible.
    const publicId = generatePublicId();
    const rawCreatorAccessToken = generateRawToken();
    const rawInviteToken = generateRawToken();
    const creatorAccessTokenHash = hashToken(rawCreatorAccessToken);
    const inviteTokenHash = hashToken(rawInviteToken);

    const now = new Date(Date.now());
    const inviteExpiresAt = new Date(
      now.getTime() + INVITE_TOKEN_TTL_HOURS_DEFAULT * 60 * 60 * 1000,
    );

    // Initial `terms_hash` snapshot (R8.1). Computing here from the
    // already-validated section values keeps the value in sync with
    // what we're about to persist; the approval state machine
    // (`Approval.terms_hash`) compares against this hash going
    // forward.
    const termsHash = computeTermsHashFn({
      product_title: sections.product_title ?? null,
      product_description: sections.product_description ?? null,
      deal_amount: dealAmountString,
      currency: sections.currency ?? null,
    });

    const resolvedCreatorSource = creatorSource ?? CreatorSource.web;

    // Single transaction (R20.4). All six writes share `tx`.
    const persistedDeal = await this.prisma.runInTransaction(async (tx) => {
      // 1. Insert the DealRoom in `DRAFT`. The state machine starts
      //    here; the `transition(...)` call below moves it to
      //    `AWAITING_COUNTERPARTY` in this same tx.
      const deal = await tx.dealRoom.create({
        data: {
          public_id: publicId,
          creator_user_id: creatorUserId,
          creator_role: creatorRole,
          creator_source: resolvedCreatorSource,
          status: DealStatus.DRAFT,
          // Section fields. Sellers' optional fields (R2.5) are already
          // dropped by `pickSections`; buyer fields are persisted as-is
          // including `null` for any unset optional field.
          product_title: sections.product_title ?? null,
          product_type: sections.product_type ?? null,
          product_description: sections.product_description ?? null,
          quantity: sections.quantity ?? null,
          condition: sections.condition ?? null,
          deal_amount: dealAmountString,
          currency: sections.currency ?? null,
          buyer_name: sections.buyer_name ?? null,
          seller_name: sections.seller_name ?? null,
          terms_hash: termsHash,
        },
      });

      // 2. Creator participant row. Phone / preferred_lang / messaging
      //    fields (`telegram_chat_id`, `wechat_id`, `messenger_name`)
      //    are deal-scoped contact preferences and live on the
      //    `DealParticipant` row, not on `DealRoom`. Only the creator
      //    is recorded here; the counterparty's row lands at join.
      await tx.dealParticipant.create({
        data: {
          deal_id: deal.id,
          user_id: creatorUserId,
          role: creatorRole,
          phone: sections.phone ?? null,
          preferred_lang:
            (sections.preferred_lang as PreferredLang | undefined) ?? null,
        },
      });

      // 3. Creator access token. UNIQUE on `(deal_id)` enforces "at
      //    most one creator token per deal" (R3.6). Hash-only;
      //    raw value returned in the result envelope below.
      await tx.creatorAccessToken.create({
        data: {
          deal_id: deal.id,
          user_id: creatorUserId,
          token_hash: creatorAccessTokenHash,
        },
      });

      // 4. Invite token. `expires_at` enforces the R4.3 TTL clock;
      //    `invalidated_at` stays NULL until the counterparty
      //    consumes the link via `InviteService.consume(...)`.
      await tx.inviteToken.create({
        data: {
          deal_id: deal.id,
          token_hash: inviteTokenHash,
          expires_at: inviteExpiresAt,
        },
      });

      // 5. `DEAL_CREATED` audit row (R20.1). The matching
      //    `DEAL_STATUS_TRANSITION` audit row is written by the
      //    `transition(...)` call below; both share the same `tx`
      //    so an audit failure rolls back the entire create flow.
      await this.auditService.record(
        {
          action_type: 'DEAL_CREATED',
          actor_user_id: creatorUserId,
          actor_role: creatorRole,
          deal_id: deal.id,
          metadata: { creator_source: resolvedCreatorSource },
        },
        tx,
      );

      // 6. `DRAFT → AWAITING_COUNTERPARTY` (R2.6 / R3.4). Funnelled
      //    through `transition(...)` so we never bypass the state
      //    machine and so the matching audit row lands in the same
      //    tx (R20.1). The returned row reflects the post-transition
      //    state.
      const transitioned = await this.transition(
        deal,
        DealStatus.AWAITING_COUNTERPARTY,
        { user_id: creatorUserId, role: creatorRole },
        tx,
      );

      return transitioned;
    });

    return {
      deal: persistedDeal,
      rawCreatorAccessToken,
      rawInviteToken,
    };
  }
}

// ---------------------------------------------------------------------------
// task 5.2 — Public input / result types for `DealService.create`
//
// Exported alongside the service from `./index.ts` so feature modules
// (auth controller wiring, Telegram bot adapter, tests) can compose
// the call without re-deriving the shape.
// ---------------------------------------------------------------------------

/**
 * Optional initial section fields accepted by {@link DealService.create}.
 *
 * The shape mirrors the snake_case columns on `DealRoom` and the
 * deal-scoped fields on `DealParticipant`. Each field is independently
 * optional — the role-aware required-field check inside `create(...)`
 * surfaces a `deal.missing_required_fields` envelope when a flow-
 * specific required field is absent.
 *
 * Optional fields outside the role's allow-list (e.g. a seller-created
 * deal carrying `product_description`) are silently dropped per R2.5
 * before validation. The DTO is the gate that enforces shape; this
 * type is the gate that enforces role.
 *
 * `deal_amount` accepts any `MoneyInput` (string / number / Decimal /
 * Prisma.Decimal) so callers don't have to pre-format the value;
 * `assertValidDealAmount` is invoked inside `create(...)` to
 * canonicalise to a 2-decimal `string`.
 */
// task 5.2
export interface CreateDealSections {
  product_title?: string | null;
  product_type?: string | null;
  product_description?: string | null;
  quantity?: number | null;
  condition?: 'new' | 'used' | null;
  deal_amount?: MoneyInput | null;
  currency?: Currency | null;

  buyer_name?: string | null;
  seller_name?: string | null;

  /** Creator's phone — stored on `DealParticipant`, not on `DealRoom`. */
  phone?: string | null;
  /** Creator's preferred UI language — stored on `DealParticipant`. */
  preferred_lang?: PreferredLang | null;
}

/**
 * Input shape for {@link DealService.create}. The `creatorRole`
 * narrowed to `'buyer' | 'seller'` rejects `'admin'` at the type
 * boundary (the runtime check inside `create(...)` is defence in
 * depth).
 *
 * `creatorSource` defaults to {@link CreatorSource.web} when omitted.
 * The Telegram bot adapter passes {@link CreatorSource.telegram}
 * explicitly when calling from `BotConversation` (R18.x).
 *
 * `ip` / `userAgent` are advisory request metadata reserved for the
 * future audit `metadata` payload — accepted today so the auth
 * controller can pass through `req.ip` / `req.headers['user-agent']`
 * without a follow-up signature change. The current implementation
 * does NOT persist them on the audit row to keep the metadata
 * payload narrow; see the `AuditService` rationale on metadata
 * hygiene.
 */
// task 5.2
export interface CreateDealInput {
  /** Authenticated `User.id` of the creator. */
  creatorUserId: string;
  /** Role the creator plays. R2.6 / R3.5. */
  creatorRole: Extract<ParticipantRole, 'buyer' | 'seller'>;
  /** Where the deal originated. Defaults to {@link CreatorSource.web}. */
  creatorSource?: CreatorSource;
  /** Optional initial section fields. */
  sections?: CreateDealSections;
  /** Best-effort request-origin metadata (advisory). */
  ip?: string | null;
  /** Best-effort request-origin metadata (advisory). */
  userAgent?: string | null;
}

/**
 * Result envelope returned by {@link DealService.create}.
 *
 * `deal` is the persisted `DealRoom` row in `AWAITING_COUNTERPARTY`
 * state (the initial `DRAFT → AWAITING_COUNTERPARTY` transition
 * already ran inside the create transaction).
 *
 * Both raw token values are surfaced **exactly once** (R2.9 / R3.6)
 * and MUST NOT be logged. The persisted rows store only their
 * SHA-256 hashes; subsequent lookups rehash candidates via
 * `verifyToken(...)`.
 */
// task 5.2
export interface CreateDealResult {
  deal: DealRoom;
  rawCreatorAccessToken: string;
  rawInviteToken: string;
}

// ---------------------------------------------------------------------------
// task 5.2 — internal helpers
// ---------------------------------------------------------------------------

/**
 * Project the caller-supplied {@link CreateDealSections} onto the
 * role-specific allow-list (R2.5 / R3.2).
 *
 *   - Seller flow keeps: `product_title`, `deal_amount`, `currency`,
 *     `seller_name`, `phone`, `preferred_lang`.
 *   - Buyer flow keeps: `product_title`, `product_type`,
 *     `product_description`, `deal_amount`, `currency`, `buyer_name`,
 *     `phone`, `preferred_lang`. R3.2 explicitly admits the optional
 *     buyer-flow fields.
 *
 * Fields outside the allow-list are dropped silently per R2.5 ("ignore
 * and not persist any such fields if submitted"). We do NOT raise an
 * error on stripped fields — the DTO already accepted them as a valid
 * shape and R2.5 mandates a silent no-op rather than a hard reject.
 */
function pickSections(
  raw: CreateDealSections | undefined,
  role: Extract<ParticipantRole, 'buyer' | 'seller'>,
): CreateDealSections {
  if (!raw) return {};

  if (role === ParticipantRole.seller) {
    // R2.5 — seller create-step ignores `product_type`,
    // `product_description`, `quantity`, `condition`, `buyer_name`,
    // and any optional buyer-side / payout fields.
    return {
      product_title: raw.product_title,
      deal_amount: raw.deal_amount,
      currency: raw.currency,
      seller_name: raw.seller_name,
      phone: raw.phone,
      preferred_lang: raw.preferred_lang,
    };
  }

  // Buyer flow (R3.2 admits product_type, product_description,
  // buyer_phone). `seller_name` is intentionally absent — the seller
  // fills it in after joining (R5.4).
  return {
    product_title: raw.product_title,
    product_type: raw.product_type,
    product_description: raw.product_description,
    quantity: raw.quantity,
    condition: raw.condition,
    deal_amount: raw.deal_amount,
    currency: raw.currency,
    buyer_name: raw.buyer_name,
    phone: raw.phone,
    preferred_lang: raw.preferred_lang,
  };
}

/**
 * Returns the role-conditional missing-required-field list (R2.3 /
 * R3.3). Field names match the canonical envelope set used in the
 * `deal.missing_required_fields` response and on the
 * `MissingField[]` surface returned by `computeMissingFields(...)`,
 * but the **role-aware** subset:
 *
 *   - Seller create step (R2.3): Seller_Name, Product_Title,
 *     Deal_Amount, Currency.
 *   - Buyer create step (R3.3): Buyer_Name, Product_Title,
 *     Deal_Amount, Currency.
 *
 * `Currency` is checked separately from the post-payment required
 * set in `DEAL_REQUIRED_FIELDS` because R6.1 omits it (the deal
 * cannot reach `READY_FOR_PAYMENT` without a currency, but it's not
 * one of the five "missing fields" surfaced in `missing_fields`).
 * For create-time validation it IS required, hence the explicit
 * check here.
 */
function collectMissingRequired(
  sections: CreateDealSections,
  role: Extract<ParticipantRole, 'buyer' | 'seller'>,
): string[] {
  const missing: string[] = [];

  if (isBlank(sections.product_title)) missing.push('Product_Title');
  if (sections.deal_amount === null || sections.deal_amount === undefined) {
    missing.push('Deal_Amount');
  }
  if (sections.currency === null || sections.currency === undefined) {
    missing.push('Currency');
  }

  if (role === ParticipantRole.seller) {
    if (isBlank(sections.seller_name)) missing.push('Seller_Name');
  } else {
    if (isBlank(sections.buyer_name)) missing.push('Buyer_Name');
  }

  return missing;
}

/** R6.1 emptiness predicate for string-shaped required fields. */
function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return true;
  return value.trim() === '';
}
