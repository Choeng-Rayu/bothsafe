/**
 * Unit tests for the argon2id password wrapper (task 3.5).
 *
 * These exercise the wrapper's contract: round-tripping, length bounds,
 * malformed-input safety, the dummy-verify timing helper, and the rehash
 * detector. End-to-end auth-flow timing properties belong to task 4.9.
 */

import {
  ARGON2ID_PARAMS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  dummyVerify,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password';

// Argon2id with m=64MiB is intentionally slow. Give Jest plenty of headroom
// so a cold worker doesn't flake on the first hash call.
jest.setTimeout(30_000);

describe('password (argon2id wrapper)', () => {
  describe('ARGON2ID_PARAMS', () => {
    it('uses m=64MiB, t=3, p=4, hashLength=32 (design "Password hashing")', () => {
      expect(ARGON2ID_PARAMS.memoryCost).toBe(65536);
      expect(ARGON2ID_PARAMS.timeCost).toBe(3);
      expect(ARGON2ID_PARAMS.parallelism).toBe(4);
      expect(ARGON2ID_PARAMS.hashLength).toBe(32);
    });

    it('is frozen so callers cannot weaken the cost at runtime', () => {
      expect(Object.isFrozen(ARGON2ID_PARAMS)).toBe(true);
    });
  });

  describe('hashPassword', () => {
    it('produces an argon2id-encoded hash that verifies against the same plaintext', async () => {
      const hash = await hashPassword('correct horse battery');
      expect(hash.startsWith('$argon2id$')).toBe(true);
      await expect(verifyPassword(hash, 'correct horse battery')).resolves.toBe(true);
    });

    it('produces distinct hashes for the same plaintext (random salt)', async () => {
      const a = await hashPassword('correct horse battery');
      const b = await hashPassword('correct horse battery');
      expect(a).not.toEqual(b);
    });

    it('rejects passwords shorter than PASSWORD_MIN_LENGTH (R1.4)', async () => {
      const tooShort = 'a'.repeat(PASSWORD_MIN_LENGTH - 1);
      await expect(hashPassword(tooShort)).rejects.toThrow('auth.invalid_password_length');
    });

    it('rejects passwords longer than PASSWORD_MAX_LENGTH (R1.4)', async () => {
      const tooLong = 'a'.repeat(PASSWORD_MAX_LENGTH + 1);
      await expect(hashPassword(tooLong)).rejects.toThrow('auth.invalid_password_length');
    });

    it('rejects non-string inputs without echoing them', async () => {
      // @ts-expect-error - intentionally exercising a runtime contract
      await expect(hashPassword(undefined)).rejects.toThrow('auth.invalid_password_length');
      // @ts-expect-error - intentionally exercising a runtime contract
      await expect(hashPassword(123)).rejects.toThrow('auth.invalid_password_length');
    });
  });

  describe('verifyPassword', () => {
    it('returns false for a wrong password', async () => {
      const hash = await hashPassword('correct horse battery');
      await expect(verifyPassword(hash, 'wrong horse battery')).resolves.toBe(false);
    });

    it('returns false for an empty / non-string hash', async () => {
      await expect(verifyPassword('', 'irrelevant_pw')).resolves.toBe(false);
      // @ts-expect-error - exercising runtime contract
      await expect(verifyPassword(undefined, 'irrelevant_pw')).resolves.toBe(false);
    });

    it('returns false for malformed hash strings instead of throwing', async () => {
      await expect(verifyPassword('not-a-real-hash', 'irrelevant_pw')).resolves.toBe(false);
    });

    it('returns false when plaintext is out of allowed length range', async () => {
      const hash = await hashPassword('correct horse battery');
      await expect(verifyPassword(hash, 'short')).resolves.toBe(false);
      await expect(verifyPassword(hash, 'a'.repeat(PASSWORD_MAX_LENGTH + 1))).resolves.toBe(false);
    });
  });

  describe('dummyVerify', () => {
    it('always resolves to false', async () => {
      await expect(dummyVerify('anything')).resolves.toBe(false);
      await expect(dummyVerify('')).resolves.toBe(false);
      // @ts-expect-error - exercising runtime contract
      await expect(dummyVerify(undefined)).resolves.toBe(false);
    });

    it('takes time on the same order as a real verify (timing-attack mitigation, R1.6/R1.9)', async () => {
      // Warm up the dummy hash and the libargon2 worker pool so we measure
      // steady-state cost, not first-call init overhead.
      await dummyVerify('warmup');
      const realHash = await hashPassword('correct horse battery');
      await verifyPassword(realHash, 'correct horse battery');

      const realStart = Date.now();
      await verifyPassword(realHash, 'correct horse battery');
      const realDuration = Date.now() - realStart;

      const dummyStart = Date.now();
      await dummyVerify('correct horse battery');
      const dummyDuration = Date.now() - dummyStart;

      // We don't assert exact equality (host noise + GC make that flaky);
      // we just assert the dummy path does real argon2id work — i.e. it
      // takes at least 25% of a real verify's wall time. This catches any
      // future regression that downgrades dummyVerify to a fast no-op.
      expect(dummyDuration).toBeGreaterThanOrEqual(Math.max(1, Math.floor(realDuration * 0.25)));
    });
  });

  describe('needsRehash', () => {
    it('returns false for a freshly hashed password using current params', async () => {
      const hash = await hashPassword('correct horse battery');
      expect(needsRehash(hash)).toBe(false);
    });

    it('returns true for empty / non-string / unparseable hashes', () => {
      expect(needsRehash('')).toBe(true);
      // @ts-expect-error - exercising runtime contract
      expect(needsRehash(undefined)).toBe(true);
      expect(needsRehash('not-a-real-hash')).toBe(true);
    });
  });
});
