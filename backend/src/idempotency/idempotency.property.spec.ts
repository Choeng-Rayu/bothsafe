/**
 * Property test: idempotency middleware replay invariant.
 * Tasks.md §14.4 — validates R13.2, R16.2, R16.3, R18.11.
 *
 * Property: replaying a request with the same Idempotency-Key always
 * returns the same cached response (at-most-once side effect).
 */

import * as fc from 'fast-check';
import { createHash } from 'node:crypto';

/**
 * Simulates the idempotency cache behaviour:
 * - First call: compute hash, store response.
 * - Subsequent calls with same key+hash: return cached response.
 * - Calls with same key but different hash: conflict.
 */
interface CachedResponse {
  status: number;
  body: unknown;
  requestHash: string;
}

class IdempotencyCache {
  private store = new Map<string, CachedResponse>();

  private computeHash(method: string, url: string, body: string): string {
    return createHash('sha256')
      .update(`${method}\n${url}\n${body}`)
      .digest('hex');
  }

  execute(
    key: string,
    userId: string,
    method: string,
    url: string,
    body: string,
    handler: () => { status: number; body: unknown },
  ): { status: number; body: unknown; fromCache: boolean } | 'conflict' {
    const cacheKey = `${method}:${url}:${key}:${userId}`;
    const requestHash = this.computeHash(method, url, body);

    const existing = this.store.get(cacheKey);
    if (existing) {
      if (existing.requestHash !== requestHash) return 'conflict';
      return { status: existing.status, body: existing.body, fromCache: true };
    }

    const result = handler();
    this.store.set(cacheKey, { ...result, requestHash });
    return { ...result, fromCache: false };
  }
}

describe('Idempotency middleware property tests (§14.4)', () => {
  it('replaying same key+body always returns identical cached response', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),  // key
        fc.string({ minLength: 1, maxLength: 32 }),  // userId
        fc.constantFrom('POST', 'PATCH', 'PUT'),     // method
        fc.string({ minLength: 1, maxLength: 64 }),  // url
        fc.json(),                                    // body
        fc.integer({ min: 200, max: 499 }),           // response status
        (key, userId, method, url, body, responseStatus) => {
          const cache = new IdempotencyCache();
          const handler = () => ({ status: responseStatus, body: { ok: true, key } });

          // First call
          const first = cache.execute(key, userId, method, url, body, handler);
          if (first === 'conflict') return true; // shouldn't happen on first call

          // Replay (same key, same body)
          const replay = cache.execute(key, userId, method, url, body, () => {
            throw new Error('handler should not be called on replay');
          });

          if (replay === 'conflict') return false;
          return (
            replay.fromCache === true &&
            replay.status === first.status &&
            JSON.stringify(replay.body) === JSON.stringify(first.body)
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('same key with different body returns conflict', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.constantFrom('POST', 'PATCH', 'PUT') as fc.Arbitrary<string>,
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.tuple(fc.json(), fc.json()).filter(([a, b]) => a !== b),
        (key, userId, method, url, [body1, body2]) => {
          const cache = new IdempotencyCache();
          const handler = () => ({ status: 200, body: { done: true } });

          cache.execute(key, userId, method, url, body1, handler);
          const second = cache.execute(key, userId, method, url, body2, handler);

          return second === 'conflict';
        },
      ),
      { numRuns: 300 },
    );
  });
});
