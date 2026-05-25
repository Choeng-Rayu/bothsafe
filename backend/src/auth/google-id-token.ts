/**
 * Google ID-token verifier.
 *
 * Pure module wrapping `google-auth-library`'s `OAuth2Client.verifyIdToken`.
 * Consumed by `GoogleAuthService.loginGoogle(...)` (task 4.3) to authenticate
 * a Google sign-in without trusting the client.
 *
 * Algorithm (handled internally by `google-auth-library`):
 *
 *   1. Fetch and cache Google's OAuth2 public certificates
 *      (https://www.googleapis.com/oauth2/v3/certs) keyed by `kid`.
 *   2. Verify the token's RS256 signature against the matching cert.
 *   3. Verify `iss` is one of `https://accounts.google.com` /
 *      `accounts.google.com`.
 *   4. Verify `aud` matches the supplied `audience` (our
 *      `GOOGLE_CLIENT_ID`).
 *   5. Verify `exp` is in the future and `iat` is in the past.
 *
 * Acceptance criteria covered: R1.1, R1.3.
 *
 * Security notes:
 *
 *   - The `OAuth2Client` instance is module-scoped so cert fetches are
 *     cached for the process lifetime — Google rotates them every few
 *     hours and the client refreshes on demand. We do NOT keep one
 *     `OAuth2Client` per request; that would defeat the cache.
 *   - On any failure — bad signature, expired token, wrong audience,
 *     network error fetching certs — the function returns `null`. The
 *     caller MUST collapse `null` into a single
 *     `auth.invalid_credentials` response so the server never reveals
 *     which check failed (R1.6 timing-safe parity with the email path).
 *   - This module never logs the raw `idToken` or its claims.
 */

import { OAuth2Client, type TokenPayload } from 'google-auth-library';

/**
 * Subset of Google's `id_token` payload we surface to callers. Mirrors the
 * fields BothSafe actually consumes; additional standard claims (`iss`,
 * `aud`, `exp`, …) are validated by `google-auth-library` before we ever
 * see them and are intentionally not re-exposed here.
 */
export interface GoogleClaims {
  /**
   * Stable Google account identifier (`sub` claim). Used as the
   * `external_id` value on the `(provider='google', external_id)`
   * `ExternalIdentity` row (R1.3 dedup).
   */
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

/**
 * Single cached `OAuth2Client` per process. The client maintains the
 * public-cert cache used by `verifyIdToken`; we reuse it across calls so
 * we don't refetch certs on every login attempt.
 *
 * The client is constructed lazily so module import doesn't perform any
 * network setup.
 */
let cachedClient: OAuth2Client | null = null;

function getClient(): OAuth2Client {
  if (cachedClient === null) {
    cachedClient = new OAuth2Client();
  }
  return cachedClient;
}

/**
 * Verify a Google `id_token` against `audience` (our `GOOGLE_CLIENT_ID`).
 *
 * Returns the parsed claims on success, `null` on any failure (bad
 * signature, expired token, wrong audience, network error fetching certs,
 * malformed payload). See file-level docstring for the full algorithm and
 * security notes.
 *
 * @param idToken  RS256-signed JWT issued by Google's OAuth flow.
 * @param audience Expected `aud` claim, normally `env.GOOGLE_CLIENT_ID`.
 *                 Empty / missing audience is rejected up-front to avoid
 *                 accidentally accepting any `aud` value when the env is
 *                 not configured.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  audience: string,
): Promise<GoogleClaims | null> {
  // ── Defensive input shape checks ────────────────────────────────────────
  if (typeof idToken !== 'string' || idToken.length === 0) {
    return null;
  }
  if (typeof audience !== 'string' || audience.length === 0) {
    // Refuse to call `verifyIdToken` with an empty audience — the library
    // would happily accept any `aud` claim, which is exactly the failure
    // mode we're guarding against here.
    return null;
  }

  let payload: TokenPayload | undefined;
  try {
    const ticket = await getClient().verifyIdToken({ idToken, audience });
    payload = ticket.getPayload();
  } catch {
    return null;
  }

  if (!payload) {
    return null;
  }

  // `verifyIdToken` already enforces `iss`, `aud`, `exp`, signature, but
  // we still defensively check `sub` because a malformed payload without
  // a `sub` claim cannot be linked to an `ExternalIdentity` row.
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    return null;
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    email_verified:
      typeof payload.email_verified === 'boolean'
        ? payload.email_verified
        : undefined,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    picture: typeof payload.picture === 'string' ? payload.picture : undefined,
  };
}
