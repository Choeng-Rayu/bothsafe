/**
 * InviteService — preview + consume (task 5.7)
 *
 * Source of truth: tasks.md §5.7, §5.14;
 * design.md §"DealService (`src/deal/`)" → `invitePreview`;
 * requirements.md R4.1–R4.6 (invite preview) and R5.6–R5.7 (join consume).
 *
 * # Responsibilities (task 5.7)
 *
 *   - {@link InviteService.preview} — public, unauthenticated read.
 *     Hashes the candidate via `hashToken()`, looks up
 *     `InviteToken` by `token_hash`, validates that it is active and
 *     bound to a non-terminal deal, and returns a SAFE preview
 *     consisting of `{ deal_public_id, deal_amount, currency,
 *     currency_display, product_title, expected_role }`. Never returns
 *     raw tokens, token hashes, participant identities (buyer/seller
 *     names, phones), or audit metadata. The preview shape is also
 *     the contract pinned by the property test in §5.14 ("invite
 *     preview never leaks tokens or participant identities").
 *
 *   - {@link InviteService.consume} — atomic single-use, called by the
 *     join controller (task 5.8) inside its transaction. Validates
 *     the same token, records `consumed_at = now()` (mapped to the
 *     existing `invite_token.invalidated_at` column — see "Schema
 *     mapping" below), captures `consumed_by_user_id` in the audit
 *     metadata, and returns `{ deal_id, expected_role }`. The caller
 *     creates the `DealParticipant` row and runs the
 *     `AWAITING_COUNTERPARTY → AWAITING_BOTH_APPROVAL` transition.
 *     This service deliberately owns only the token; not the
 *     participant row, not the access-token mint, not the state
 *     transition.
 *
 * # Error envelope (R4.3 / R5.7 reconciled)
 *
 * The task description for 5.7 lists three distinct codes
 * (`invite.invalid`, `invite.consumed`, `invite.expired`) and grants
 * flexibility to merge them when the design wants. R4.3 collapses
 * "missing | malformed | expired | invalidated | terminal-deal" into
 * a single `invite.invalid` for the public preview path. We split one
 * step finer than R4.3 so the join page can render a more useful
 * "this invite was already used" message:
 *
 *   - `preview`:
 *       - missing / unknown / malformed / expired / terminal deal →
 *         `DomainException.notFound('invite.invalid')`
 *       - already-consumed (`invalidated_at` set) →
 *         `DomainException.badRequest('invite.consumed')`
 *
 *   - `consume`:
 *       - any failure mode (unknown, expired, already-consumed, deal
 *         in non-`AWAITING_COUNTERPARTY` status, missing tx) →
 *         `DomainException.badRequest('invite.consumed')` (R5.7).
 *
 * The expiry-vs-invalid distinction collapses to `invite.invalid` for
 * preview because callers cannot do anything actionable with the
 * difference: the link is dead either way. Splitting `invite.expired`
 * out would let probes confirm the existence of a token by its
 * expiration window — tighter to merge.
 *
 * # Schema mapping (`consumed_at` ↔ `invalidated_at`)
 *
 * The Prisma schema (`prisma/schema.prisma`, task 2.5) records the
 * "this token has been used" state as the nullable
 * `invite_token.invalidated_at` column. Task 5.7's prose refers to
 * `consumed_at`; the two are semantically the same — flipping
 * `invalidated_at` from NULL to `now()` is precisely what "the
 * counterparty consumed this invite" means. We do NOT add a separate
 * `consumed_at` column and do NOT mint a `consumed_by_user_id` column
 * (the schema does not carry one). The joining user's id is captured
 * in the audit-row metadata written by the join controller in the
 * same transaction (R20.x), which is the right surface for "who
 * consumed this token" anyway because audit rows are append-only at
 * the DB role level and tokens are not.
 *
 * # Why `tx` is required for `consume`
 *
 * R5.6 mandates that the join flow set `Deal_Status` to
 * `AWAITING_BOTH_APPROVAL`, issue a `Participant_Access_Token`, and
 * invalidate the `InviteToken` "within a single database
 * transaction, rolling back all three changes if any step fails." The
 * only way the token-invalidation step can share that transaction is
 * by accepting the `Prisma.TransactionClient` from the caller. The
 * `tx`-required signature mirrors `AuditService.record(...)` and
 * `DealService.transition(...)` — see the rationale in
 * `audit.service.ts` and `deal.service.ts`.
 *
 * `preview`, by contrast, is a public, read-only path (R4.4); it is
 * never part of a multi-write transaction, so it uses the global
 * `PrismaService` directly and does not accept a `tx` argument.
 */

