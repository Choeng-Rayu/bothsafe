/**
 * PatchDeliveryDto — body for `PATCH /v1/deals/:publicId/sections/delivery`.
 *
 * Source of truth: tasks.md §5.6; requirements.md R7.1.
 *
 * Delivery fields are non-material — editing them preserves existing
 * approvals and does not revert Deal_Status (R7.4).
 */

import { IsOptional, IsString, MaxLength } from 'class-validator';

export class PatchDeliveryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  delivery_method?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  delivery_address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  delivery_note?: string;
}
