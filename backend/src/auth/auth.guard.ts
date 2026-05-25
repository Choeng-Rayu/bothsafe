/**
 * AuthGuard — gates routes that require an authenticated session.
 *
 * Source of truth: tasks.md §4.6; design §"AuthService"; R1.8.
 *
 * ## Contract
 *
 * The guard relies on `SessionCookieMiddleware` (task 4.4) having
 * already run. The middleware resolves the `bs_session` cookie to a live
 * `Session` row, loads the linked `User`, and writes it onto the request
 * as `req.user`. This guard inspects that single slot:
 *
 *   - `req.user` populated  → `canActivate` returns `true`, request flows
 *     into the controller.
 *   - `req.user` missing    → throw
 *     `DomainException.unauthorized('auth.required')` so the global
 *     filter renders the canonical envelope (R1.8) and the frontend can
 *     redirect to `/auth/login?next=...`.
 *
 * The guard is intentionally tiny: it does NOT validate the cookie,
 * touch the `session` or `user` tables, or refresh anything. All session
 * state lives in the middleware so request-time work happens once per
 * request — guards are pure authorisation checks.
 *
 * ## Composition with `AdminGuard`
 *
 * Use them together as
 * `@UseGuards(AuthGuard, AdminGuard)`. Because NestJS evaluates guards
 * left-to-right, `AuthGuard` short-circuits unauthenticated requests
 * with `auth.required` before `AdminGuard` runs. That ordering is what
 * lets `AdminGuard` assume `req.user` is populated.
 *
 * ## Why a parameter-decorator-friendly throw
 *
 * Throwing `DomainException.unauthorized(...)` (HTTP 401) — instead of
 * returning `false` — gives the global filter a structured envelope to
 * serialise. Returning `false` would let NestJS fall back to its built-in
 * `ForbiddenException` (HTTP 403), which is the wrong status code for
 * "not authenticated" and would also bypass our message-key contract.
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
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const user = readRequestUser(req);

    if (!user) {
      // R1.8 — unauthenticated request hitting a guarded route. Throw a
      // domain exception so `GlobalExceptionFilter` returns the
      // canonical `{ error: { code: 'auth.required', message_key:
      // 'errors.auth.required' } }` envelope. The frontend uses that
      // code to drive the `/auth/login?next=...` redirect.
      throw DomainException.unauthorized('auth.required');
    }

    return true;
  }
}
