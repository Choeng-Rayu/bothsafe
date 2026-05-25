import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { ALL_PREFERRED_LANGS } from '../../common/enums';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../password';

/**
 * Request body for `POST /v1/auth/email/signup` (task 4.1).
 *
 * Source of truth: tasks.md §4.1; design §"AuthService"; R1.1, R1.4, R1.5,
 * R1.9.
 *
 * ## Field rules
 *
 * - `email` — must be a syntactically valid email (R1.4). The
 *   `@Transform` step trims surrounding whitespace and lowercases the
 *   value before validation so the bucket key the rate limiter computes
 *   (`email:<normalised>`) is stable across casing variants. `class-
 *   validator`'s `@IsEmail()` then enforces the format.
 *
 * - `password` — between 8 and 128 characters (R1.4). The same bound is
 *   re-enforced inside the password helper (`hashPassword`) as
 *   defence-in-depth. The DTO validation runs first so a malformed body
 *   fails before we burn argon2id cycles or touch the DB.
 *
 * - `displayName` — optional, ≤ 80 chars. Persisted on `User.display_name`
 *   verbatim. We do NOT normalise / strip whitespace beyond the trim step
 *   so users keep agency over their visible name.
 *
 * - `preferredLang` — optional, one of `'km' | 'en' | 'zh'`. Defaults are
 *   set at the schema layer (`PreferredLang.en`). When omitted, the
 *   service path lets Prisma apply that default rather than guessing here.
 *
 * The DTO is intentionally lean — no role, no telegram fields. Those are
 * separate identity flows (task 4.3).
 */
export class EmailSignupDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'errors.auth.invalid_signup_data' })
  @MaxLength(254, { message: 'errors.auth.invalid_signup_data' })
  email!: string;

  @IsString({ message: 'errors.auth.invalid_signup_data' })
  @MinLength(PASSWORD_MIN_LENGTH, {
    message: 'errors.auth.invalid_password_length',
  })
  @MaxLength(PASSWORD_MAX_LENGTH, {
    message: 'errors.auth.invalid_password_length',
  })
  password!: string;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(80)
  displayName?: string;

  @IsOptional()
  @IsIn(ALL_PREFERRED_LANGS as readonly string[], {
    message: 'errors.auth.invalid_signup_data',
  })
  preferredLang?: 'km' | 'en' | 'zh';
}
