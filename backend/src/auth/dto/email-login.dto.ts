import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../password';

/**
 * Request body for `POST /v1/auth/email/login` (task 4.2).
 *
 * Source of truth: tasks.md §4.2; design §"AuthService"; R1.1, R1.2, R1.6,
 * R1.7.
 *
 * Same normalisation rules as `EmailSignupDto` so the rate-limiter bucket
 * key (`email:<normalised>`) matches across signup and login attempts. The
 * password length range is identical to signup so a credential that could
 * have been registered is also long enough to be checked — but the upper
 * bound also stops a malicious caller from forcing an unbounded argon2id
 * cycle by submitting a megabyte-scale string.
 */
export class EmailLoginDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'errors.auth.invalid_credentials' })
  @MaxLength(254, { message: 'errors.auth.invalid_credentials' })
  email!: string;

  @IsString({ message: 'errors.auth.invalid_credentials' })
  @MinLength(PASSWORD_MIN_LENGTH, {
    message: 'errors.auth.invalid_credentials',
  })
  @MaxLength(PASSWORD_MAX_LENGTH, {
    message: 'errors.auth.invalid_credentials',
  })
  password!: string;
}
