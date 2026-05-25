/**
 * PatchParticipantDto — body for `PATCH /v1/deals/:publicId/sections/participant`.
 *
 * Source of truth: tasks.md §5.6; requirements.md R7.2.
 *
 * Each participant may only edit the name, phone, and preferred language
 * tied to their own User id on the `DealParticipant` row. The service
 * enforces ownership — editing the other side's fields throws
 * `auth.role_forbidden` (R7.6).
 *
 * Field bounds (R7.2):
 *   - buyer_name:      1–100 characters
 *   - buyer_phone:     ≤20 characters
 *   - seller_name:     1–100 characters
 *   - seller_phone:    ≤20 characters
 *   - preferred_lang:  'km' | 'en' | 'zh'
 */

import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class PatchParticipantDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  buyer_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  buyer_phone?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  seller_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  seller_phone?: string;

  @IsOptional()
  @IsString()
  @IsIn(['km', 'en', 'zh'])
  preferred_lang?: string;
}
