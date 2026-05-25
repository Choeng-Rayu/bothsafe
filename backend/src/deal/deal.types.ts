/**
 * Shared type helpers for the Deal module.
 *
 * Source of truth: design §"DealService (`src/deal/`)"; tasks.md §5.1.
 *
 * The Deal module is split across several sibling tasks (5.1 transition
 * engine, 5.3 terms hash, 5.4 missing fields, 5.5 allowed actions, 5.6
 * section patches, ...). To keep the public surface coherent across
 * those parallel implementations, every method that needs to know "who
 * is performing this action" takes the same `DealActor` shape rather
 * than the full Prisma `User` row.
 *
 * Why a separate type instead of `User`?
 *   - The transition engine only needs the `(user_id, role)` tuple to
 *     write the audit row — it deliberately does not consult the rest
 *     of the user record. Constraining the input to that tuple makes
 *     it ergonomic for callers (admins, system jobs, bot adapters)
 *     that may not have a full `User` row in hand.
 *   - It keeps the function signature stable as we add admin actions
 *     and system-initiated transitions in later tasks; we extend
 *     `DealActor` here rather than churning the call site.
 *
 * Pure module — no runtime exports, no NestJS or Prisma side effects.
 */

import type { ParticipantRole } from '@prisma/client';

/**
 * The minimal "who is doing this" payload accepted by Deal-module
 * mutators (`DealService.transition`, future approval / patch / join
 * helpers).
 *
 * `user_id` is the authenticated `User.id` (cuid v2). `role` is the
 * role that user is acting **in** for this deal — typically the role
 * recorded on the matching `DealParticipant` row, but admins acting on
 * a deal pass `ParticipantRole.admin` so the audit row reflects the
 * admin escalation path (R20.3).
 *
 * Both fields are optional/nullable so system-initiated transitions
 * (the invite expiry sweeper, the notification outbox drainer, the KHQR
 * verifier) can record an audit row without inventing a synthetic user.
 * `DealService.transition` falls back to `null` for missing fields when
 * writing the `AuditLogEntry` — see `audit.service.ts` for the matching
 * column nullability.
 *
 * No extra fields here — anything the caller might want to log
 * alongside the action (rejection reason, payout reference, …) belongs
 * in `NewAuditLogEntry.metadata`.
 */
export interface DealActor {
  /**
   * Authenticated `User.id` of the principal performing the action.
   * `null`/`undefined` for system actors (cron jobs, webhook dispatch,
   * KHQR auto-verification).
   */
  user_id?: string | null;
  /**
   * Role the principal is acting in for this deal. For admin-driven
   * transitions (R20.3) this is `ParticipantRole.admin`, even when the
   * underlying admin user does not appear on the `DealParticipant`
   * roster. `null`/`undefined` for system actors.
   */
  role?: ParticipantRole | null;
}
