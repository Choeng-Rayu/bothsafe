/**
 * Argon2id password hashing wrapper.
 *
 * Pure module. No NestJS / framework dependencies; consumed by `AuthService`
 * (task 4.x).
 *
 * Security notes:
 * - Passwords MUST be 8–128 characters (R1.4). Out-of-range inputs throw a
 *   `RangeError` with a stable message_key, never echoing the plaintext.
 * - Hashes are produced with Argon2id, m=64MiB (65536 KiB), t=3, p=4,
 *   hashLength=32 (R1.9, design "Password hashing").
 * - `verifyPassword` swallows internal errors (malformed hash, decode
 *   failures, etc.) and returns `false` so callers can implement uniform
 *   `auth.invalid_credentials` responses without leaking which side failed.
 * - This module never logs plaintext or hash material. Errors are surfaced
 *   only via thrown `RangeError`/return values; their messages are
 *   `message_key`-style codes that contain no secret data.
 */

import * as argon2 from 'argon2';

/** Minimum acceptable password length (R1.4). */
export const PASSWORD_MIN_LENGTH = 8;

/** Maximum acceptable password length (R1.4). */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Argon2id parameters used for hashing new passwords. Frozen so a misbehaving
 * caller cannot weaken the parameters at runtime.
 *
 * - `memoryCost` is expressed in KiB; 65536 KiB == 64 MiB.
 * - `hashLength` is the raw output length in bytes; the encoded `$argon2id$`
 *   string returned by `hash` is base64-larger.
 */
export const ARGON2ID_PARAMS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
} as const);

/**
 * `argon2.needsRehash` only inspects time/memory/parallelism/version, so we
 * project the hashing parameters down to the subset it understands.
 */
const NEEDS_REHASH_PARAMS = Object.freeze({
  type: ARGON2ID_PARAMS.type,
  memoryCost: ARGON2ID_PARAMS.memoryCost,
  timeCost: ARGON2ID_PARAMS.timeCost,
  parallelism: ARGON2ID_PARAMS.parallelism,
} as const);

function assertValidLength(plain: string): void {
  // Reject explicitly so callers get `auth.invalid_password_length` rather
  // than burning Argon2 cycles on input we already know is invalid.
  if (
    typeof plain !== 'string' ||
    plain.length < PASSWORD_MIN_LENGTH ||
    plain.length > PASSWORD_MAX_LENGTH
  ) {
    throw new RangeError('auth.invalid_password_length');
  }
}

/**
 * Hash a plaintext password using Argon2id and return the encoded
 * `$argon2id$...` string suitable for storage.
 *
 * @throws {RangeError} `auth.invalid_password_length` when `plain` is not a
 *   string in the inclusive range [PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH].
 */
export async function hashPassword(plain: string): Promise<string> {
  assertValidLength(plain);
  return argon2.hash(plain, ARGON2ID_PARAMS);
}

/**
 * Verify a plaintext password against an encoded Argon2 hash.
 *
 * Returns `false` for any failure mode — wrong password, malformed hash,
 * unsupported variant, internal decode error — so callers can collapse all
 * of them into a single `auth.invalid_credentials` response without timing
 * or message side channels. Comparison itself is constant-time at the
 * libargon2 level.
 */
export async function verifyPassword(
  hash: string,
  plain: string,
): Promise<boolean> {
  if (typeof hash !== 'string' || hash.length === 0) {
    return false;
  }
  if (
    typeof plain !== 'string' ||
    plain.length < PASSWORD_MIN_LENGTH ||
    plain.length > PASSWORD_MAX_LENGTH
  ) {
    return false;
  }
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // Never propagate internal errors; never include `hash` or `plain` in
    // any error path. Always collapse to `false`.
    return false;
  }
}

/**
 * Returns `true` when the supplied encoded hash was produced with Argon2id
 * parameters weaker than the current `ARGON2ID_PARAMS`, signalling the
 * caller should rehash on next successful login.
 *
 * Returns `true` for unparseable / non-Argon2id hashes so they get rotated
 * on the next opportunity.
 */
export function needsRehash(hash: string): boolean {
  if (typeof hash !== 'string' || hash.length === 0) {
    return true;
  }
  try {
    return argon2.needsRehash(hash, NEEDS_REHASH_PARAMS);
  } catch {
    return true;
  }
}

/**
 * Pre-computed Argon2id hash of a random, throwaway plaintext using the
 * current `ARGON2ID_PARAMS`. Used by `dummyVerify` so that the
 * "user not found" code path performs a real Argon2id verification with
 * the same cost as a real password check, eliminating the timing oracle
 * an attacker could otherwise use to enumerate accounts.
 *
 * Generated once on module load. The plaintext is never exposed and the
 * hash is never compared against any user-supplied value successfully.
 */
const DUMMY_PLAINTEXT_BYTES = 32;
let dummyHashPromise: Promise<string> | null = null;

function getDummyHash(): Promise<string> {
  if (dummyHashPromise === null) {
    // Lazily computed on first use to avoid blocking module import.
    // Synchronous `crypto.randomBytes` keeps the promise allocation simple
    // and the bytes are immediately discarded after hashing.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomBytes } = require('crypto') as typeof import('crypto');
    const throwaway = randomBytes(DUMMY_PLAINTEXT_BYTES).toString('base64');
    dummyHashPromise = argon2.hash(throwaway, ARGON2ID_PARAMS);
  }
  return dummyHashPromise;
}

/**
 * Run a real Argon2id verification against a throwaway hash to consume the
 * same CPU/memory budget as `verifyPassword`, then return `false`.
 *
 * Call this from authentication paths where the supplied identity does not
 * resolve to a stored `password_hash` (unknown email, OAuth-only user, etc.)
 * so that the response timing is indistinguishable from a wrong-password
 * outcome (R1.6, R1.9).
 *
 * Always returns `false`. Errors are swallowed for the same reason
 * `verifyPassword` swallows them.
 */
export async function dummyVerify(plain: string): Promise<false> {
  try {
    const hash = await getDummyHash();
    // We pass a placeholder when `plain` is not a usable string so the
    // call still performs the same Argon2id work; the result is discarded.
    const candidate = typeof plain === 'string' && plain.length > 0 ? plain : '\0';
    await argon2.verify(hash, candidate);
  } catch {
    // Intentionally ignored — see file-header notes.
  }
  return false;
}
