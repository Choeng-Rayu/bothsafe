/**
 * DealSectionPatchService — implements the 4 section-patch business rules
 * (task 5.6).
 *
 * Source of truth: tasks.md §5.6; requirements.md R7.1–R7.7;
 * design.md §"DealService (`src/deal/`)" + §"Key Algorithms … Deal terms hash".
 *
 * ## Responsibilities
 *
 *   1. Load the deal by `public_id` — 404 if not found.
 *   2. Verify the user is a `DealParticipant` on this deal — 403 if not (R7.6).
 *   3. Verify the deal status is in the permitted edit set (R7.5):
 *      `DRAFT`, `AWAITING_COUNTERPARTY`, `AWAITING_BOTH_APPROVAL`,
 *      `READY_FOR_PAYMENT`. All other statuses → `deal.locked_after_payment`.
 *   4. Apply the update inside `prisma.runInTransaction(...)`.
 *   5. If the patch touches any `DEAL_MATERIAL_EDIT_FIELDS` fields
 *      (`product_title`, `product_description`, `deal_amount`, `currency`):
 *       - Invalidate all approvals (`invalidated_at = now()`).
 *       - Revert status to `AWAITING_BOTH_APPROVAL` via
 *         `DealService.transition(...)` (R7.3).
 *      Otherwise, leave existing approvals and status untouched (R7.4).
 *   6. Recompute `computeTermsHash` after the update and persist the new
 *      hash on `DealRoom.terms_hash` if it changed.
 *   7. Return `{ deal, missing_fields, allowed_actions }` (R6.2, R6.3).
 *
 * ## Payout section (R7.6)
 *
 *   Only the `seller` participant may edit payout fields. Non-seller callers
 *   (buyer, anonymous, admin) receive `DomainException.forbidden('auth.role_forbidden')`.
 *
 * ## Participant section (R7.2, R7.6)
 *
 *   Each participant may edit only the name, phone, and preferred language
 *   linked to **their own** `DealParticipant` row (identified by `user_id`).
 *   Attempting to set the other side's name → `auth.role_forbidden`.
 *
 * ## Why a separate service from DealService?
 *
 *   `DealService` already has well-defined responsibilities (transition engine,
 *   pure helpers). Appending 4 patch methods with non-trivial DB logic each
 *   would grow the class significantly. `DealSectionPatchService` owns the
 *   HTTP-business-logic bridge so `DealService` stays the domain engine and
 *   `DealSectionPatchService` stays the application layer.
 */

