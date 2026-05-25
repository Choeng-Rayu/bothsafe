// task 5.5
/**
 * Pure `computeAllowedActions(deal, viewer)` — the viewer-scoped action
 * calculator that backs `DealService.computeAllowedActions` (task 5.5).
 *
 * Why a standalone module?
 *   The function has no I/O, no DB calls, no NestJS decorators, and no
 *   service dependencies — it is a pure projection of a `DealRoom` row
 *   plus a viewer descriptor onto the canonical `AllowedAction` set.
 *   Keeping it outside the service class makes it trivially unit-testable
 *   (see `deal.allowed-actions.spec.ts`) and lets
 *   `DealService.computeAllowedActions` collapse to a one-line delegate.
 *
 * Source of truth:
 *   - `requirements.md` R6.3 — `pay_*` and `submit_khqr_receipt` are
 *     omitted while `missing_fields` is non-empty (the state machine
 *     prevents `READY_FOR_PAYMENT` whenever fields are missing, so this
 *     function does not re-check `missing_fields` itself).
 *   - `requirements.md` R9.1, R12.1, R13.1, R17.1 — role gating for
 *     `pay_from_wallet` / `submit_shipping_proof` / `confirm_received` /
 *     `open_dispute`.
 *   - `requirements.md` R7.3 — material edits are still allowed at
 *     `READY_FOR_PAYMENT`; the revert path back to
 *     `AWAITING_BOTH_APPROVAL` is what enforces re-approval.
 *   - `design.md` §"Standard `DealRoomResponse` shape" — defines the
 *     `AllowedAction` union and notes the list is viewer-scoped.
 *   - `src/common/constants.ts` `ALLOWED_ACTIONS` — the canonical
 *     ordered enum. Returned arrays preserve this order.
 *
 * Caller responsibilities:
 *   - Resolve the viewer's role from the session / access token before
 *     calling. A non-participant who somehow reaches this function MUST
 *     be passed with `role: null` so they receive `[]`.
 *   - Compute `hasApproved` from the latest non-invalidated `Approval`
 *     row whose `terms_hash` matches `DealRoom.terms_hash` (R8.3, R8.4).
 *     `undefined` is treated as "not yet approved" so the call site can
 *     omit it for statuses where approval is irrelevant.
 *   - Wallet balance, currency match, and KHQR generator availability
 *     are NOT checked here — those gates live in `WalletService` /
 *     `KhqrGenerator` and surface as request-time errors. The frontend
 *     still renders `pay_from_wallet` and falls back to
 *     `wallet.insufficient_balance` (R9.3) when the user clicks.
 */

import type { AllowedAction } from '../common/constants';
import { DealStatus, ParticipantRole } from '../common/enums';

/**
 * Minimal structural shape this function depends on. Accepts the Prisma
 * `DealRoom` row directly; only `status` is read. Other columns are
 * ignored so that a caller building a synthetic deal for tests does not
 * have to populate the entire model.
 *
 * Aliased as {@link DealRoomLike} per the task 5.5 prompt; both names
 * resolve to the same shape.
 */
export interface DealAllowedActionsInput {
  status: DealStatus;
}

/** Alias matching the task 5.5 prompt's preferred name. */
export type DealRoomLike = DealAllowedActionsInput;

/**
 * The "who is viewing this deal" descriptor.
 *
 * `user_id` is the authenticated `User.id` (cuid v2) of the viewer, or
 * `null` for anonymous viewers (e.g., someone landing on the deal page
 * via the public invite link before signing in). It is reserved for
 * future per-user gates (creator-only edits, owner-only attachments)
 * — at this layer the only branching it drives is the
 * "anonymous → return `[]`" short-circuit alongside `role === null`.
 *
 * `role` is the role the viewer is acting **in** for this deal:
 *   - `'buyer'` / `'seller'` — the matching `DealParticipant` row.
 *   - `'admin'` — a privileged operator viewing the deal. Admin actions
 *     are exposed via separate admin endpoints (verify payment, resolve
 *     dispute, approve withdrawal); this function therefore returns
 *     `[]` for admins to keep the participant action surface clean and
 *     prevent admin-only actions from leaking into the participant UI.
 *   - `null` — anonymous / unauthenticated viewer (e.g., the invite
 *     preview path before the counterparty has signed in). Always `[]`.
 *
 * `hasApproved` gates the `approve` action while the deal is in
 * `AWAITING_BOTH_APPROVAL` (R8.7 — re-approval of the same terms hash
 * is idempotent, so the UI hides the button once the active approval
 * is recorded). `undefined` is treated as "not yet approved".
 */
export interface DealViewer {
  user_id: string | null;
  role: ParticipantRole | null;
  hasApproved?: boolean;
}

/**
 * Returns the subset of `ALLOWED_ACTIONS` the supplied viewer may
 * trigger against the supplied deal, in canonical declaration order.
 *
 * Returns `[]` for:
 *   - anonymous viewers (`viewer.role === null`),
 *   - admin viewers (`viewer.role === 'admin'`) — admin actions live in
 *     dedicated admin endpoints and are not part of the participant
 *     action surface,
 *   - terminal statuses (`RELEASED`, `REFUNDED`, `CANCELLED`,
 *     `EXPIRED`),
 *   - in-flight auto-release / pre-resolution statuses
 *     (`BUYER_CONFIRMED`, `RELEASE_PENDING`, `DISPUTED`).
 *
 * @example
 *   computeAllowedActions(
 *     { status: DealStatus.AWAITING_BOTH_APPROVAL },
 *     { role: 'buyer' },
 *   );
 *   // ['edit_product', 'edit_participant', 'approve']
 *
 *   computeAllowedActions(
 *     { status: DealStatus.READY_FOR_PAYMENT },
 *     { role: 'seller' },
 *   );
 *   // ['edit_product', 'edit_participant']
 *
 *   computeAllowedActions(
 *     { status: DealStatus.SHIPPED },
 *     { role: 'buyer' },
 *   );
 *   // ['confirm_received', 'open_dispute']
 */
