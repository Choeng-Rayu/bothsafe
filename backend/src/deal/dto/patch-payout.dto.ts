/**
 * PatchPayoutDto — body for `PATCH /v1/deals/:publicId/sections/payout`.
 *
 * Source of truth: tasks.md §5.6; requirements.md R7.1.
 *
 * Only the seller participant may edit payout fields. Non-seller
 * participants (buyer, anonymous) receive `auth.role_forbidden` (R7.6).
 *
 * Payout fields are non-material — editing them preserves existing
 * approvals and does not revert Deal_Status (R7.4).
 */

import { IsOptional, IsString, MaxLength } from 'class-validator';

export class PatchPayoutDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  payout_khqr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  payout_bank_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  payout_account_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  payout_account_number?: string;
}
