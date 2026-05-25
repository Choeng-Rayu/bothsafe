/**
 * Telegram WebApp `initData` verifier.
 *
 * Pure module — no NestJS / framework dependencies, no I/O. Consumed by
 * `TelegramAuthService.loginTelegram(...)` (task 4.3) to authenticate a
 * Telegram WebApp / Mini-App user without trusting the client.
 *
 * Algorithm (Telegram Bot API,
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *
 *   1. The query string supplied by `Telegram.WebApp.initData` looks like
 *      `key1=value1&key2=value2&...&hash=<hex>` (URL-encoded).
 *   2. Extract `hash` from the pairs and remove it.
 *   3. Sort the remaining `key=value` pairs alphabetically by key and join
 *      them with `\n` to form the `data_check_string`.
 *   4. Compute `secret_key = HMAC_SHA256("WebAppData", bot_token)`.
 *   5. Compute `expected_hash = HMAC_SHA256(secret_key, data_check_string)`
 *      and compare to the supplied `hash` in constant time.
 *
 * Acceptance criteria covered: R1.1, R1.3.
 *
 * Security notes:
 *
 *   - Comparison is done via `crypto.timingSafeEqual` over equal-length
 *     buffers to avoid leaking match progress through response timing.
 *   - The `auth_date` claim is rejected when older than `MAX_AUTH_DATE_AGE_MS`
 *     (24 h) so a stolen `initData` blob can't be replayed indefinitely.
 *     Future-dated `auth_date` values (clock skew or tampering) are also
 *     rejected.
 *   - On any failure — missing hash, bad signature, expired clock,
 *     malformed user JSON — the function returns `null` instead of
 *     throwing. Callers MUST collapse `null` into a single
 *     `auth.invalid_credentials` response so the server never reveals
 *     which check failed.
 *   - This module never logs the raw `initData`, the bot token, or the
 *     computed hashes. It also never returns the raw query string back to
 *     the caller.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Maximum acceptable age of a Telegram `initData` blob, measured against
 * its `auth_date` claim. Telegram itself recommends rejecting anything
 * older than 24 h to bound replay risk.
 */
export const MAX_AUTH_DATE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Subset of the Telegram WebApp `User` object documented at
 * https://core.telegram.org/bots/webapps#webappuser. We model the fields
 * BothSafe actually consumes; unknown fields are passed through verbatim
 * so callers may read additional claims without changing this module.
 */
export interface TelegramUser {
  /** Telegram user id. Returned as a number per the Bot API. */
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  added_to_attachment_menu?: boolean;
  allows_write_to_pm?: boolean;
  /** Optional Telegram profile picture URL. */
  photo_url?: string;
  /** Forward-compatible bag for any additional fields Telegram may add. */
  [key: string]: unknown;
}

/**
 * Successful verification result. `user` is the parsed `user` JSON object
 * embedded in `initData`; `authDate` is the unix-second timestamp the bot
 * server signed. `rawHash` is the supplied `hash` parameter, returned only
 * for diagnostic logging by the caller — do not store it.
 */
export interface VerifiedTelegramInitData {
  user: TelegramUser;
  authDate: number;
  rawHash: string;
}

/**
 * Verify a Telegram WebApp `initData` query string against `botToken`.
 *
 * Returns the parsed `user` payload on success, `null` on any failure.
 * See file-level docstring for the full algorithm and security notes.
 *
 * @param initData URL-encoded query string from `Telegram.WebApp.initData`.
 * @param botToken Bot token issued by @BotFather. Used as the seed for
 *                 `secret_key = HMAC_SHA256("WebAppData", botToken)`.
 * @param now      Optional clock injection (defaults to `Date.now()`).
 *                 Test-only seam — production callers omit it.
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  now: () => number = Date.now,
): VerifiedTelegramInitData | null {
  // ── Defensive input shape checks ────────────────────────────────────────
  if (typeof initData !== 'string' || initData.length === 0) {
    return null;
  }
  if (typeof botToken !== 'string' || botToken.length === 0) {
    return null;
  }

  // ── Parse the query-string into ordered (key, decoded value) pairs ──────
  // We can't use `URLSearchParams.entries()` directly because we need the
  // raw decoded value (Telegram URL-encodes the entire blob exactly once),
  // and we need to handle a missing `=` gracefully.
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const providedHash = params.get('hash');
  if (typeof providedHash !== 'string' || providedHash.length === 0) {
    return null;
  }

  // Build the data-check string per the Telegram spec: sort the remaining
  // pairs alphabetically by key and join `key=value` lines with `\n`.
  const dataCheckPairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    dataCheckPairs.push(`${key}=${value}`);
  }
  dataCheckPairs.sort();
  const dataCheckString = dataCheckPairs.join('\n');

  // ── Recompute the expected hash ─────────────────────────────────────────
  // secret_key   = HMAC_SHA256("WebAppData", bot_token)
  // expected_hash = HMAC_SHA256(secret_key, data_check_string)
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  // Constant-time compare. `timingSafeEqual` requires equal-length buffers,
  // so a length mismatch is treated as a failure without bytewise compare.
  if (!constantTimeEqualHex(providedHash, expectedHash)) {
    return null;
  }

  // ── Validate `auth_date` is within the replay window ────────────────────
  const authDateRaw = params.get('auth_date');
  if (typeof authDateRaw !== 'string' || authDateRaw.length === 0) {
    return null;
  }
  const authDate = Number.parseInt(authDateRaw, 10);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return null;
  }
  const ageMs = now() - authDate * 1000;
  if (ageMs < -60_000) {
    // Future-dated by more than 60 s — clock skew or tampering. Reject.
    return null;
  }
  if (ageMs > MAX_AUTH_DATE_AGE_MS) {
    return null;
  }

  // ── Parse the `user` JSON claim ─────────────────────────────────────────
  // Telegram embeds `user` as a JSON-encoded string inside the query-string
  // value. The HMAC has already proven the value is unchanged, so `JSON.parse`
  // here is safe in the integrity sense; we still defensively reject malformed
  // shapes (no `id`, wrong types, etc.).
  const userRaw = params.get('user');
  if (typeof userRaw !== 'string' || userRaw.length === 0) {
    return null;
  }
  let user: TelegramUser;
  try {
    const parsed = JSON.parse(userRaw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.id !== 'number' || !Number.isFinite(candidate.id)) {
      return null;
    }
    user = candidate as TelegramUser;
  } catch {
    return null;
  }

  return { user, authDate, rawHash: providedHash };
}

/**
 * Constant-time hex-string equality. Returns `false` for non-string
 * inputs, length mismatches, or any non-hex content (Buffer construction
 * would throw on the latter, which we collapse to `false`).
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, 'hex');
    bufB = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
