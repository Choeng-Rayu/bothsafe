import { IsString, Length } from 'class-validator';

/**
 * Request body for `POST /v1/auth/telegram` (task 4.3, R1.1, R1.3).
 *
 * `initData` is the URL-encoded query string produced by
 * `Telegram.WebApp.initData` on the client. We accept it verbatim — the
 * server-side `verifyTelegramInitData` function (
 * `src/auth/telegram-init-data.ts`) recomputes the HMAC and rejects
 * tampered or expired blobs. The 4096-character upper bound is a generous
 * cap that comfortably exceeds Telegram's documented payload while
 * stopping obviously oversized inputs at the validation layer.
 */
export class TelegramLoginDto {
  @IsString()
  @Length(1, 4096)
  initData!: string;
}
