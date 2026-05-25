/**
 * PatchProductDto — body for `PATCH /v1/deals/:publicId/sections/product`.
 *
 * Source of truth: tasks.md §5.6; requirements.md R7.1.
 *
 * All fields are optional (partial patch). The controller validates that
 * at least one field is present; the service handles material-edit detection
 * and approval invalidation (R7.3, `DEAL_MATERIAL_EDIT_FIELDS`).
 *
 * Field bounds (R7.1):
 *   - product_title:       1–200 characters
 *   - product_type:        1–100 characters
 *   - product_description: 0–2000 characters
 *   - quantity:            integer 1–999,999
 *   - condition:           'new' or 'used'
 *   - deal_amount:         0.01–999,999,999.99 with ≤2 decimal places
 *   - currency:            'USD' or 'KHR'
 */

import {
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class PatchProductDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  product_title?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  product_type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  product_description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(999_999)
  quantity?: number;

  @IsOptional()
  @IsString()
  @IsIn(['new', 'used'])
  condition?: string;

  /**
   * Decimal string accepted by `parseMoney`. We accept a string here so
   * JavaScript consumers can pass `"12.30"` without floating-point loss.
   * The service validates the range and precision via `assertValidDealAmount`.
   */
  @IsOptional()
  @IsNumberString({ no_symbols: false })
  deal_amount?: string;

  @IsOptional()
  @IsString()
  @IsIn(['USD', 'KHR'])
  currency?: string;
}
