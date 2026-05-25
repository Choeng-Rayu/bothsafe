/**
 * AuditModule — provides {@link AuditService}.
 *
 * Source of truth: design §"Audit (`src/audit/`)"; tasks.md §3.9.
 *
 * The service is a stateless, dependency-free writer (it only touches the
 * `Prisma.TransactionClient` handed to it by the caller — see
 * `audit.service.ts` for the rationale), so this module has no imports of
 * its own. We re-export `AuditService` so any feature module that performs
 * status transitions, wallet movements, or admin actions can inject it by
 * importing this module.
 *
 * `PrismaModule` is already declared `@Global()` in `src/prisma/prisma.module.ts`,
 * so `AuditService` callers obtain the `PrismaService` (and therefore the
 * transaction client they pass to `record(...)`) without any extra wiring
 * here.
 */

import { Module } from '@nestjs/common';

import { AuditService } from './audit.service';

@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
