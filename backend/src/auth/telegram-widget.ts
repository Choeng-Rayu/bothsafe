/**
 * Telegram Login Widget verifier (web sign-in flow).
 *
 * Distinct from `telegram-init-data.ts`, which verifies the Mini-App
 * `initData` blob using `secret = HMAC_SHA256("WebAppData", bot_token)`.
 * The web Login Widget at https://core.telegram.org/widgets/login uses
 * a SIMPLER scheme:
 *
 *   secret_key   = SHA256(bot_token)            // raw 32-byte digest
 *   data_check_string = sorted "key=value\n…"   // joined with newlines
 *   expected_hash = HMAC_SHA256(secret_key, data_check_string)
 *
 * The widget callback delivers a flat object with these keys:
 *   id, first_name, last_name?, username?, photo_url?, auth_date, hash
 *
 * Returns the verified user fields on success, `null` on any failure
 * (missing hash, bad signature, expired blob, malformed shape). Callers
 * MUST collapse `null` into a single `auth.invalid_credentials`
 * response so failure modes never leak server-side.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { MAX_AUTH_DATE_AGE_MS } from './telegram-init-data';

/**
 * Raw payload posted by the Telegram Login Widget callback. All fields
 * arrive as strings on the wire (the widget either dispatches a
 * `data-onauth` callback with this object literal or redirects with
 * the same fields as URL params).
 */
export interface TelegramWidgetPayload {
  id: number | string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number | string;
  hash: string;
  [key: string]: unknown;
}

export interface VerifiedTelegramWidgetUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  authDate: number;
}

/**
 * Verify a Telegram Login Widget payload against `botToken`.
 * Returns the verified user on success, `null` on any failure.
 */
export function verifyTelegramWidget(
  payload: TelegramWidgetPayload,
  botToken: string,
  now: () => number = Date.now,
): VerifiedTelegramWidgetUser | null {
  if (typeof botToken !== 'string' || botToken.length === 0) return null;
  if (typeof payload !== 'object' || payload === null) return null;

  const providedHash = typeof payload.hash === 'string' ? payload.hash : '';
  if (providedHash.length === 0) return null;

  // Build the data-check string from every field EXCEPT `hash`,
  // sorted by key, joined with `\n`. Values are stringified verbatim.
  const pairs: string[] = [];
  for (const key of Object.keys(payload)) {
    if (key === 'hash') continue;
    const value = payload[key];
    if (value === undefined || value === null) continue;
    pairs.push(`${key}=${String(value)}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = createHash('sha256').update(botToken).digest();
  const expectedHash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (!constantTimeEqualHex(providedHash, expectedHash)) return null;

  // ── Validate auth_date freshness ────────────────────────────────────────
  const authDateRaw = payload.auth_date;
  const authDate =
    typeof authDateRaw === 'number'
      ? authDateRaw
      : Number.parseInt(String(authDateRaw), 10);
  if (!Number.isFinite(authDate) || authDate <= 0) return null;
  const ageMs = now() - authDate * 1000;
  if (ageMs < -60_000) return null;
  if (ageMs > MAX_AUTH_DATE_AGE_MS) return null;

  // ── Validate id ─────────────────────────────────────────────────────────
  const idRaw = payload.id;
  const id =
    typeof idRaw === 'number' ? idRaw : Number.parseInt(String(idRaw), 10);
  if (!Number.isFinite(id) || id <= 0) return null;

  const result: VerifiedTelegramWidgetUser = { id, authDate };
  if (typeof payload.first_name === 'string' && payload.first_name.length > 0) {
    result.first_name = payload.first_name;
  }
  if (typeof payload.last_name === 'string' && payload.last_name.length > 0) {
    result.last_name = payload.last_name;
  }
  if (typeof payload.username === 'string' && payload.username.length > 0) {
    result.username = payload.username;
  }
  if (typeof payload.photo_url === 'string' && payload.photo_url.length > 0) {
    result.photo_url = payload.photo_url;
  }
  return result;
}

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
