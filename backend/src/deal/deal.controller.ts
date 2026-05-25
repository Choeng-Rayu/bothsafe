/**
 * DealController — HTTP surface for Deal Room operations.
 *
 * Source of truth: design.md §"API Surface → Deals"; tasks.md §5.8 (join),
 * §5.9 (approval).
 *
 * # Task 5.8 — `POST /v1/deals/:publicId/join`
 *
 * Counterparty join. Implements R5.1–R5.10 inside a single
 * `prisma.runInTransaction` so the invite-token invalidation, the
 * `DealParticipant` insert, the deal-name backfill, the
 * `ParticipantAccessToken` mint, the `AWAITING_COUNTERPARTY →
 * AWAITING_BOTH_APPROVAL` transition, and the `DEAL_PARTICIPANT_JOINED`
 * audit row commit or roll back together (R5.6, R20.4).
 *
 * # Task 5.9 — `POST /v1/deals/:publicId/approval`
 *
 * Implements the approval endpoint per R8.1–R8.7. The endpoint is a
 * thin HTTP wrapper around {@link ApprovalService.recordApproval}: it
 * loads the deal by `public_id` inside a transaction, hands the row +
 * authenticated user + `tx` off to the service, then projects the
 * service result onto the standard `DealRoomResponse` shape.
 *
 * The actual business logic — participant lookup, idempotency on the
 * snapshotted `terms_hash`, both-approved transition, audit row,
 * `BOTH_APPROVED` outbox emission — lives in {@link ApprovalService}
 * so it stays unit-testable without HTTP plumbing and so the
 * Telegram-bot / admin / future API call sites can reuse the same
 * service.
 *
 * # Why a single transaction
 *
 * R20.1–R20.4 require that the approval insert, the matching audit
 * row, the (optional) deal status transition, and the (optional)
 * outbox row all commit or roll back together. We open the
 * `prisma.runInTransaction(...)` boundary at the controller — rather
 * than inside `ApprovalService` — for two reasons:
 *
 *   1. The deal lookup by `public_id` shares the same transaction as
 *      the writes, so the row is locked from the moment we read it
 *      and concurrent approvals serialise predictably (the second
 *      write either finds the first approval already inserted and
 *      flips `READY_FOR_PAYMENT`, or sees its own duplicate and
 *      short-circuits via R8.7 idempotency).
 *   2. Sibling controllers in this module (sections, join) follow
 *      the same "controller opens tx, services share it" pattern, so
 *      the transactional boundary is consistent across the deal
 *      surface.
 */

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AuditService } from '../audit';
import { AuthGuard, CurrentUser, type AuthenticatedUser } from '../auth';
import {
  DealStatus,
  NotificationEvent,
  ParticipantRole,
} from '../common/enums';
import { DomainException } from '../common/errors';
import { generateRawToken, hashToken } from '../common/tokens';
import { PrismaService } from '../prisma';
import { ApprovalService } from './approval.service';
import { DealSectionPatchService } from './deal-section-patch.service';
import { computeMissingFields } from './deal.missing-fields';
import { DealService } from './deal.service';
import { CreateDealDto } from './dto/create-deal.dto';
import { JoinDealDto } from './dto/join-deal.dto';
import { PatchDeliveryDto } from './dto/patch-delivery.dto';
import { PatchParticipantDto } from './dto/patch-participant.dto';
import { PatchPayoutDto } from './dto/patch-payout.dto';
import { PatchProductDto } from './dto/patch-product.dto';
import { InviteService, type InviteRole } from './invite.service';

/**
 * Standard `DealRoomResponse` shape returned by every deal action endpoint.
 *
 * Source of truth: design.md §"Standard `DealRoomResponse` shape".
 *
 * `deal_amount` serialises as `string | null` (not a JS `number`) so
 * KHR amounts like `999_999_999.99` keep their two-decimal precision
 * across the JSON boundary.
 */
