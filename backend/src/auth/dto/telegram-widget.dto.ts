import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * DTO for `POST /v1/auth/telegram/widget` — web Login Widget callback.
 *
 * The Telegram Login Widget (https://core.telegram.org/widgets/login)
 * delivers a flat object with `{id, first_name, ..., hash}` fields
 * either via `data-onauth` callback or as URL query params on redirect.
 * This DTO validates the shape before handing it to
 * `TelegramAuthService.loginTelegramWidget`.
 */

class TelegramWidgetPayloadDto {
  @IsInt()
  @Min(1)
  id!: number;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  first_name?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  last_name?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  username?: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  photo_url?: string;

  @IsInt()
  @Min(1)
  auth_date!: number;

  @IsString()
  @Length(64, 64)
  hash!: string;

  [key: string]: unknown;
}

export class TelegramWidgetDto {
  @ValidateNested()
  @Type(() => TelegramWidgetPayloadDto)
  payload!: TelegramWidgetPayloadDto;
}