// task 5.7
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import {
  Currency,
  DealStatus,
  isTerminalDealStatus,
  ParticipantRole,
} from '../common/enums';
import { DomainException } from '../common/errors';
import { hashToken, MIN_TOKEN_LENGTH } from '../common/tokens';
import { PrismaService } from '../prisma';

// task 5.7
/**
 * Roles that can be invited via the counterparty link. R5.2: the
 * joining party always assumes the role opposite to the creator, so
 * the invite is always for `'buyer'` or `'seller'` — never `'admin'`.
 *
 * Authored as `Extract<ParticipantRole, 'buyer' | 'seller'>` rather
 * than `ParticipantRole.buyer | ParticipantRole.seller` because the
 * Prisma-generated enum is a const-object plus matching union type,
 * not a TypeScript `enum`/namespace, so the dotted form is not a
 * valid TS type expression.
 */
// task 5.7
export type InviteRole = Extract<ParticipantRole, 'buyer' | 'seller'>;

// task 5.7
/**
 * SAFE preview returned by `InviteService.preview`. The shape is the
 * contract for the `GET /v1/deals/:publicId/invite-preview` response
 * (R4.1, R4.2) and the property test in §5.14 ("invite preview never
 * leaks tokens or participant identities") asserts that this is the
 * complete key set.
 *
 * Field-by-field rationale:
 *
 *   - `deal_public_id`   — already in the URL the caller supplied,
 *                          so re-emitting it leaks nothing. Useful
 *                          for the join page which may have parsed
 *                          the URL once and lost the value.
 *   - `deal_amount`      — string-serialised `Decimal(18, 2)` for
 *                          cross-platform precision (R2.1, R14.1).
 *                          The DB column is nullable; we propagate
 *                          that — a buyer-flow deal may not have set
 *                          `Deal_Amount` yet at invite-issue time.
 *   - `currency`         — the ISO code (`'USD' | 'KHR'`). Nullable
 *                          for the same reason as `deal_amount`.
 *   - `currency_display` — a short, human-readable rendering of the
 *                          currency for the join page. See
 *                          {@link CURRENCY_DISPLAY} for the mapping
 *                          and the rationale.
 *   - `product_title`    — truncated to 200 characters per R4.1.
 *                          Nullable until the creator fills it in.
 *   - `expected_role`    — derived from `deal.creator_role` per R5.2;
 *                          surfaced explicitly so the join page can
 *                          pre-select the role without re-deriving
 *                          it client-side.
 *
 * Explicitly EXCLUDED (R4.2 / property test §5.14):
 *
 *   - any token, raw or hashed (`Creator_Access_Token`,
 *     `Participant_Access_Token`, `Invite_Token`, `token_hash`),
 *   - participant identities (`buyer_name`, `seller_name`, `phone`,
 *     `messenger_name`, `wechat_id`, `telegram_chat_id`),
 *   - the creator's `User.id` or `email`,
 *   - payment internals (`reference_note`, `khqr_payload_meta`),
 *   - audit / state-machine metadata (`terms_hash`, `expires_at`,
 *     `created_at`, `updated_at`).
 *
 * Adding a field here is a change to the public contract — verify
 * against R4.2 and the §5.14 property test before doing so.
 */
