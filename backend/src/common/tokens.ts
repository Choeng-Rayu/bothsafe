/**
 * Token utilities — cuid v2 generation, SHA-256 hashing, and constant-time
 * hash comparison.
 *
 * Reference: see `.kiro/specs/bothsafe-deal-flow/design.md` §"Token strategy".
 *
 * SECURITY:
 *   Raw token values produced by `generateRawToken()` and
 *   `generateReferenceNote()` MUST NEVER be logged, persisted to the database,
 *   written to audit rows, or echoed back in any API response after their
 *   initial issuance. The database only ever stores the SHA-256 hash of a raw
 *   token in the corresponding `*_token_hash` columns
 *   (`session.token_hash`, `creator_access_token.token_hash`,
 *   `participant_access_token.token_hash`, `invite_token.token_hash`).
 *   Comparison against a candidate raw token is always done by hashing the
 *   candidate and running a constant-time compare against the stored hash via
 *   `verifyToken` / `compareTokenHashes`.
 *
 *   Implements R2.9 (creator/invite tokens stored as hashes only, raw returned
 *   exactly once) and R5.8 (participant access token stored as hash only, raw
 *   returned exactly once on join).
 *
 * Pure functions: no module-level mutable state. Randomness comes from
 * `@paralleldrive/cuid2` (which itself relies on `crypto.randomBytes`) and
 * Node's `crypto.randomBytes` for the reference-note allocator.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';

/**
 * Minimum length (in characters) accepted by `verifyToken`. Cuid v2 tokens are
 * ~24 chars, so any candidate below this threshold cannot possibly be one of
 * our tokens and is rejected before we spend cycles hashing it. This also
 * blunts trivial bruteforce attempts against the verify path.
 */
export const MIN_TOKEN_LENGTH = 16;

/**
 * Length of a SHA-256 hex digest. Used as a sanity gate inside
 * `compareTokenHashes` to reject obviously malformed inputs in O(1).
 */
const SHA256_HEX_LENGTH = 64;

/**
 * Crockford base32 alphabet: removes the visually ambiguous characters
 * `I`, `L`, `O`, and `U` from the standard base32 set. Used by
 * `generateReferenceNote()` to mint deal-room reference notes that are safe
 * for humans to retype off a printed receipt.
 *
 * Order is significant — index `n` (0..31) is the symbol for the 5-bit chunk
 * value `n`.
 */
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Length of a generated reference note in characters. 16 Crockford-base32
 * symbols = 80 bits of entropy, enough to make the `deal_room.reference_note`
 * UNIQUE constraint collision-free in practice (R10.1).
 */
const REFERENCE_NOTE_LENGTH = 16;

/**
 * Generate a fresh cuid v2 token (~24 characters, URL-safe, lowercase
 * alphanumeric). This is the value embedded in invite/creator/participant
 * access links and shown to the user exactly once at issuance.
 *
 * Callers MUST hash the result with `hashToken` before persisting and MUST
 * NOT log the raw value.
 */
export function generateRawToken(): string {
  return createId();
}

/**
 * Generate a fresh cuid v2 identifier suitable for use as a public,
 * URL-visible deal room id (`DealRoom.public_id`, the slug in
 * `https://bothsafe.app/d/{publicId}`).
 *
 * Cuid v2 is collision-resistant, host-independent, and lexicographically
 * sortable by approximate creation time, which is convenient for paginated
 * listings. The format is identical to `generateRawToken()` — the two
 * functions are kept distinct so callers express intent at the call site
 * (a public id is meant to be visible in URLs; a raw token is a secret).
 */
export function generatePublicId(): string {
  return createId();
}

/**
 * SHA-256 hash of the UTF-8 bytes of `raw`, returned as lowercase hex.
 *
 * Used both for storing the canonical hash of a freshly issued token (the
 * `*_token_hash` columns) and for hashing a candidate raw token before
 * looking it up.
 */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Constant-time equality check between two SHA-256 hex digests as produced
 * by `hashToken`.
 *
 * The function:
 *   1. Rejects values that are not strings or that don't look like a SHA-256
 *      hex digest (length 64) before any comparison. Length is not secret,
 *      so a length-based early exit does not leak token contents.
 *   2. Compares the bytes of the two digests via `crypto.timingSafeEqual`
 *      over equal-length Buffers.
 *
 * Returns `true` only when both inputs are well-formed SHA-256 hex digests
 * with byte-identical contents.
 */
export function compareTokenHashes(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  if (a.length !== SHA256_HEX_LENGTH || b.length !== SHA256_HEX_LENGTH) {
    return false;
  }

  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  // `timingSafeEqual` requires equal-length buffers; the explicit check above
  // already guarantees that, but we keep this defensive guard so the function
  // never throws on malformed input — it just returns false.
  if (bufA.length !== bufB.length) {
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

/**
 * Constant-time verification of a candidate raw token against an
 * `expectedHash` previously produced by `hashToken`.
 *
 * Composes:
 *   1. A length precheck on `raw` against `MIN_TOKEN_LENGTH` to bail out on
 *      obviously bogus candidates without spending a SHA-256 cycle.
 *   2. `hashToken(raw)` to derive the candidate hash.
 *   3. `compareTokenHashes(...)` for the constant-time comparison.
 *
 * Returns `true` only when the candidate's SHA-256 hash exactly matches
 * `expectedHash`.
 */
export function verifyToken(raw: string, expectedHash: string): boolean {
  if (typeof raw !== 'string' || raw.length < MIN_TOKEN_LENGTH) {
    return false;
  }
  if (typeof expectedHash !== 'string' || expectedHash.length === 0) {
    return false;
  }

  return compareTokenHashes(hashToken(raw), expectedHash);
}

/**
 * Generate a 16-character Crockford-base32 reference note used as the
 * human-typeable, deal-scoped identifier on Bakong KHQR payments
 * (`deal_room.reference_note`, R10.1).
 *
 * Implementation:
 *   - Draw 16 random bytes from `crypto.randomBytes` (128 bits of entropy).
 *   - Map each byte to a single Crockford-base32 symbol by taking its low
 *     5 bits (`byte & 0x1f`). The remaining 3 bits are discarded — we only
 *     need 80 bits of output entropy for a 16-symbol note, so this is fine
 *     and keeps the implementation a straightforward byte-by-byte map.
 *   - The chosen alphabet excludes `I`, `L`, `O`, and `U` to avoid
 *     ambiguous-character mistakes when a payer retypes the note from a
 *     receipt.
 *
 * Uniqueness against existing reference notes is enforced by the UNIQUE
 * index on `deal_room.reference_note`; the caller is responsible for
 * retrying on a unique-constraint violation.
 */
export function generateReferenceNote(): string {
  const bytes = randomBytes(REFERENCE_NOTE_LENGTH);
  let out = '';
  for (let i = 0; i < REFERENCE_NOTE_LENGTH; i++) {
    out += CROCKFORD_BASE32[bytes[i] & 0x1f];
  }
  return out;
}
