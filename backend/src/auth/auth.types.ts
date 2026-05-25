/**
 * Shared type helpers for the Auth module.
 *
 * Source of truth: tasks.md §4.4 (`SessionCookieMiddleware`) and §4.6
 * (`AuthGuard`, `AdminGuard`, `@CurrentUser()`).
 *
 * These types document the contract between the (parallel) session
 * middleware and any consumer that reads `req.user`:
 *
 *   - `SessionCookieMiddleware` validates the `bs_session` cookie, looks
 *     up the matching `Session` row, then attaches the resolved `User`
 *     onto the Express request as `req.user` (R1.2, R1.8).
 *   - Guards (`AuthGuard`, `AdminGuard`), the `@CurrentUser()` parameter
 *     decorator, and downstream services all consume that single
 *     `req.user` slot.
 *
 * Keeping the augmentation in one place — instead of casting inline at
 * every call site — means the contract is documented once and any future
 * change (additional fields, stricter typing) ripples outward
 * automatically.
 *
 * Pure module — no runtime exports beyond the helper accessor; importing
 * this file does not pull in NestJS, Express, or Prisma side effects.
 */

import type { User } from '@prisma/client';
import type { Request } from 'express';

/**
 * The authenticated principal attached to a request by
 * `SessionCookieMiddleware`.
 *
 * Currently aliased to the full Prisma `User` row because the middleware
 * loads the row anyway (it needs `is_admin` for `AdminGuard`, and
 * downstream controllers rely on `display_name`, `preferred_lang`, etc.).
 * If we later want to attach a leaner projection, this is the single
 * place to narrow it.
 */
export type AuthenticatedUser = User;

/**
 * Express `Request` extended with the optional `user` slot the session
 * middleware writes to. The slot is `undefined` for:
 *
 *   - public endpoints,
 *   - requests with no `bs_session` cookie,
 *   - requests with an expired / revoked session,
 *   - requests where the resolved `User` row no longer exists.
 *
 * We deliberately avoid declaring `user` on the global `Express.Request`
 * via module augmentation — Passport / `@nestjs/passport` already write
 * to that same global slot, and conflicting augmentations across the
 * dependency tree have caused hard-to-diagnose type errors in similar
 * NestJS projects. A local intersection type is enough for the call
 * sites that actually need typed access.
 */
export type AuthenticatedRequest = Request & {
  user?: AuthenticatedUser;
};

/**
 * Extract the authenticated `User` from an Express request, or `undefined`
 * when the slot is not populated. Centralised so guards, decorators, and
 * services share the exact same read path; if `SessionCookieMiddleware`
 * ever moves the slot (e.g. `req.session.user`), only this helper needs
 * updating.
 */
export function readRequestUser(req: Request): AuthenticatedUser | undefined {
  return (req as AuthenticatedRequest).user;
}