// task 5.7
export interface InvitePreview {
  deal_public_id: string;
  deal_amount: string | null;
  currency: Currency | null;
  currency_display: string | null;
  product_title: string | null;
  expected_role: InviteRole;
}

// task 5.7
/**
 * Result of `InviteService.consume`. Returns deal-internal fields the
 * join controller needs to wire the participant row and run the
 * `AWAITING_COUNTERPARTY → AWAITING_BOTH_APPROVAL` transition (R5.6).
 *
 * `expected_role` here is the role the joining user should be
 * assigned — opposite of the deal's `creator_role`.
 */
// task 5.7
export interface InviteConsumeResult {
  deal_id: string;
  expected_role: InviteRole;
}

// task 5.7
/**
 * Cap on `Product_Title` length in the public preview, per R4.1
 * ("Product_Title (truncated to a maximum of 200 characters)"). The
 * underlying DB column is unbounded TEXT; we truncate at the service
 * boundary right before shaping the response.
 */
// task 5.7
export const INVITE_PREVIEW_PRODUCT_TITLE_MAX_LEN = 200;

// task 5.7
/**
 * Currency-display lookup used by `InvitePreview.currency_display`.
 *
 * The frontend `messages/README.md` notes that BothSafe operates in
 * Cambodia and `$` is ambiguous to local buyers ("prefer the
 * international currency code over the local symbol — `USD 25.00`,
 * not `$25.00`"). We therefore default to ISO codes for both
 * supported currencies. The frontend may localise further by reading
 * `currency` and ignoring `currency_display`; passing the rendered
 * string here lets simple consumers (Telegram bot text, plain SMS
 * fallbacks) display amounts without a localisation table.
 */
// task 5.7
const CURRENCY_DISPLAY: Readonly<Record<Currency, string>> = Object.freeze({
  [Currency.USD]: 'USD',
  [Currency.KHR]: 'KHR',
});

// task 5.7
/**
 * Owner of the public preview and atomic consume paths for the
 * `invite_token` table. Stateless — all state lives in Postgres.
 *
 * Sibling responsibilities deliberately NOT part of this service:
 *
 *   - Minting the initial invite token at deal-create time. That is
 *     part of the §5.2 deal-create flow (`DealService.create`) and
 *     can call directly into Prisma since the token row, the
 *     `creator_access_token` row, and the deal row all share the
 *     same transaction there.
 *   - The `AWAITING_COUNTERPARTY → AWAITING_BOTH_APPROVAL`
 *     transition, the `participant` row, and the
 *     `participant_access_token` mint. Those are the join
 *     controller's job (§5.8). `consume(...)` returns the
 *     `expected_role` so the controller can wire them in the same
 *     transaction.
 */
