import { IsString, Length } from 'class-validator';

/**
 * Request body for `POST /v1/auth/google` (task 4.3, R1.1, R1.3).
 *
 * Field name mirrors Google's own response shape (`id_token`) so the
 * frontend can forward the payload from `google.accounts.id.prompt(...)`
 * without renaming. The 8192-char upper bound is well above the typical
 * Google ID-token length (~1.2 KB) and stops obviously malformed inputs
 * at the validation layer.
 *
 * The property is declared as `id_token` (snake_case) to match the
 * Google client SDK and the spec's exact wording. ESLint's
 * naming-convention rule is muted on this one property because it's a
 * wire-format identifier, not internal state.
 */
export class GoogleLoginDto {
  @IsString()
  @Length(1, 8192)
  // eslint-disable-next-line @typescript-eslint/naming-convention
  id_token!: string;
}
