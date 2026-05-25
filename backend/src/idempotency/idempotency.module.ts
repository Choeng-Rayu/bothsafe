/**
 * IdempotencyModule — provides {@link IdempotencyMiddleware}.
 *
 * Source of truth: tasks.md §3.8; design §"Idempotency".
 *
 * The middleware is wired in `AppModule.configure(consumer)` against the
 * `'*'` route so it inspects every request once. It internally no-ops for
 * non-mutating methods, requests without an `Idempotency-Key` header, and
 * unauthenticated requests — see `idempotency.middleware.ts` for the full
 * skip rules.
 *
 * `PrismaModule` is already declared `@Global()` in `src/prisma/prisma.module.ts`,
 * so the middleware obtains `PrismaService` without any extra imports here.
 */

import { Module } from '@nestjs/common';

import { IdempotencyMiddleware } from './idempotency.middleware';

@Module({
  providers: [IdempotencyMiddleware],
  exports: [IdempotencyMiddleware],
})
export class IdempotencyModule {}