import { Injectable } from '@nestjs/common';
import type { DealParticipant, DealRoom, Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../auth';
import {
  DEAL_MATERIAL_EDIT_FIELDS,
  type AllowedAction,
  type DealRequiredField,
} from '../common/constants';
import { DealStatus, ParticipantRole } from '../common/enums';
import { DomainException } from '../common/errors';
import { assertValidDealAmount } from '../common/money';
import { PrismaService } from '../prisma';
import { computeAllowedActions } from './deal.allowed-actions';
import { computeMissingFields } from './deal.missing-fields';
import { computeTermsHash } from './deal.terms-hash';
import type { DealViewer } from './deal.allowed-actions';
import { DealService } from './deal.service';
import type { PatchDeliveryDto } from './dto/patch-delivery.dto';
import type { PatchParticipantDto } from './dto/patch-participant.dto';
import type { PatchPayoutDto } from './dto/patch-payout.dto';
import type { PatchProductDto } from './dto/patch-product.dto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Deal statuses that allow section edits (R7.1, R7.5).
 * Any other status → `deal.locked_after_payment`.
 */
const EDITABLE_STATUSES: ReadonlySet<DealStatus> = new Set([
  DealStatus.DRAFT,
  DealStatus.AWAITING_COUNTERPARTY,
  DealStatus.AWAITING_BOTH_APPROVAL,
  DealStatus.READY_FOR_PAYMENT,
]);

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

/**
 * Standard `DealRoomResponse` shape returned by every section-patch endpoint.
 * Matches design.md §"Standard `DealRoomResponse` shape".
 */
export interface DealRoomApiResponse {
  deal: DealRoom;
  missing_fields: readonly DealRequiredField[];
  allowed_actions: readonly AllowedAction[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class DealSectionPatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dealService: DealService,
  ) {}

  // ---------------------------------------------------------------------------
  // Product section
  // ---------------------------------------------------------------------------

  /**
   * Apply a partial update to the product section (R7.1).
   *
   * Material fields: `product_title`, `product_description`, `deal_amount`,
   * `currency` → invalidate approvals + revert to `AWAITING_BOTH_APPROVAL`
   * when changed (R7.3).
   *
   * Non-material: `product_type`, `quantity`, `condition` → preserve
   * approvals and status (R7.4).
   */
  async patchProduct(
    publicId: string,
    dto: PatchProductDto,
    actor: AuthenticatedUser,
  ): Promise<DealRoomApiResponse> {
    return this.prisma.runInTransaction(async (tx) => {
      const { deal, participant } = await this.loadAndAuthorise(tx, publicId, actor.id);

      // Validate deal_amount separately since it has money semantics.
      if (dto.deal_amount !== undefined) {
        try {
          assertValidDealAmount(dto.deal_amount);
        } catch {
          throw DomainException.badRequest('deal.invalid_field', {
            details: { field: 'deal_amount' },
          });
        }
      }

      // Build the Prisma update data. Only include fields that were supplied.
      const productData: Prisma.DealRoomUpdateInput = {};
      if (dto.product_title !== undefined) productData.product_title = dto.product_title;
      if (dto.product_type !== undefined) productData.product_type = dto.product_type;
      if (dto.product_description !== undefined) productData.product_description = dto.product_description;
      if (dto.quantity !== undefined) productData.quantity = dto.quantity;
      if (dto.condition !== undefined) productData.condition = dto.condition;
      if (dto.deal_amount !== undefined) productData.deal_amount = dto.deal_amount;
      if (dto.currency !== undefined) productData.currency = dto.currency as Prisma.EnumCurrencyFieldUpdateOperationsInput['set'];

      // Detect whether any material-edit field changed by comparing
      // new values against the current deal row.
      const isMaterialEdit = this.detectMaterialEdit(deal, dto);

      let updatedDeal = await tx.dealRoom.update({
        where: { id: deal.id },
        data: productData,
      });

      if (isMaterialEdit) {
        // Invalidate all active approvals for this deal (R7.3, R8.4).
        await this.invalidateApprovals(tx, deal.id);

        // Revert status to AWAITING_BOTH_APPROVAL when needed (R7.3).
        // Transition is only needed if we're not already in AWAITING_BOTH_APPROVAL.
        if (updatedDeal.status !== DealStatus.AWAITING_BOTH_APPROVAL) {
          updatedDeal = await this.dealService.transition(
            updatedDeal,
            DealStatus.AWAITING_BOTH_APPROVAL,
            { user_id: actor.id, role: participant.role },
            tx,
          );
        }
      }

      // Recompute terms hash and persist if it changed.
      updatedDeal = await this.refreshTermsHash(tx, updatedDeal);

      return this.buildResponse(updatedDeal, actor.id, participant.role);
    });
  }

  // ---------------------------------------------------------------------------
  // Participant section
  // ---------------------------------------------------------------------------

  /**
   * Apply a partial update to the participant section (R7.2).
   *
   * Ownership enforcement (R7.6): a buyer may set `buyer_name` /
   * `buyer_phone`; a seller may set `seller_name` / `seller_phone`.
   * Attempting to set the other side's name or phone →
   * `auth.role_forbidden`.
   *
   * `preferred_lang` updates the caller's own `DealParticipant` row.
   *
   * All participant fields are non-material — approvals and status are
   * preserved (R7.4).
   */
  async patchParticipant(
    publicId: string,
    dto: PatchParticipantDto,
    actor: AuthenticatedUser,
  ): Promise<DealRoomApiResponse> {
    return this.prisma.runInTransaction(async (tx) => {
      const { deal, participant } = await this.loadAndAuthorise(tx, publicId, actor.id);

      const isBuyer = participant.role === ParticipantRole.buyer;
      const isSeller = participant.role === ParticipantRole.seller;

      // R7.6 — reject attempts to edit the other side's identity fields.
      if (dto.buyer_name !== undefined && !isBuyer) {
        throw DomainException.forbidden('auth.role_forbidden');
      }
      if (dto.buyer_phone !== undefined && !isBuyer) {
        throw DomainException.forbidden('auth.role_forbidden');
      }
      if (dto.seller_name !== undefined && !isSeller) {
        throw DomainException.forbidden('auth.role_forbidden');
      }
      if (dto.seller_phone !== undefined && !isSeller) {
        throw DomainException.forbidden('auth.role_forbidden');
      }

      // Update the deal room denormalised name fields (R8.1 — buyer_name /
      // seller_name are part of the terms hash).
      const dealData: Prisma.DealRoomUpdateInput = {};
      if (dto.buyer_name !== undefined) dealData.buyer_name = dto.buyer_name;
      if (dto.seller_name !== undefined) dealData.seller_name = dto.seller_name;

      let updatedDeal = deal;
      if (Object.keys(dealData).length > 0) {
        updatedDeal = await tx.dealRoom.update({
          where: { id: deal.id },
          data: dealData,
        });
      }

      // Update per-participant fields (phone, preferred_lang) on the
      // DealParticipant row for this user.
      const participantData: Prisma.DealParticipantUpdateInput = {};
      const phone = isBuyer ? dto.buyer_phone : dto.seller_phone;
      if (phone !== undefined) participantData.phone = phone;
      if (dto.preferred_lang !== undefined) participantData.preferred_lang = dto.preferred_lang as Prisma.EnumPreferredLangFieldUpdateOperationsInput['set'];

      if (Object.keys(participantData).length > 0) {
        await tx.dealParticipant.update({
          where: { id: participant.id },
          data: participantData,
        });
      }

      // Participant-name fields (buyer_name, seller_name) ARE part of the
      // design.md terms hash (see "Inputs" section: ParticipantSection).
      // However, R7.4 states participant-owned personal fields don't trigger
      // the material-edit revert. We therefore recompute the hash (so
      // approval snapshots stay accurate) but do NOT invalidate approvals
      // or revert status.
      updatedDeal = await this.refreshTermsHash(tx, updatedDeal);

      return this.buildResponse(updatedDeal, actor.id, participant.role);
    });
  }

  // ---------------------------------------------------------------------------
  // Delivery section
  // ---------------------------------------------------------------------------

  /**
   * Apply a partial update to the delivery section (R7.1).
   *
   * Delivery fields are entirely non-material — approvals and status are
   * preserved (R7.4).
   */
  async patchDelivery(
    publicId: string,
    dto: PatchDeliveryDto,
    actor: AuthenticatedUser,
  ): Promise<DealRoomApiResponse> {
    return this.prisma.runInTransaction(async (tx) => {
      const { deal, participant } = await this.loadAndAuthorise(tx, publicId, actor.id);

      const deliveryData: Prisma.DealRoomUpdateInput = {};
      if (dto.delivery_method !== undefined) deliveryData.delivery_method = dto.delivery_method;
      if (dto.delivery_address !== undefined) deliveryData.delivery_address = dto.delivery_address;
      if (dto.delivery_note !== undefined) deliveryData.delivery_note = dto.delivery_note;

      let updatedDeal = deal;
      if (Object.keys(deliveryData).length > 0) {
        updatedDeal = await tx.dealRoom.update({
          where: { id: deal.id },
          data: deliveryData,
        });
      }

      // Delivery fields are not in the terms hash; no recomputation needed.
      // Returning without touching approvals or status (R7.4).
      return this.buildResponse(updatedDeal, actor.id, participant.role);
    });
  }

  // ---------------------------------------------------------------------------
  // Payout section (seller-only)
  // ---------------------------------------------------------------------------

  /**
   * Apply a partial update to the payout section (R7.1, R7.6).
   *
   * Only the `seller` participant may edit payout fields; any other role
   * (buyer, anonymous) → `auth.role_forbidden` (R7.6).
   *
   * Payout fields are non-material — approvals and status are preserved
   * (R7.4).
   */
  async patchPayout(
    publicId: string,
    dto: PatchPayoutDto,
    actor: AuthenticatedUser,
  ): Promise<DealRoomApiResponse> {
    return this.prisma.runInTransaction(async (tx) => {
      const { deal, participant } = await this.loadAndAuthorise(tx, publicId, actor.id);

      // R7.6 — payout section is seller-only.
      if (participant.role !== ParticipantRole.seller) {
        throw DomainException.forbidden('auth.role_forbidden');
      }

      const payoutData: Prisma.DealRoomUpdateInput = {};
      if (dto.payout_khqr !== undefined) payoutData.payout_khqr = dto.payout_khqr;
      if (dto.payout_bank_name !== undefined) payoutData.payout_bank_name = dto.payout_bank_name;
      if (dto.payout_account_name !== undefined) payoutData.payout_account_name = dto.payout_account_name;
      if (dto.payout_account_number !== undefined) payoutData.payout_account_number = dto.payout_account_number;

      let updatedDeal = deal;
      if (Object.keys(payoutData).length > 0) {
        updatedDeal = await tx.dealRoom.update({
          where: { id: deal.id },
          data: payoutData,
        });
      }

      // Payout fields are not in the terms hash; no recomputation needed.
      return this.buildResponse(updatedDeal, actor.id, participant.role);
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Load the deal by `public_id` and verify the acting user is a participant.
   *
   * Returns `{ deal, participant }` for the authorised viewer.
   *
   * @throws `DomainException.notFound('deal.not_found')` — no deal with that public_id.
   * @throws `DomainException.forbidden('auth.role_forbidden')` — caller is not a participant.
   * @throws `DomainException.badRequest('deal.locked_after_payment')` — status not editable (R7.5).
   */
  private async loadAndAuthorise(
    tx: Prisma.TransactionClient,
    publicId: string,
    userId: string,
  ): Promise<{ deal: DealRoom; participant: DealParticipant }> {
    const deal = await tx.dealRoom.findUnique({
      where: { public_id: publicId },
    });

    if (!deal) {
      throw DomainException.notFound('deal.not_found');
    }

    // R7.5 — reject edits for non-editable statuses.
    if (!EDITABLE_STATUSES.has(deal.status as DealStatus)) {
      throw DomainException.badRequest('deal.locked_after_payment');
    }

    // R7.6 — reject non-participants.
    const participant = await tx.dealParticipant.findUnique({
      where: {
        deal_id_user_id: {
          deal_id: deal.id,
          user_id: userId,
        },
      },
    });

    if (!participant) {
      throw DomainException.forbidden('auth.role_forbidden');
    }

    return { deal, participant };
  }

  /**
   * Detect whether the patch touches any material-edit fields (R7.3).
   *
   * A field is considered "changed" when the DTO supplies a non-`undefined`
   * value that differs from the current deal row. This avoids spurious
   * approval resets when a client re-POSTs the same value.
   *
   * Note: `deal_amount` comparison is string-based after normalisation
   * since both sides may use different decimal representations.
   */
  private detectMaterialEdit(deal: DealRoom, dto: PatchProductDto): boolean {
    for (const field of DEAL_MATERIAL_EDIT_FIELDS) {
      const dtoValue = (dto as Record<string, unknown>)[field];
      if (dtoValue === undefined) continue;

      const currentValue = (deal as Record<string, unknown>)[field];

      // For deal_amount, compare normalised decimal strings.
      if (field === 'deal_amount') {
        const normalised = String(dtoValue);
        const currentStr = currentValue == null ? null : String(currentValue);
        if (normalised !== currentStr) return true;
      } else {
        if (String(dtoValue) !== String(currentValue ?? '')) return true;
      }
    }
    return false;
  }

  /**
   * Invalidate all non-invalidated approvals for a deal in the same
   * transaction (R7.3, R8.4).
   *
   * Sets `invalidated_at = now()` so the active-approval predicate
   * (`invalidated_at IS NULL AND terms_hash = deal.terms_hash`) flips
   * to `false` for all stale rows. Does not delete rows — the audit
   * trail is preserved.
   */
  private async invalidateApprovals(
    tx: Prisma.TransactionClient,
    dealId: string,
  ): Promise<void> {
    await tx.approval.updateMany({
      where: {
        deal_id: dealId,
        invalidated_at: null,
      },
      data: {
        invalidated_at: new Date(),
      },
    });
  }

  /**
   * Recompute the terms hash after a section update and persist it if it
   * changed (task 5.3, R8.1).
   *
   * Returns the (potentially updated) deal row so callers can chain further
   * writes without a second DB read.
   */
  private async refreshTermsHash(
    tx: Prisma.TransactionClient,
    deal: DealRoom,
  ): Promise<DealRoom> {
    const newHash = computeTermsHash(deal);
    if (newHash === deal.terms_hash) return deal;

    return tx.dealRoom.update({
      where: { id: deal.id },
      data: { terms_hash: newHash },
    });
  }

  /**
   * Build the standard `DealRoomApiResponse` shape (design §"Standard
   * `DealRoomResponse` shape"; R6.2, R6.3).
   *
   * `missing_fields` is computed from the current deal row.
   * `allowed_actions` is viewer-scoped (role of the acting participant).
   */
  private buildResponse(
    deal: DealRoom,
    userId: string,
    role: ParticipantRole,
  ): DealRoomApiResponse {
    const viewer: DealViewer = {
      user_id: userId,
      role,
    };

    return {
      deal,
      missing_fields: computeMissingFields(deal),
      allowed_actions: computeAllowedActions(deal, viewer),
    };
  }
}