export function computeAllowedActions(
  deal: DealAllowedActionsInput,
  viewer: DealViewer,
): readonly AllowedAction[] {
  // Anonymous and admin viewers receive no participant actions.
  // Admin escalation paths surface only through dedicated admin
  // endpoints (admin.guard + /v1/admin/...), so we deliberately do not
  // surface admin-only actions in this list.
  if (viewer.role === null || viewer.role === ParticipantRole.admin) {
    return [];
  }

  const isBuyer = viewer.role === ParticipantRole.buyer;
  const isSeller = viewer.role === ParticipantRole.seller;
  const isParticipant = isBuyer || isSeller;

  switch (deal.status) {
    // -------------------------------------------------------------------
    // Pre-counterparty: only the creator can edit; nobody can approve
    // until the counterparty has joined (which transitions to
    // AWAITING_BOTH_APPROVAL).
    //
    // The caller is responsible for ensuring `viewer.role` reflects the
    // creator-side participant. A non-participant who reaches this
    // branch with a role attached would receive edit actions, but the
    // PATCH endpoints themselves re-check participant membership
    // (auth.role_forbidden, R7.6) so this is defence-in-depth, not a
    // security gate.
    // -------------------------------------------------------------------
    case DealStatus.DRAFT:
    case DealStatus.AWAITING_COUNTERPARTY:
      return isParticipant ? ['edit_product', 'edit_participant'] : [];

    // -------------------------------------------------------------------
    // Both sides exist; both can edit and (if not yet) approve. R8.7
    // makes re-approval of the same terms hash idempotent, so we hide
    // the button once `hasApproved` is true to keep the UI honest.
    // -------------------------------------------------------------------
    case DealStatus.AWAITING_BOTH_APPROVAL: {
      const actions: AllowedAction[] = ['edit_product', 'edit_participant'];
      if (!viewer.hasApproved) {
        actions.push('approve');
      }
      return actions;
    }

    // -------------------------------------------------------------------
    // READY_FOR_PAYMENT — both sides can still edit (R7.3 revert path:
    // a material edit clears approvals and reverts to
    // AWAITING_BOTH_APPROVAL). Only the buyer sees the payment actions
    // (R9.1, R10.1).
    //
    // Wallet-balance and currency-match gates are deliberately NOT
    // applied here — `pay_from_wallet` is rendered unconditionally for
    // the buyer and the WalletService surfaces `wallet.insufficient_balance`
    // / `wallet.currency_mismatch` at click time (R9.3, R9.6) with
    // actionable copy.
    // -------------------------------------------------------------------
    case DealStatus.READY_FOR_PAYMENT: {
      const actions: AllowedAction[] = ['edit_product', 'edit_participant'];
      if (isBuyer) {
        actions.push('pay_from_wallet', 'pay_khqr');
      }
      return actions;
    }

    // -------------------------------------------------------------------
    // PAYMENT_PENDING_VERIFICATION — buyer can keep refining the receipt
    // (re-upload attachment, correct paid_amount). Admin verify / reject
    // is exposed through /v1/admin/payment-proofs/:id/{verify,reject}
    // and is intentionally absent from this list (the prompt: "Admin
    // verify is its own admin action — not in this list").
    // -------------------------------------------------------------------
    case DealStatus.PAYMENT_PENDING_VERIFICATION:
      return isBuyer ? ['submit_khqr_receipt'] : [];

    // -------------------------------------------------------------------
    // PAID_ESCROWED / SELLER_PREPARING — seller ships, both sides can
    // open a dispute. PAID_ESCROWED is normally observable only inside
    // the wallet-payment / verify transaction (it transitions through
    // to SELLER_PREPARING in the same tx, R9.7 / R11.8); listing it
    // explicitly is defence-in-depth against rare states where the
    // follow-up transition has not landed yet (R20.4 rollback).
    // -------------------------------------------------------------------
    case DealStatus.PAID_ESCROWED:
    case DealStatus.SELLER_PREPARING: {
      const actions: AllowedAction[] = [];
      if (isSeller) actions.push('submit_shipping_proof');
      // Both sides may open a dispute (R17.1).
      actions.push('open_dispute');
      return actions;
    }

    // -------------------------------------------------------------------
    // SHIPPED — buyer confirms receipt to trigger auto-release; both
    // can dispute (e.g., wrong/damaged item).
    // -------------------------------------------------------------------
    case DealStatus.SHIPPED: {
      const actions: AllowedAction[] = [];
      if (isBuyer) actions.push('confirm_received');
      actions.push('open_dispute');
      return actions;
    }

    // -------------------------------------------------------------------
    // BUYER_CONFIRMED / RELEASE_PENDING — auto-release is in flight; no
    // participant actions. (`BUYER_CONFIRMED` is preserved in the enum
    // for backward compatibility — buyer confirmation moves directly
    // through RELEASE_PENDING in normal operation; design §"Deal
    // Status state machine".)
    //
    // DISPUTED — admin-only resolution; see /v1/admin/deals/:id/{release,refund}.
    //
    // Terminal statuses — empty by definition.
    // -------------------------------------------------------------------
    case DealStatus.BUYER_CONFIRMED:
    case DealStatus.RELEASE_PENDING:
    case DealStatus.DISPUTED:
    case DealStatus.RELEASED:
    case DealStatus.REFUNDED:
    case DealStatus.CANCELLED:
    case DealStatus.EXPIRED:
      return [];
  }
}