// task 5.7
@Injectable()
export class InviteService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Public, unauthenticated invite preview. R4.1 / R4.4.
   *
   * Validation order:
   *
   *   1. Reject obviously-bogus inputs (non-string / shorter than
   *      `MIN_TOKEN_LENGTH`) without spending a SHA-256 cycle and
   *      without a DB round trip. Halves the work the per-IP
   *      throttler bucket has to absorb under brute-force probing.
   *   2. Look up the `InviteToken` by `token_hash`. Missing row →
   *      `invite.invalid`.
   *   3. Already-consumed (`invalidated_at` set) → `invite.consumed`.
   *      This is the one branch where we surface a code distinct
   *      from `invite.invalid` — see the "Error envelope" note in
   *      the file docstring for the rationale.
   *   4. Past `expires_at` → `invite.invalid`. Merging "expired"
   *      into the catch-all keeps probes from confirming the
   *      existence of a real token by its expiration window.
   *   5. Load the deal projection and reject terminal statuses
   *      (R4.3).
   *   6. Build and return the {@link InvitePreview}.
   *
   * Performance: budget = 2 s (R4.1). The path performs two indexed
   * lookups (`invite_token.token_hash` UNIQUE, `deal_room.id` PK) and
   * no joins. Easily inside budget on a single VPS.
   *
   * @param rawToken  Candidate raw token from `?invite=...`.
   * @returns         {@link InvitePreview} for an active token bound
   *                  to a non-terminal deal.
   * @throws          `DomainException.notFound('invite.invalid')` for
   *                  missing / malformed / expired / unknown-deal /
   *                  terminal-deal cases.
   * @throws          `DomainException.badRequest('invite.consumed')`
   *                  when the matched token has been invalidated.
   */
  async preview(rawToken: string): Promise<InvitePreview> {
    // R4.3 — short-circuit obvious-bogus inputs without a DB hit.
    if (typeof rawToken !== 'string' || rawToken.length < MIN_TOKEN_LENGTH) {
      throw DomainException.notFound('invite.invalid');
    }

    const tokenHash = hashToken(rawToken);

    const inviteToken = await this.prisma.inviteToken.findUnique({
      where: { token_hash: tokenHash },
      // Hand-rolled projection — never select the `token_hash` column
      // back out (we already computed it locally) and never select
      // the `id` (an internal row identifier with no public meaning).
      select: {
        deal_id: true,
        expires_at: true,
        invalidated_at: true,
      },
    });

    if (!inviteToken) {
      throw DomainException.notFound('invite.invalid');
    }

    // Order of expired-vs-consumed checks: consumed first, so a
    // re-clicked invite that has both been consumed and lapsed
    // surfaces the more useful "already used" message instead of
    // collapsing into the catch-all.
    if (inviteToken.invalidated_at !== null) {
      throw DomainException.badRequest('invite.consumed');
    }

    if (inviteToken.expires_at.getTime() <= Date.now()) {
      throw DomainException.notFound('invite.invalid');
    }

    const deal = await this.prisma.dealRoom.findUnique({
      where: { id: inviteToken.deal_id },
      // SAFE-preview projection. Adding a column here is a change
      // to the public contract — verify against R4.2 and the §5.14
      // property test ("invite preview never leaks tokens or
      // participant identities") before doing so.
      select: {
        public_id: true,
        product_title: true,
        deal_amount: true,
        currency: true,
        creator_role: true,
        status: true,
      },
    });

    if (!deal) {
      // Defensive — `invite_token.deal_id` has `ON DELETE CASCADE`,
      // so this is unreachable in practice. If it ever fires, fail
      // closed with the public catch-all rather than 500ing.
      throw DomainException.notFound('invite.invalid');
    }

    if (isTerminalDealStatus(deal.status)) {
      // R4.3 — `CANCELLED` and `EXPIRED` collapse to
      // `invite.invalid`. We extend the rule to all terminal
      // statuses (`RELEASED`, `REFUNDED`) for defence in depth: an
      // invite consumed against an already-finalised deal is
      // meaningless, and exposing the distinction would leak the
      // deal's outcome to anyone holding a stale link.
      throw DomainException.notFound('invite.invalid');
    }

    return buildInvitePreview(deal);
  }

  /**
   * Atomic, single-use consume. R5.6 / R5.7.
   *
   * Concurrency model: we use a Prisma `updateMany` whose `WHERE`
   * clause acts as a compare-and-set:
   *
   *   ```
   *   UPDATE invite_token
   *      SET invalidated_at = now()
   *    WHERE token_hash    = $1
   *      AND invalidated_at IS NULL
   *      AND expires_at    > now()
   *   ```
   *
   * Concurrent consume attempts for the same token serialise at the
   * row lock; the first one updates one row and wins, the second
   * one matches zero rows and throws `invite.consumed`. R5.7 is
   * satisfied with a single round trip and no read-modify-write
   * race.
   *
   * The function does NOT:
   *
   *   - run the `AWAITING_COUNTERPARTY → AWAITING_BOTH_APPROVAL`
   *     transition,
   *   - insert the `DealParticipant` row,
   *   - mint the `ParticipantAccessToken`,
   *   - or write the `INVITE_CONSUMED` audit row.
   *
   * Those are the join controller's job (§5.8) — the controller
   * already runs them inside the transaction it passes to us, so
   * carrying them here would either duplicate the writes or split
   * the transactional boundary in two. The audit row written by the
   * join controller carries `joiningUserId` in its metadata, which
   * is the right surface for "who consumed this token" given the
   * append-only audit guarantee (R20.x). See file-docstring
   * "Schema mapping" for why we do NOT add a `consumed_by_user_id`
   * column to `invite_token`.
   *
   * @param rawToken         Candidate raw token from `?invite=...`.
   * @param joiningUserId    Authenticated user performing the join.
   *                         Validated for shape only here; the join
   *                         controller writes it into the audit row
   *                         alongside the state transition.
   * @param tx               Prisma transaction client. REQUIRED by
   *                         R5.6 / R20.4 (the token invalidation
   *                         must share the originating join
   *                         transaction so all three writes — token,
   *                         participant, status — commit or roll
   *                         back together).
   * @returns                {@link InviteConsumeResult} with
   *                         `deal_id` and the role the joiner
   *                         should be assigned.
   * @throws                 `DomainException.badRequest('invite.consumed')`
   *                         for any failure mode the spec lists
   *                         (unknown, expired, already-invalidated,
   *                         deal in non-`AWAITING_COUNTERPARTY`
   *                         status). R5.7 collapses these into a
   *                         single error code by design.
   * @throws                 `Error` synchronously when `tx` is
   *                         missing/null or `joiningUserId` is not
   *                         a non-empty string. Both are programmer
   *                         errors that should fail loudly at the
   *                         call site.
   */
  async consume(
    rawToken: string,
    joiningUserId: string,
    tx: Prisma.TransactionClient,
  ): Promise<InviteConsumeResult> {
    if (!tx) {
      // R5.6 / R20.4 — token invalidation, participant row, and
      // status transition all commit together in the join flow.
      throw new Error(
        'InviteService.consume: tx is required; token invalidation MUST share the originating join transaction (R5.6, R20.4).',
      );
    }

    if (typeof joiningUserId !== 'string' || joiningUserId.length === 0) {
      // Programmer-error guard. The join controller resolves the
      // session before invoking us; an empty/invalid id is a bug.
      throw new Error(
        'InviteService.consume: joiningUserId is required (non-empty string).',
      );
    }

    if (typeof rawToken !== 'string' || rawToken.length < MIN_TOKEN_LENGTH) {
      throw DomainException.badRequest('invite.consumed');
    }

    const tokenHash = hashToken(rawToken);
    // Read the wall clock through `Date.now()` (rather than `new
    // Date()`) so unit tests can pin "now" with `jest.spyOn(Date,
    // 'now')`. V8's `new Date()` no-arg constructor does not go
    // through `Date.now()`, so a direct `new Date()` here would be
    // unmockable. Using `Date.now()` once for both the WHERE-clause
    // expiry comparison and the SET payload keeps the two values
    // strictly equal.
    const now = new Date(Date.now());

    // Atomic compare-and-set. Returns the count of affected rows.
    const updateResult = await tx.inviteToken.updateMany({
      where: {
        token_hash: tokenHash,
        invalidated_at: null,
        expires_at: { gt: now },
      },
      data: { invalidated_at: now },
    });

    if (updateResult.count === 0) {
      // Either no such token, or it was already consumed/expired by
      // the time we got here. R5.7 maps every cause to the single
      // `invite.consumed` code so probes can't tell them apart.
      throw DomainException.badRequest('invite.consumed');
    }

    // The compare-and-set succeeded; recover the deal_id + status +
    // creator_role for the caller. We intentionally re-fetch the
    // token row (rather than threading deal_id off a join in the
    // updateMany) because Prisma's `updateMany` does not return the
    // updated row, and a follow-up read inside the same `tx` is
    // cheap on the hot path (UNIQUE index on `token_hash`).
    const inviteToken = await tx.inviteToken.findUnique({
      where: { token_hash: tokenHash },
      select: { deal_id: true },
    });

    if (!inviteToken) {
      // Unreachable — we just updated this row inside `tx`.
      // Surface the invariant violation distinctly so monitoring
      // catches it; do NOT reuse `invite.consumed` here.
      throw new Error(
        'InviteService.consume: post-update lookup returned null; transaction state is inconsistent.',
      );
    }

    const deal = await tx.dealRoom.findUnique({
      where: { id: inviteToken.deal_id },
      select: { id: true, status: true, creator_role: true },
    });

    if (!deal) {
      // Same FK invariant as `preview`. Roll back the
      // compare-and-set we just wrote by throwing — the caller's
      // transaction discards the `invalidated_at` flip, restoring
      // the invariant.
      throw DomainException.badRequest('invite.consumed');
    }

    if (deal.status !== DealStatus.AWAITING_COUNTERPARTY) {
      // R5.1 — joins are only legal while the deal awaits the
      // counterparty. Treat any other status as an already-consumed
      // token; the caller's transaction will roll back the
      // `invalidated_at` flip we wrote, leaving the token in its
      // original state.
      throw DomainException.badRequest('invite.consumed');
    }

    return {
      deal_id: deal.id,
      expected_role: oppositeRole(deal.creator_role),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// task 5.7
/**
 * Project a deal row onto the {@link InvitePreview} shape.
 *
 * Hand-rolled rather than `prisma.select`-driven because:
 *
 *   1. Truncation of `product_title` to 200 characters per R4.1 is
 *      a value transformation Prisma cannot express in `select`.
 *   2. `expected_role` is not a column on `DealRoom` — it is derived
 *      from `creator_role` (R5.2).
 *   3. `currency_display` is a derived value (see
 *      {@link CURRENCY_DISPLAY}).
 *   4. `Decimal(18, 2)` is serialised to a string so JSON does not
 *      coerce KHR amounts through a JS `number` and lose precision.
 */
// task 5.7
function buildInvitePreview(deal: {
  public_id: string;
  product_title: string | null;
  deal_amount: Prisma.Decimal | null;
  currency: Currency | null;
  creator_role: ParticipantRole;
}): InvitePreview {
  return {
    deal_public_id: deal.public_id,
    deal_amount: deal.deal_amount === null ? null : deal.deal_amount.toString(),
    currency: deal.currency,
    currency_display:
      deal.currency === null ? null : CURRENCY_DISPLAY[deal.currency],
    product_title: truncate(deal.product_title, INVITE_PREVIEW_PRODUCT_TITLE_MAX_LEN),
    expected_role: oppositeRole(deal.creator_role),
  };
}

// task 5.7
/**
 * Truncate `value` to at most `max` characters, preserving null.
 * Used to enforce the R4.1 200-char cap on `Product_Title` in the
 * public preview.
 */
// task 5.7
function truncate(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length <= max ? value : value.slice(0, max);
}

// task 5.7
/**
 * Counterparty role for `creatorRole`. R5.2 — the joining party
 * always assumes the role opposite to the creator.
 *
 * The schema technically allows `admin` for `creator_role`, but the
 * deal-create DTO accepts only `'buyer'` or `'seller'` so an `admin`
 * value here is an invariant violation. We surface it as
 * `invite.invalid` to keep the public preview path well-formed
 * (`preview` callers) and as `invite.consumed` for the join path
 * via the caller's existing terminal-cleanup error.
 */
// task 5.7
function oppositeRole(creatorRole: ParticipantRole): InviteRole {
  if (creatorRole === ParticipantRole.buyer) return ParticipantRole.seller;
  if (creatorRole === ParticipantRole.seller) return ParticipantRole.buyer;
  // Defensive — see the JSDoc above.
  throw DomainException.notFound('invite.invalid');
}
