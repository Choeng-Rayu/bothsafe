/**
 * Unit tests for `verifyTelegramInitData` (task 4.3).
 *
 * Acceptance criteria covered: R1.1, R1.3.
 *
 * Strategy:
 *   - Build a known-good `initData` blob the same way Telegram does
 *     (HMAC over sorted, newline-joined `key=value` pairs with the
 *     `WebAppData`-derived secret key) so we can assert positive cases
 *     deterministically without mocking `crypto`.
 *   - Negative cases each tweak exactly one component of the known-good
 *     blob (hash byte, auth_date age, dropped field, malformed user
 *     JSON) so a regression points at the specific check that broke.
 */

import { createHmac } from 'node:crypto';

import {
  MAX_AUTH_DATE_AGE_MS,
  verifyTelegramInitData,
} from './telegram-init-data';

const BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';

/**
 * Build a Telegram-compatible `initData` query string for the supplied
 * fields. The returned blob includes a freshly computed `hash` value
 * over the alphabetically-sorted, `\n`-joined `key=value` lines using
 * `secret_key = HMAC_SHA256("WebAppData", botToken)` exactly as the
 * Telegram Bot API specifies.
 */
function buildInitData(
  botToken: string,
  fields: Record<string, string>,
): string {
  const dataCheckString = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    params.append(k, v);
  }
  params.append('hash', hash);
  return params.toString();
}

const BASE_USER_JSON = JSON.stringify({
  id: 42,
  first_name: 'Alice',
  last_name: 'Example',
  username: 'alice',
  language_code: 'km',
});

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

describe('verifyTelegramInitData', () => {
  it('accepts a freshly-signed initData and returns the parsed user', () => {
    const fields = {
      auth_date: String(nowSecs()),
      query_id: 'AAEC',
      user: BASE_USER_JSON,
    };
    const initData = buildInitData(BOT_TOKEN, fields);

    const result = verifyTelegramInitData(initData, BOT_TOKEN);

    expect(result).not.toBeNull();
    expect(result!.user.id).toBe(42);
    expect(result!.user.first_name).toBe('Alice');
    expect(result!.user.username).toBe('alice');
    expect(result!.authDate).toBe(Number(fields.auth_date));
  });

  it('rejects a blob whose hash has been tampered with', () => {
    const fields = {
      auth_date: String(nowSecs()),
      user: BASE_USER_JSON,
    };
    const initData = buildInitData(BOT_TOKEN, fields);

    // Flip a single hex character in the hash. Any change makes the
    // recomputed HMAC mismatch.
    const tampered = initData.replace(/hash=([0-9a-f])/, (_m, c: string) => {
      return `hash=${c === '0' ? '1' : '0'}`;
    });
    expect(tampered).not.toEqual(initData);

    const result = verifyTelegramInitData(tampered, BOT_TOKEN);
    expect(result).toBeNull();
  });

  it('rejects a blob whose hash was signed with a different bot token', () => {
    const fields = {
      auth_date: String(nowSecs()),
      user: BASE_USER_JSON,
    };
    // Build with a different token so the embedded hash is wrong for
    // the verifier's token.
    const initData = buildInitData('999999:DIFFERENT-TOKEN', fields);

    const result = verifyTelegramInitData(initData, BOT_TOKEN);
    expect(result).toBeNull();
  });

  it('rejects a blob whose auth_date is older than 24 hours', () => {
    const ancient = nowSecs() - Math.ceil(MAX_AUTH_DATE_AGE_MS / 1000) - 60;
    const fields = {
      auth_date: String(ancient),
      user: BASE_USER_JSON,
    };
    const initData = buildInitData(BOT_TOKEN, fields);

    const result = verifyTelegramInitData(initData, BOT_TOKEN);
    expect(result).toBeNull();
  });

  it('rejects a blob whose auth_date is more than 60s in the future', () => {
    const future = nowSecs() + 5 * 60; // 5 minutes ahead of "now"
    const fields = {
      auth_date: String(future),
      user: BASE_USER_JSON,
    };
    const initData = buildInitData(BOT_TOKEN, fields);

    const result = verifyTelegramInitData(initData, BOT_TOKEN);
    expect(result).toBeNull();
  });

  it('rejects a blob with no `hash` parameter', () => {
    const result = verifyTelegramInitData(
      `auth_date=${nowSecs()}&user=${encodeURIComponent(BASE_USER_JSON)}`,
      BOT_TOKEN,
    );
    expect(result).toBeNull();
  });

  it('rejects a blob with no `auth_date` parameter', () => {
    // Build a deliberately-incomplete blob: the hash will be computed
    // over `user=...` only. Verification still fails because we require
    // `auth_date` post-hash for the replay window check.
    const fields = { user: BASE_USER_JSON };
    const initData = buildInitData(BOT_TOKEN, fields);

    const result = verifyTelegramInitData(initData, BOT_TOKEN);
    expect(result).toBeNull();
  });

  it('rejects a blob with a non-JSON `user` value (after re-signing)', () => {
    const fields = {
      auth_date: String(nowSecs()),
      user: 'not-json',
    };
    const initData = buildInitData(BOT_TOKEN, fields);

    const result = verifyTelegramInitData(initData, BOT_TOKEN);
    expect(result).toBeNull();
  });

  it('rejects a blob with a `user` JSON missing the numeric `id` field', () => {
    const fields = {
      auth_date: String(nowSecs()),
      user: JSON.stringify({ first_name: 'Bob' }),
    };
    const initData = buildInitData(BOT_TOKEN, fields);

    const result = verifyTelegramInitData(initData, BOT_TOKEN);
    expect(result).toBeNull();
  });

  it('returns null on empty inputs', () => {
    expect(verifyTelegramInitData('', BOT_TOKEN)).toBeNull();
    expect(verifyTelegramInitData('hash=abc', '')).toBeNull();
  });
});
