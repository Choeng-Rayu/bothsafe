/**
 * Public surface of the deal module.
 *
 * Mirrors the `src/audit/index.ts` and `src/prisma/index.ts` conventions
 * so feature modules can do `import { DealModule, DealService } from
 * '../deal';` without reaching past the module boundary.
 */

export { DealModule } from './deal.module';
export { DealService } from './deal.service';
export type {
  CreateDealInput,
  CreateDealResult,
  CreateDealSections,
} from './deal.service';
export type { DealActor } from './deal.types';
export { computeAllowedActions } from './deal.allowed-actions';
export type {
  DealAllowedActionsInput,
  DealRoomLike,
  DealViewer,
} from './deal.allowed-actions';
export { computeTermsHash } from './deal.terms-hash';
export type { TermsHashInput } from './deal.terms-hash';
// task 5.4 — pure helper exported alongside the DealService method so
// other modules (controllers, the deal-room response builder) can call
// it without injecting the service.
export { computeMissingFields } from './deal.missing-fields';
export type { DealMissingFieldsInput } from './deal.missing-fields';

// task 5.7 — InviteService lives inside the deal module so feature
// callers can resolve it through the same `imports: [DealModule]` they
// already use for `DealService`.
export {
  InviteService,
  INVITE_PREVIEW_PRODUCT_TITLE_MAX_LEN,
} from './invite.service';
export type {
  InviteRole,
  InvitePreview,
  InviteConsumeResult,
} from './invite.service';

// task 5.9 — ApprovalService owns the participant approval flow
// (R8.x). Re-exported alongside `DealService` / `InviteService` so
// feature callers can resolve the full deal surface through the same
// barrel.
export { ApprovalService } from './approval.service';
export type { ApprovalViewer, ApprovalResult } from './approval.service';
export { DealController } from './deal.controller';
export type { DealRoomResponse } from './deal.controller';

// task 5.2 — DTO for `POST /v1/deals` request body.
export { CreateDealDto } from './dto/create-deal.dto';

// task 5.8 — Join DTO + bounds constants. The join controller lives
// on the same `DealController` registered for §5.6 / §5.9 so the
// section-patch routes, the approval route, and the join route share
// a single `@Controller(...)`.
export {
  JoinDealDto,
  JOIN_NAME_MAX_LENGTH,
  JOIN_PHONE_MIN_LENGTH,
  JOIN_PHONE_MAX_LENGTH,
  JOIN_PHONE_PATTERN,
} from './dto/join-deal.dto';
export type { JoinDealResponse } from './deal.controller';
