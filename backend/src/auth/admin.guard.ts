/**
 * AdminGuard — gates routes that require an authenticated **admin** user.
 *
 * Source of truth: tasks.md §4.6; design §"AuthService"; R16.6, R16.8.
 *
 * ## Composition contract
 *
 * `AdminGuard` is designed to run **after** `AuthGuard`:
 *
 * ```ts
 * @UseGuards(AuthGuard, AdminGuard)
 * @Post('/admin/withdrawals/:id/approve')
 * approve(...) { ... }
 * ```
 *
 * NestJS evaluates the guards in the order supplied, so by the time
 * `AdminGuard.canActivate` runs:
 *
 *   - `req.user` is guaranteed to be populated (otherwise `AuthGuard`
 *     would already have thrown `auth.required`),
 *   - therefore the only branch to defend is `is_admin !== true`.
 *
 * For defence-in-depth — and so the guard is safe to mount alone in
 * code paths where someone forgot to add `AuthGuard` — we ALSO check
 * `req.user` here. If the slot is missing, we throw `auth.required`
 * (matching `AuthGuard`'s behaviour) rather than `auth.admin_required`,
 * because we cannot say a request is "admin-forbidden" before we know
 * who is making it.
 *
 * ## Error envelope
 *
 * Per R16.8 the rejection envelope must be `auth.admin_required`. We
 * route through `DomainException.forbidden(...)` (HTTP 403) so the
 * global filter emits:
 *
 * ```json
 * { "error": { "code": "auth.admin_required",
 *              "message_key": "errors.auth.admin_required" } }
 * ```
 *
 * R16.8 also says "SHALL NOT write an Audit_Log entry for the rejected
 * attempt". The guard is a pure authorisation check — it never touches
 * `AuditService` — so that constraint is satisfied trivially: an audit
 * row is only written by the controller's transaction, which never runs
 * for a rejected admin request.
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

import { DomainException } from '../common/errors';
import { readRequestUser } from './auth.types';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const user = readRequestUser(req);

    if (!user) {
      // Defence-in-depth: someone mounted `AdminGuard` without
      // `AuthGuard` in front of it. Keep the response shape consistent
      // with `AuthGuard` so the frontend's redirect logic still fires.
      throw DomainException.unauthorized('auth.required');
    }

    if (user.is_admin !== true) {
      // R16.8 — non-admin tried to reach an admin-only endpoint.
      throw DomainException.forbidden('auth.admin_required');
    }

    return true;
  }
}
