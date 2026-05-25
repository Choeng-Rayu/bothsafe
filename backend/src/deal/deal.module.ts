/**
 * DealModule — provides {@link DealService}.
 *
 * Source of truth: design §"DealService (`src/deal/`)"; tasks.md §5.1.
 *
 * The service depends on `AuditService` (R20.1) which is exported by
 * `AuditModule`. `PrismaService` is reached through the caller-supplied
 * `Prisma.TransactionClient` rather than injected directly — see
 * `deal.service.ts` for the rationale — so there is no `PrismaModule`
 * import here. (`PrismaModule` is `@Global()` regardless, so injecting
 * it later is a one-line change if a sibling task needs the standalone
 * Prisma client.)
 *
 * The module re-exports `DealService` so feature modules that drive
 * Deal_Status transitions (Wallet, Payment, Invite, Confirmation,
 * Dispute, Admin, …) can compose it through a single `imports:
 * [DealModule]` entry instead of pulling the file directly.
 */

import { Module } from '@nestjs/common';

import { AuditModule } from '../audit';
// task 5.9 — `ApprovalService` joins the deal module so it shares the
// `AuditModule` import and so feature callers can resolve the approval
// flow alongside `DealService` / `InviteService` from a single
// `imports: [DealModule]`.
import { ApprovalService } from './approval.service';
import { DealController } from './deal.controller';
import { DealService } from './deal.service';
// task 5.7
import { InviteService } from './invite.service';

@Module({
  imports: [AuditModule],
  // task 5.7 — `InviteService` joins the deal module so it shares the
  // `AuditModule` import already wired here, and so the join controller
  // (task 5.8) can resolve both `DealService` and `InviteService` from
  // a single `imports: [DealModule]` entry.
  //
  // task 5.9 — `DealController` is registered here so `AppModule` only
  // needs `DealModule` in its `imports` array.
  controllers: [DealController],
  providers: [DealService, InviteService, ApprovalService],
  exports: [DealService, InviteService, ApprovalService],
})
export class DealModule {}