export interface DealRoomResponse {
  deal: {
    public_id: string;
    status: DealStatus;
    product_title: string | null;
    product_type: string | null;
    product_description: string | null;
    quantity: number | null;
    condition: string | null;
    deal_amount: string | null;
    currency: string | null;
    buyer_name: string | null;
    seller_name: string | null;
    created_at: Date;
    updated_at: Date;
  };
  missing_fields: string[];
  allowed_actions: readonly string[];
  message_key?: string;
}

/**
 * Extended response shape returned by `POST /v1/deals/:publicId/join`.
 *
 * Carries the standard `DealRoomResponse` envelope plus the freshly
 * minted raw participant access token. The raw token is returned
 * exactly once per R5.8; clients persist it in an `httpOnly` cookie or
 * `localStorage` on receipt and never resurface it. We store only the
 * SHA-256 hash on `participant_access_token.token_hash`.
 */
export interface JoinDealResponse extends DealRoomResponse {
  raw_participant_access_token: string;
}

/**
 * Response shape for `POST /v1/deals` — the creator-only return envelope
 * carries the raw creator-access token and raw invite token alongside
 * the standard `DealRoomResponse`. Both raw values appear exactly once
 * (R2.9 / R3.6) and MUST be persisted client-side immediately.
 */
export interface CreateDealResponse extends DealRoomResponse {
  raw_creator_access_token: string;
  raw_invite_token: string;
}

/**
 * Deal Room controller. All routes live under the global `/v1` prefix
 * configured in `main.ts` plus the controller-level `/deals` segment,
 * giving us paths like `/v1/deals/:publicId/approval`.
 */
@Controller('deals')
export class DealController {
  constructor(
    private readonly dealService: DealService,
    private readonly approvalService: ApprovalService,
    private readonly prisma: PrismaService,
    // task 5.8 — additional collaborators for the join endpoint:
    //   - `InviteService.consume` flips the invite's `invalidated_at`
    //     atomically (R5.6, R5.7) and returns `expected_role`;
    //   - `AuditService.record` writes the `DEAL_PARTICIPANT_JOINED`
    //     audit row alongside the transition's `DEAL_STATUS_TRANSITION`
    //     row (R20.1, R20.4).
    private readonly inviteService: InviteService,
    private readonly auditService: AuditService,
    // task 5.6 — `DealSectionPatchService` owns the four section-patch
    // routes (R7.1–R7.7). The controller is a thin HTTP wrapper: it
    // applies `AuthGuard` + global `ValidationPipe` (declared in
    // `main.ts`), forwards the DTO + `currentUser`, then projects the
    // service result onto the standard wire envelope via
    // `buildDealRoomResponse` so the four patch routes return the same
    // shape as `/join` and `/approval`.
    private readonly sectionPatchService: DealSectionPatchService,
  ) {}

