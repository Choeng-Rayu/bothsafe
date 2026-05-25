/**
 * `@CurrentUser()` parameter decorator.
 *
 * Source of truth: tasks.md §4.6; design §"AuthService".
 *
 * Returns the authenticated `User` row attached to the request by
 * `SessionCookieMiddleware` (task 4.4), or `undefined` when no session
 * is active.
 *
 * ## Why `User | undefined` (not `User`)
 *
 * The decorator is intentionally permissive about absence so it can be
 * used in **two** kinds of routes:
 *
 *   1. **Guarded routes** (behind `@UseGuards(AuthGuard)`). The guard
 *      has already rejected unauthenticated requests with
 *      `auth.required`, so the value is effectively non-null at runtime.
 *      Controllers can narrow with a non-null assertion or, more
 *      idiomatically, pair the decorator with the guard and let
 *      TypeScript treat the value as `User` in business logic.
 *
 *   2. **Public-but-personalisable routes** (e.g. invite preview, deal
 *      room read). These pages render whether or not a user is signed
 *      in; the decorator returning `undefined` lets them branch without
 *      reaching for a custom guard.
 *
 * Returning a non-null `User` here would force every public controller
 * to either inject `Request` directly or wrap the decorator, which is
 * exactly the boilerplate the decorator is meant to remove.
 *
 * ## Implementation note
 *
 * `createParamDecorator` runs once at module import; the resulting
 * decorator is invoked at parameter-resolution time per request. We
 * read through `readRequestUser` rather than `req.user` directly so the
 * extraction path stays consistent with `AuthGuard` / `AdminGuard` —
 * if the session middleware ever changes where it stores the user
 * (e.g. `req.session.user`), only `auth.types.ts` needs updating.
 */

import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';

import { type AuthenticatedUser, readRequestUser } from './auth.types';

/**
 * Inject the authenticated `User` (or `undefined`) into a controller
 * handler:
 *
 * ```ts
 * @UseGuards(AuthGuard)
 * @Get('/me')
 * me(@CurrentUser() user: User) { ... }      // guard ensures non-null
 *
 * @Get('/d/:publicId')
 * deal(@CurrentUser() user: User | undefined) { ... } // public route
 * ```
 *
 * The decorator ignores its `data` argument; supply nothing to
 * `@CurrentUser()` at the call site.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser | undefined => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return readRequestUser(req);
  },
);