  // task 5.2
  /**
   * `POST /v1/deals`
   *
   * Creator-only deal-room creation (R2 + R3). Authenticated user
   * becomes the first `DealParticipant` in `creator_role`; the deal
   * row transitions `DRAFT → AWAITING_COUNTERPARTY` inside the same
   * transaction (R2.7 / R3.5). Raw `creator_access_token` and raw
   * `invite_token` are surfaced exactly once on the response — only
   * SHA-256 hashes persist (R2.9 / R3.6).
   *
   * Errors:
   *   - 400 `errors.deal.invalid_field` — DTO-level validation miss.
   *   - 422 `deal.missing_required_fields` — role-specific required
   *     field absent (R2.3 / R3.3).
   *
   * Requirements: R2.1–R2.9, R3.1–R3.6, R20.4.
   */
  @UseGuards(AuthGuard)
  @Post()
  @HttpCode(HttpStatus.OK)
  async create(
    @Body() dto: CreateDealDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<CreateDealResponse> {
    const result = await this.dealService.create({
      creatorUserId: currentUser.id,
      creatorRole: dto.creator_role,
      creatorSource: dto.creator_source,
      sections: {
        product_title: dto.product_title,
        product_type: dto.product_type,
        product_description: dto.product_description,
        quantity: dto.quantity,
        condition: dto.condition,
        deal_amount: dto.deal_amount,
        currency: dto.currency,
        buyer_name: dto.buyer_name,
        seller_name: dto.seller_name,
        phone: dto.phone,
        preferred_lang: dto.preferred_lang,
      },
    });

    const missingFields = computeMissingFields(result.deal);
    const allowedActions = this.dealService.computeAllowedActions(result.deal, {
      user_id: currentUser.id,
      role: dto.creator_role,
      hasApproved: false,
    });

    return {
      ...buildDealRoomResponse(result.deal, missingFields, allowedActions),
      raw_creator_access_token: result.rawCreatorAccessToken,
      raw_invite_token: result.rawInviteToken,
    };
  }

  // task 5.8
  /**
   * `POST /v1/deals/:publicId/join`
   *
   * Counterparty join (R5.1–R5.10). Single transaction:
   *
   *   1. Load the deal by `public_id` (404 → `deal.not_found`).
   *   2. `InviteService.consume(rawInvite, currentUser.id, tx)` — flips
   *      `invalidated_at` and returns `{ deal_id, expected_role }`.
   *   3. Validate `consume.deal_id` matches the URL deal (defence-in-
   *      depth against a token from a different deal landing here →
   *      `invite.invalid` 404).
   *   4. Validate the role-appropriate `Buyer_Name` / `Seller_Name` is
   *      present (R5.3, R5.4 → `join.invalid_field` 400 on miss).
   *   5. Insert the `DealParticipant` row (P2002 → `deal.already_joined`
   *      409).
   *   6. Backfill `DealRoom.{buyer,seller}_name` from the body or
   *      `User.display_name` when not already set (so the deal-amount
   *      / approval flow has the names it needs).
   *   7. Mint a `ParticipantAccessToken`: cuid v2 raw, SHA-256 stored
   *      (R5.8); raw returned exactly once in the response.
   *   8. Run `dealService.transition(deal, AWAITING_BOTH_APPROVAL, ...)`
   *      so the state machine and audit trail stay consistent (R5.6).
   *   9. `auditService.record({ action_type: 'DEAL_PARTICIPANT_JOINED',
   *      actor_user_id, actor_role, deal_id, metadata: { invite_consumed:
   *      true } }, tx)` — dedicated audit row for the join action.
   *  10. Enqueue `COUNTERPARTY_JOINED` outbox row.
   *  11. Re-read the deal, project onto the standard response envelope,
   *      attach `raw_participant_access_token`.
   *
   * Requirements: R5.1–R5.10, R20.1, R20.4.
   */
  @UseGuards(AuthGuard)
  @Post(':publicId/join')
  @HttpCode(HttpStatus.OK)
  async join(
    @Param('publicId') publicId: string,
    @Body() dto: JoinDealDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<JoinDealResponse> {
    return this.prisma.runInTransaction(async (tx) => {
      // -----------------------------------------------------------------
      // Step 1 — Load DealRoom by public_id (R5.1; 404 → deal.not_found)
      // -----------------------------------------------------------------
      const deal = await tx.dealRoom.findUnique({
        where: { public_id: publicId },
      });
      if (!deal) {
        throw DomainException.notFound('deal.not_found');
      }

      // -----------------------------------------------------------------
      // Step 2 — Consume the invite token (R5.6 atomic; R5.7 errors).
      // `InviteService.consume`:
      //   - hashes the raw invite,
      //   - flips `invalidated_at` via a compare-and-set inside `tx`,
      //   - validates the deal is `AWAITING_COUNTERPARTY`,
      //   - returns `{ deal_id, expected_role }`.
      // Any failure raises `invite.consumed` (R5.7); our transaction
      // rolls back, leaving the token row in its original state.
      // -----------------------------------------------------------------
      const consumed = await this.inviteService.consume(
        dto.invite,
        currentUser.id,
        tx,
      );

      // -----------------------------------------------------------------
      // Step 3 — Cross-check the invite's `deal_id` against the URL.
      // The URL embeds the deal's `public_id`; the token is bound to a
      // `deal_id`. A mismatch means the token was issued for a different
      // deal — surface as `invite.invalid` so probing whether such a
      // token exists is impossible.
      // -----------------------------------------------------------------
      if (consumed.deal_id !== deal.id) {
        throw DomainException.notFound('invite.invalid');
      }

      // -----------------------------------------------------------------
      // Step 4 — Validate the role-appropriate name (R5.3, R5.4, R5.10).
      // The DTO already trimmed and bounded both name fields; here we
      // ensure the one matching the resolved role is present. The
      // other side's name (if supplied) is ignored.
      // -----------------------------------------------------------------
      const joinerName = pickJoinerName(consumed.expected_role, dto);
      if (joinerName === null) {
        throw DomainException.badRequest('join.invalid_field', {
          details: { field: roleNameField(consumed.expected_role) },
        });
      }

      // -----------------------------------------------------------------
      // Step 5 — Insert the `DealParticipant` row (R5.6).
      // `(deal_id, user_id)` UNIQUE catches the second-join race.
      // -----------------------------------------------------------------
      try {
        await tx.dealParticipant.create({
          data: {
            deal_id: deal.id,
            user_id: currentUser.id,
            role: consumed.expected_role,
            phone: dto.phone ?? null,
          },
        });
      } catch (err) {
        if (isPrismaUniqueViolation(err)) {
          throw DomainException.conflict('deal.already_joined');
        }
        throw err;
      }

      // -----------------------------------------------------------------
      // Step 6 — Backfill the joiner's name on the DealRoom row.
      // We prefer the body's `buyer_name` / `seller_name` (already
      // trimmed by the DTO and validated above) over
      // `User.display_name` because it is what the joiner explicitly
      // typed for this deal.
      // -----------------------------------------------------------------
      const nameField =
        consumed.expected_role === ParticipantRole.buyer
          ? 'buyer_name'
          : 'seller_name';
      const currentNameValue = deal[nameField];
      const fallbackName =
        joinerName ??
        (typeof currentUser.display_name === 'string' &&
        currentUser.display_name.trim().length > 0
          ? currentUser.display_name
          : null);
      const shouldBackfill =
        fallbackName !== null &&
        (currentNameValue === null ||
          currentNameValue === undefined ||
          (typeof currentNameValue === 'string' &&
            currentNameValue.trim().length === 0));

      if (shouldBackfill) {
        await tx.dealRoom.update({
          where: { id: deal.id },
          data: { [nameField]: fallbackName },
        });
      }

      // -----------------------------------------------------------------
      // Step 7 — Mint a `ParticipantAccessToken` (R5.8). Raw returned
      // once; only the SHA-256 hash is stored.
      // -----------------------------------------------------------------
      const rawAccessToken = generateRawToken();
      await tx.participantAccessToken.create({
        data: {
          deal_id: deal.id,
          user_id: currentUser.id,
          token_hash: hashToken(rawAccessToken),
        },
      });

      // -----------------------------------------------------------------
      // Step 8 — Status transition (R5.6).
      // `AWAITING_COUNTERPARTY → AWAITING_BOTH_APPROVAL`. Writes the
      // `DEAL_STATUS_TRANSITION` audit row inside the same `tx`. If
      // the deal somehow slid out of `AWAITING_COUNTERPARTY` between
      // step 1 and here, the service throws `deal.invalid_state` and
      // the whole transaction rolls back, leaving the invite-token
      // and participant rows in their original state.
      // -----------------------------------------------------------------
      await this.dealService.transition(
        deal,
        DealStatus.AWAITING_BOTH_APPROVAL,
        { user_id: currentUser.id, role: consumed.expected_role },
        tx,
      );

      // -----------------------------------------------------------------
      // Step 9 — Dedicated `DEAL_PARTICIPANT_JOINED` audit row.
      // The transition above wrote a `DEAL_STATUS_TRANSITION` row;
      // this second write captures the join action specifically so
      // the audit timeline shows "User X joined as buyer/seller"
      // alongside the status flip. `metadata.invite_consumed` flags
      // the row as the result of an invite-token consume vs. a
      // future admin-driven invite path.
      // -----------------------------------------------------------------
      await this.auditService.record(
        {
          action_type: 'DEAL_PARTICIPANT_JOINED',
          actor_user_id: currentUser.id,
          actor_role: consumed.expected_role,
          deal_id: deal.id,
          metadata: { invite_consumed: true },
        },
        tx,
      );

      // -----------------------------------------------------------------
      // Step 10 — Enqueue the `COUNTERPARTY_JOINED` outbox row. The
      // drainer (§10.x) resolves recipients from the deal participant
      // roster. Inline insert until §10.1 wires
      // `NotificationOutboxService.enqueue(...)`.
      // -----------------------------------------------------------------
      await tx.notificationOutboxEntry.create({
        data: {
          event: NotificationEvent.COUNTERPARTY_JOINED,
          recipient_kind: 'deal_participants',
          recipient_id: null,
          payload: {
            deal_id: deal.id,
            actor_user_id: currentUser.id,
            joined_role: consumed.expected_role,
          },
        },
      });

      // -----------------------------------------------------------------
      // Step 11 — Re-read so the response reflects the post-write
      // state (status from step 8, name from step 6).
      // -----------------------------------------------------------------
      const finalDeal = await tx.dealRoom.findUnique({
        where: { id: deal.id },
      });
      if (!finalDeal) {
        // Unreachable — we just wrote to this row inside `tx`.
        throw new Error(
          'DealController.join: post-update lookup returned null; transaction state is inconsistent.',
        );
      }

      const missingFields = computeMissingFields(finalDeal);
      const allowedActions = this.dealService.computeAllowedActions(
        finalDeal,
        {
          user_id: currentUser.id,
          role: consumed.expected_role,
          // The joiner has not yet approved — both sides will approve
          // through the §5.9 endpoint after a final review.
          hasApproved: false,
        },
      );

      const baseResponse = buildDealRoomResponse(
        finalDeal,
        missingFields,
        allowedActions,
      );

      return {
        ...baseResponse,
        raw_participant_access_token: rawAccessToken,
      };
    });
  }

  // task 5.9
  /**
   * `POST /v1/deals/:publicId/approval`
   *
   * Records the current user's approval of the deal's current terms.
   * Transitions to `READY_FOR_PAYMENT` when both participants hold an
   * active approval for the same `terms_hash` and all required fields
   * are present. Idempotent on resubmit with the same hash (R8.7).
   *
   * Behaviour reference (delegated to {@link ApprovalService.recordApproval}):
   *   - 404 `deal.not_found`               — `public_id` does not match.
   *   - 409 `deal.approval_not_allowed`    — wrong status (R8.2).
   *   - 403 `auth.role_forbidden`          — viewer is not a buyer/seller
   *                                          participant of this deal (R8.6).
   *   - 422 `deal.missing_required_fields` — at least one required field
   *                                          is empty; `details.missing_fields`
   *                                          enumerates them (R6.3, R6.5).
   *
   * Requirements: R8.1–R8.7, R6.3, R6.4.
   */
  @Post(':publicId/approval')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  async approve(
    @Param('publicId') publicId: string,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<DealRoomResponse> {
    return this.prisma.runInTransaction(async (tx) => {
      // -----------------------------------------------------------------
      // Load DealRoom by public_id — 404 if absent. Done at the
      // controller (rather than the service) so the service's input
      // contract is "you already have the row" — keeps the service
      // unit-testable without `dealRoom.findUnique` mocks and lets
      // future call sites (bot, admin) skip the lookup when they
      // already have the row in hand.
      // -----------------------------------------------------------------
      const deal = await tx.dealRoom.findUnique({
        where: { public_id: publicId },
      });

      if (!deal) {
        // R-Standard: `deal.not_found` is the canonical envelope-level
        // miss for any `/v1/deals/:publicId/...` route.
        throw DomainException.notFound('deal.not_found');
      }

      // -----------------------------------------------------------------
      // Hand off to the approval service. It validates status,
      // participant membership, missing fields, computes the canonical
      // terms hash, snapshots the approval, drives the both-approved
      // transition, writes the audit row, and emits the outbox.
      // -----------------------------------------------------------------
      const result = await this.approvalService.recordApproval(
        deal,
        { id: currentUser.id },
        tx,
      );

      // -----------------------------------------------------------------
      // Build the DealRoomResponse. We re-derive `missing_fields` and
      // `allowed_actions` from the (possibly-transitioned) deal so the
      // response always reflects the post-write state — never the
      // pre-write snapshot we passed into the service.
      //
      // `viewer.role` is resolved by re-reading the participant row.
      // The service already validated that the row exists, so the
      // re-read inside the same `tx` is cheap (PK-indexed) and keeps
      // the controller from threading the role through the service
      // result purely for `computeAllowedActions` consumption.
      // -----------------------------------------------------------------
      const participant = await tx.dealParticipant.findUnique({
        where: {
          deal_id_user_id: {
            deal_id: result.deal.id,
            user_id: currentUser.id,
          },
        },
        select: { role: true },
      });

      const viewerRole = (participant?.role ?? null) as ParticipantRole | null;
      const missingFields = computeMissingFields(result.deal);
      const allowedActions = this.dealService.computeAllowedActions(
        result.deal,
        {
          user_id: currentUser.id,
          role: viewerRole,
          // Whether `inserted` is true (fresh row) or false (idempotent
          // R8.7), the viewer's active approval matches the current
          // hash by the time we get here, so the UI hides the
          // `approve` action.
          hasApproved: true,
        },
      );

      return buildDealRoomResponse(
        result.deal,
        missingFields,
        allowedActions,
        'messages.deal.approved',
      );
    });
  }

  // task 5.6 — section-patch routes
  // ---------------------------------------------------------------------
  // The four `/sections/:section` PATCH routes are thin HTTP wrappers
  // around `DealSectionPatchService`. The service owns:
  //
  //   - locking edits after payment (R7.5 → `deal.locked_after_payment`),
  //   - participant ownership / role checks (R7.2, R7.6 →
  //     `auth.role_forbidden`),
  //   - material-edit detection + approval invalidation + revert to
  //     `AWAITING_BOTH_APPROVAL` (R7.3, R8.4),
  //   - non-material preservation of approvals + status (R7.4),
  //   - field-bound validation in cooperation with the global
  //     `ValidationPipe` configured in `main.ts` (R7.7 →
  //     `deal.invalid_field`),
  //   - `terms_hash` refresh (R8.1).
  //
  // The controller's only job is to authenticate, validate the DTO,
  // forward the call, and project the service's `DealRoomApiResponse`
  // onto the standard `DealRoomResponse` wire shape so the four patch
  // routes return the same envelope as `/join` and `/approval`.

  /**
   * `PATCH /v1/deals/:publicId/sections/product`
   *
   * Edit any subset of the product section fields (R7.1):
   * `product_title`, `product_type`, `product_description`,
   * `quantity`, `condition`, `deal_amount`, `currency`.
   *
   * Behaviour:
   *   - Material edits to `product_title` / `product_description` /
   *     `deal_amount` / `currency` invalidate prior approvals and
   *     revert `Deal_Status` to `AWAITING_BOTH_APPROVAL` (R7.3).
   *   - Non-material edits (`product_type`, `quantity`, `condition`)
   *     preserve approvals + status (R7.4).
   *
   * Errors:
   *   - 404 `deal.not_found`            — `public_id` does not match.
   *   - 403 `auth.role_forbidden`       — caller is not a participant (R7.6).
   *   - 400 `deal.locked_after_payment` — status is past `READY_FOR_PAYMENT` (R7.5).
   *   - 400 `deal.invalid_field`        — out-of-bound value (R7.7).
   *
   * Requirements: R7.1, R7.3, R7.4, R7.5, R7.7.
   */
  @UseGuards(AuthGuard)
  @Patch(':publicId/sections/product')
  @HttpCode(HttpStatus.OK)
  async patchProduct(
    @Param('publicId') publicId: string,
    @Body() dto: PatchProductDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<DealRoomResponse> {
    const result = await this.sectionPatchService.patchProduct(
      publicId,
      dto,
      currentUser,
    );
    return buildDealRoomResponse(
      result.deal,
      result.missing_fields,
      result.allowed_actions,
    );
  }

  /**
   * `PATCH /v1/deals/:publicId/sections/participant`
   *
   * Edit the participant-owned personal fields linked to the caller's
   * own `User` id (R7.2):
   *
   *   - `buyer_name` / `buyer_phone` — only when the caller is the buyer.
   *   - `seller_name` / `seller_phone` — only when the caller is the seller.
   *   - `preferred_lang` — caller's own row.
   *
   * Attempts to set the other side's name / phone are rejected with
   * `auth.role_forbidden` (R7.6).
   *
   * All participant fields are non-material — approvals and status are
   * preserved (R7.4).
   *
   * Errors:
   *   - 404 `deal.not_found`            — `public_id` does not match.
   *   - 403 `auth.role_forbidden`       — non-participant or wrong-role
   *                                       attempt to set the other
   *                                       side's identity (R7.6).
   *   - 400 `deal.locked_after_payment` — status is past `READY_FOR_PAYMENT` (R7.5).
   *   - 400 `deal.invalid_field`        — out-of-bound value (R7.7).
   *
   * Requirements: R7.2, R7.4, R7.5, R7.6, R7.7.
   */
  @UseGuards(AuthGuard)
  @Patch(':publicId/sections/participant')
  @HttpCode(HttpStatus.OK)
  async patchParticipant(
    @Param('publicId') publicId: string,
    @Body() dto: PatchParticipantDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<DealRoomResponse> {
    const result = await this.sectionPatchService.patchParticipant(
      publicId,
      dto,
      currentUser,
    );
    return buildDealRoomResponse(
      result.deal,
      result.missing_fields,
      result.allowed_actions,
    );
  }

  /**
   * `PATCH /v1/deals/:publicId/sections/delivery`
   *
   * Edit delivery section fields (R7.1):
   * `delivery_method`, `delivery_address`, `delivery_note`.
   *
   * Delivery fields are entirely non-material — approvals and status
   * are preserved (R7.4).
   *
   * Errors:
   *   - 404 `deal.not_found`            — `public_id` does not match.
   *   - 403 `auth.role_forbidden`       — caller is not a participant (R7.6).
   *   - 400 `deal.locked_after_payment` — status is past `READY_FOR_PAYMENT` (R7.5).
   *   - 400 `deal.invalid_field`        — out-of-bound value (R7.7).
   *
   * Requirements: R7.1, R7.4, R7.5, R7.7.
   */
  @UseGuards(AuthGuard)
  @Patch(':publicId/sections/delivery')
  @HttpCode(HttpStatus.OK)
  async patchDelivery(
    @Param('publicId') publicId: string,
    @Body() dto: PatchDeliveryDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<DealRoomResponse> {
    const result = await this.sectionPatchService.patchDelivery(
      publicId,
      dto,
      currentUser,
    );
    return buildDealRoomResponse(
      result.deal,
      result.missing_fields,
      result.allowed_actions,
    );
  }

  /**
   * `PATCH /v1/deals/:publicId/sections/payout`
   *
   * Edit payout section fields (R7.1):
   * `payout_khqr`, `payout_bank_name`, `payout_account_name`,
   * `payout_account_number`. Seller-only — buyers and other roles
   * are rejected with `auth.role_forbidden` (R7.6).
   *
   * Payout fields are non-material — approvals and status are
   * preserved (R7.4).
   *
   * Errors:
   *   - 404 `deal.not_found`            — `public_id` does not match.
   *   - 403 `auth.role_forbidden`       — caller is not the seller (R7.6).
   *   - 400 `deal.locked_after_payment` — status is past `READY_FOR_PAYMENT` (R7.5).
   *   - 400 `deal.invalid_field`        — out-of-bound value (R7.7).
   *
   * Requirements: R7.1, R7.4, R7.5, R7.6, R7.7.
   */
  @UseGuards(AuthGuard)
  @Patch(':publicId/sections/payout')
  @HttpCode(HttpStatus.OK)
  async patchPayout(
    @Param('publicId') publicId: string,
    @Body() dto: PatchPayoutDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<DealRoomResponse> {
    const result = await this.sectionPatchService.patchPayout(
      publicId,
      dto,
      currentUser,
    );
    return buildDealRoomResponse(
      result.deal,
      result.missing_fields,
      result.allowed_actions,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Project a `DealRoom` row onto the standard `DealRoomResponse` shape.
 *
 * Hand-rolled rather than `prisma.select`-driven because:
 *   - `deal_amount` is serialised to a string to prevent IEEE-754
 *     precision loss on large KHR amounts;
 *   - `missing_fields` and `allowed_actions` are derived values, not
 *     columns;
 *   - `message_key` is conditionally included only when supplied.
 */
function buildDealRoomResponse(
  deal: {
    public_id: string;
    status: DealStatus;
    product_title: string | null;
    product_type: string | null;
    product_description: string | null;
    quantity: number | null;
    condition: string | null;
    deal_amount: Prisma.Decimal | null;
    currency: string | null;
    buyer_name: string | null;
    seller_name: string | null;
    created_at: Date;
    updated_at: Date;
  },
  missingFields: readonly string[],
  allowedActions: readonly string[],
  messageKey?: string,
): DealRoomResponse {
  return {
    deal: {
      public_id: deal.public_id,
      status: deal.status,
      product_title: deal.product_title,
      product_type: deal.product_type,
      product_description: deal.product_description,
      quantity: deal.quantity,
      condition: deal.condition,
      deal_amount:
        deal.deal_amount === null ? null : deal.deal_amount.toString(),
      currency: deal.currency,
      buyer_name: deal.buyer_name,
      seller_name: deal.seller_name,
      created_at: deal.created_at,
      updated_at: deal.updated_at,
    },
    missing_fields: [...missingFields],
    allowed_actions: allowedActions,
    ...(messageKey !== undefined ? { message_key: messageKey } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers — task 5.8
// ---------------------------------------------------------------------------

/**
 * Pick the role-appropriate name from the join body. Returns the
 * trimmed, non-empty string when present, or `null` when missing /
 * empty / wrong-typed (R5.3, R5.4, R5.10). The DTO has already
 * applied trim + length bounds, so this function is pure routing.
 *
 * If the DTO carried `buyer_name` for a join that resolved to
 * `seller`, the field is ignored — only the role-specific name
 * counts. The `null` return value triggers `join.invalid_field` at
 * the call site.
 */
function pickJoinerName(
  expectedRole: InviteRole,
  dto: JoinDealDto,
): string | null {
  const value =
    expectedRole === ParticipantRole.buyer ? dto.buyer_name : dto.seller_name;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Map an `InviteRole` onto the public-facing field name carried in
 * `details.field` of the `join.invalid_field` response. The frontend
 * uses this to highlight the right input on the join form.
 */
function roleNameField(expectedRole: InviteRole): 'buyer_name' | 'seller_name' {
  return expectedRole === ParticipantRole.buyer ? 'buyer_name' : 'seller_name';
}

/**
 * Detect a Prisma `P2002` unique-constraint violation without
 * importing `Prisma.PrismaClientKnownRequestError` directly (which
 * cross-loads the runtime types). The Prisma 7 driver-adapter setup
 * occasionally produces errors that fail the `instanceof` check but
 * carry the same `code` shape, so we structurally test for the
 * `'P2002'` code in addition.
 */
function isPrismaUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const maybe = err as { code?: unknown; name?: unknown };
  return (
    maybe.code === 'P2002' ||
    (maybe.name === 'PrismaClientKnownRequestError' && maybe.code === 'P2002')
  );
}

/**
 * Defensive type-narrow used only to hint to the unused-variable
 * linter that we deliberately keep `Prisma` imported for type-only
 * use in the helpers above. (No-op at runtime.)
 */
type _PrismaTxClientUnused = Prisma.TransactionClient | undefined;
