/**
 * IdempotencyMiddleware unit tests.
 *
 * Covers the spec from tasks.md §3.8 + design §"Idempotency":
 *
 *   • No-op on non-mutating methods (GET/HEAD/OPTIONS).
 *   • No-op when the `Idempotency-Key` header is absent or malformed.
 *   • No-op when no authenticated user is on the request.
 *   • First call: insert the row with the request fingerprint, run the
 *     handler, capture the response, and replay it on retry.
 *   • Retry with matching hash: replay the cached response without
 *     invoking the handler.
 *   • Retry with mismatching hash: respond 409
 *     `request.idempotency_conflict` without invoking the handler.
 *   • Concurrent first-call race: the loser's `P2002` is swallowed and
 *     the request is treated as a retry.
 *
 * The tests use an in-memory fake of `PrismaService.idempotencyKey`
 * (the only delegate the middleware touches). This keeps the suite fast
 * and avoids spinning up Postgres while still exercising every branch of
 * the middleware's control flow against a realistic API surface.
 */

import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

import type { PrismaService } from '../prisma';
import {
  DEFAULT_TTL_MS,
  IDEMPOTENCY_HEADER,
  buildMiddlewareScope,
} from './idempotency.constants';
import { IdempotencyMiddleware } from './idempotency.middleware';

// ---------- Fakes -----------------------------------------------------------

interface CachedRow {
  scope: string;
  key: string;
  user_id: string;
  request_hash: string | null;
  route: string | null;
  response_status: number | null;
  response_body: Prisma.JsonValue | null;
  expires_at: Date;
  created_at: Date;
}

/**
 * In-memory stand-in for the subset of `PrismaService.idempotencyKey`
 * the middleware uses (`findUnique`, `create`, `update`). Behaves
 * realistically for the composite primary key — `create` raises a
 * Prisma `P2002` when the same `(scope, key, user_id)` triple is
 * inserted twice.
 */
class FakeIdempotencyTable {
  private readonly rows = new Map<string, CachedRow>();

  private rowKey(scope: string, key: string, userId: string): string {
    return `${scope}\u0000${key}\u0000${userId}`;
  }

  reset(): void {
    this.rows.clear();
  }

  seed(row: CachedRow): void {
    this.rows.set(this.rowKey(row.scope, row.key, row.user_id), row);
  }

  size(): number {
    return this.rows.size;
  }

  // Prisma 7-shaped delegate. The middleware passes a strict
  // `findUnique({ where: { scope_key_user_id: { ... } } })` shape — we
  // mirror it.
  findUnique = jest.fn(
    async (args: {
      where: { scope_key_user_id: { scope: string; key: string; user_id: string } };
      select?: Record<string, true>;
    }) => {
      const { scope, key, user_id } = args.where.scope_key_user_id;
      const row = this.rows.get(this.rowKey(scope, key, user_id));
      return row ?? null;
    },
  );

  create = jest.fn(async (args: { data: Omit<CachedRow, 'created_at'> & Partial<Pick<CachedRow, 'created_at'>> }) => {
    const data = args.data;
    const k = this.rowKey(data.scope, data.key, data.user_id);
    if (this.rows.has(k)) {
      throw new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        { code: 'P2002', clientVersion: 'test', meta: { target: ['scope', 'key', 'user_id'] } },
      );
    }
    const row: CachedRow = {
      scope: data.scope,
      key: data.key,
      user_id: data.user_id,
      request_hash: data.request_hash ?? null,
      route: data.route ?? null,
      response_status: data.response_status ?? null,
      response_body: (data.response_body ?? null) as Prisma.JsonValue | null,
      expires_at: data.expires_at as Date,
      created_at: data.created_at ?? new Date(),
    };
    this.rows.set(k, row);
    return row;
  });

  update = jest.fn(
    async (args: {
      where: { scope_key_user_id: { scope: string; key: string; user_id: string } };
      data: Partial<CachedRow>;
    }) => {
      const { scope, key, user_id } = args.where.scope_key_user_id;
      const k = this.rowKey(scope, key, user_id);
      const row = this.rows.get(k);
      if (!row) {
        throw new Prisma.PrismaClientKnownRequestError('Record not found', {
          code: 'P2025',
          clientVersion: 'test',
        });
      }
      const next: CachedRow = { ...row, ...args.data } as CachedRow;
      this.rows.set(k, next);
      return next;
    },
  );
}

function makePrisma(table: FakeIdempotencyTable): PrismaService {
  return { idempotencyKey: table } as unknown as PrismaService;
}

// ---------- Request / response factories -----------------------------------

function makeReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  userId?: string | null;
}): Request {
  return {
    method: opts.method ?? 'POST',
    originalUrl: opts.url ?? '/v1/deals',
    url: opts.url ?? '/v1/deals',
    headers: opts.headers ?? {},
    body: opts.body,
    user: opts.userId ? { id: opts.userId } : undefined,
  } as unknown as Request;
}

function makeRes(): {
  res: Response;
  capturedStatus: () => number;
  capturedBody: () => unknown;
} {
  let status = 200;
  let body: unknown = undefined;
  let headersSent = false;
  const fake = {
    statusCode: 200 as number,
    get headersSent() {
      return headersSent;
    },
    status(this: { statusCode: number }, code: number) {
      status = code;
      this.statusCode = code;
      return fake;
    },
    json(payload: unknown) {
      body = payload;
      headersSent = true;
      return fake;
    },
  };
  return {
    res: fake as unknown as Response,
    capturedStatus: () => status,
    capturedBody: () => body,
  };
}

// Helper: wait for fire-and-forget update.then() chain to settle.
const flushMicrotasks = () => new Promise((r) => setImmediate(r));

// ---------- Tests -----------------------------------------------------------

describe('IdempotencyMiddleware', () => {
  let table: FakeIdempotencyTable;
  let middleware: IdempotencyMiddleware;
  let next: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    table = new FakeIdempotencyTable();
    middleware = new IdempotencyMiddleware(makePrisma(table));
    next = jest.fn();
  });

  describe('skip rules', () => {
    it('passes GET/HEAD/OPTIONS through unchanged', async () => {
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        const req = makeReq({
          method,
          headers: { [IDEMPOTENCY_HEADER]: 'k' },
          userId: 'u_1',
        });
        const { res } = makeRes();
        await middleware.use(req, res, next);
      }
      expect(next).toHaveBeenCalledTimes(3);
      expect(table.findUnique).not.toHaveBeenCalled();
      expect(table.create).not.toHaveBeenCalled();
    });

    it('passes POST without Idempotency-Key through unchanged', async () => {
      const req = makeReq({ method: 'POST', userId: 'u_1' });
      const { res } = makeRes();
      await middleware.use(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(table.findUnique).not.toHaveBeenCalled();
    });

    it('passes POST with blank Idempotency-Key through unchanged', async () => {
      const req = makeReq({
        method: 'POST',
        headers: { [IDEMPOTENCY_HEADER]: '   ' },
        userId: 'u_1',
      });
      const { res } = makeRes();
      await middleware.use(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(table.findUnique).not.toHaveBeenCalled();
    });

    it('passes POST without an authenticated user through unchanged', async () => {
      const req = makeReq({
        method: 'POST',
        headers: { [IDEMPOTENCY_HEADER]: 'k' },
        userId: null,
      });
      const { res } = makeRes();
      await middleware.use(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(table.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('first call', () => {
    it('inserts a pending row, runs the handler, and captures the response on success', async () => {
      const req = makeReq({
        method: 'POST',
        url: '/v1/deals',
        headers: { [IDEMPOTENCY_HEADER]: 'k1' },
        body: { name: 'a' },
        userId: 'u_1',
      });
      const { res, capturedStatus, capturedBody } = makeRes();

      // Simulate a controller: when next() is called, write a 201 JSON.
      next.mockImplementation(() => {
        res.status(HttpStatus.CREATED).json({ id: 'deal_1' });
      });

      await middleware.use(req, res, next);

      // First call -> inserted exactly once.
      expect(table.create).toHaveBeenCalledTimes(1);
      const inserted = table.create.mock.calls[0][0].data;
      expect(inserted.scope).toBe(buildMiddlewareScope('POST', '/v1/deals'));
      expect(inserted.key).toBe('k1');
      expect(inserted.user_id).toBe('u_1');
      expect(inserted.request_hash).toEqual(expect.any(String));
      expect(inserted.expires_at).toBeInstanceOf(Date);
      const ttl = inserted.expires_at!.getTime() - Date.now();
      expect(ttl).toBeGreaterThan(DEFAULT_TTL_MS - 1000);
      expect(ttl).toBeLessThanOrEqual(DEFAULT_TTL_MS);

      // Handler ran exactly once.
      expect(next).toHaveBeenCalledTimes(1);
      expect(capturedStatus()).toBe(HttpStatus.CREATED);
      expect(capturedBody()).toEqual({ id: 'deal_1' });

      // Response capture persisted to the row (fire-and-forget update).
      await flushMicrotasks();
      expect(table.update).toHaveBeenCalledTimes(1);
      const updated = table.update.mock.calls[0][0].data;
      expect(updated.response_status).toBe(HttpStatus.CREATED);
      expect(updated.response_body).toEqual({ id: 'deal_1' });
    });

    it('does not cache 5xx responses', async () => {
      const req = makeReq({
        method: 'POST',
        headers: { [IDEMPOTENCY_HEADER]: 'k1' },
        userId: 'u_1',
      });
      const { res } = makeRes();
      next.mockImplementation(() => {
        res.status(503).json({ error: 'oops' });
      });

      await middleware.use(req, res, next);
      await flushMicrotasks();

      expect(table.create).toHaveBeenCalledTimes(1);
      // Update is NOT called for 5xx — server errors must not be replayed.
      expect(table.update).not.toHaveBeenCalled();
    });
  });

  describe('retry with matching hash', () => {
    it('replays the cached response without invoking the handler', async () => {
      // Seed a completed cache row.
      const scope = buildMiddlewareScope('POST', '/v1/deals/abc/confirm-received');
      const requestHash = await firstCallHashFor({
        method: 'POST',
        url: '/v1/deals/abc/confirm-received',
        body: { idempotency_key: 'k1' },
      });
      table.seed({
        scope,
        key: 'k1',
        user_id: 'u_1',
        request_hash: requestHash,
        route: '/v1/deals/abc/confirm-received',
        response_status: 200,
        response_body: { status: 'RELEASE_PENDING' },
        expires_at: new Date(Date.now() + 60_000),
        created_at: new Date(Date.now() - 60_000),
      });

      const req = makeReq({
        method: 'POST',
        url: '/v1/deals/abc/confirm-received',
        headers: { [IDEMPOTENCY_HEADER]: 'k1' },
        body: { idempotency_key: 'k1' },
        userId: 'u_1',
      });
      const { res, capturedStatus, capturedBody } = makeRes();

      await middleware.use(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(capturedStatus()).toBe(200);
      expect(capturedBody()).toEqual({ status: 'RELEASE_PENDING' });
      expect(table.create).not.toHaveBeenCalled();
    });
  });

  describe('retry with mismatching hash', () => {
    it('responds 409 request.idempotency_conflict without invoking the handler', async () => {
      const scope = buildMiddlewareScope('POST', '/v1/deals');
      table.seed({
        scope,
        key: 'k1',
        user_id: 'u_1',
        request_hash: 'deadbeef',
        route: '/v1/deals',
        response_status: 201,
        response_body: { id: 'deal_1' },
        expires_at: new Date(Date.now() + 60_000),
        created_at: new Date(),
      });

      const req = makeReq({
        method: 'POST',
        url: '/v1/deals',
        headers: { [IDEMPOTENCY_HEADER]: 'k1' },
        body: { name: 'different' },
        userId: 'u_1',
      });
      const { res, capturedStatus, capturedBody } = makeRes();

      await middleware.use(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(capturedStatus()).toBe(HttpStatus.CONFLICT);
      const body = capturedBody() as { error: { code: string } };
      expect(body.error.code).toBe('request.idempotency_conflict');
    });
  });

  describe('expired rows', () => {
    it('treats an expired row as a cache miss', async () => {
      const scope = buildMiddlewareScope('POST', '/v1/deals');
      table.seed({
        scope,
        key: 'k1',
        user_id: 'u_1',
        request_hash: 'whatever',
        route: '/v1/deals',
        response_status: 201,
        response_body: { id: 'old' },
        expires_at: new Date(Date.now() - 1_000), // already expired
        created_at: new Date(Date.now() - DEFAULT_TTL_MS - 1_000),
      });

      const req = makeReq({
        method: 'POST',
        url: '/v1/deals',
        headers: { [IDEMPOTENCY_HEADER]: 'k1' },
        body: { name: 'fresh' },
        userId: 'u_1',
      });
      const { res } = makeRes();
      next.mockImplementation(() => {
        res.status(201).json({ id: 'new' });
      });

      await middleware.use(req, res, next);
      // Existing expired row hits the P2002 path on insert; the
      // middleware then re-reads — and treats it as still expired, so
      // it falls through to the handler.
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('concurrent first-call race', () => {
    it('treats a P2002 from a concurrent insert as a retry against the winner', async () => {
      // Simulate the race: the lookup misses, but `create` reports the
      // row already exists because a concurrent request won the slot.
      const scope = buildMiddlewareScope('POST', '/v1/deals');
      const winnerHash = await firstCallHashFor({
        method: 'POST',
        url: '/v1/deals',
        body: { name: 'a' },
      });

      // Seed only AFTER the first findUnique to model the race window.
      let seeded = false;
      const originalFind = table.findUnique;
      table.findUnique = jest.fn(async (args: any) => {
        if (!seeded) return null;
        return originalFind.call(table, args);
      }) as typeof table.findUnique;

      table.create = jest.fn(async () => {
        // The "winner" appears in the table the moment the loser tries
        // to insert.
        seeded = true;
        table.seed({
          scope,
          key: 'k1',
          user_id: 'u_1',
          request_hash: winnerHash,
          route: '/v1/deals',
          response_status: 201,
          response_body: { id: 'deal_1' },
          expires_at: new Date(Date.now() + 60_000),
          created_at: new Date(),
        });
        throw new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }) as unknown as typeof table.create;

      const req = makeReq({
        method: 'POST',
        url: '/v1/deals',
        headers: { [IDEMPOTENCY_HEADER]: 'k1' },
        body: { name: 'a' },
        userId: 'u_1',
      });
      const { res, capturedStatus, capturedBody } = makeRes();

      await middleware.use(req, res, next);

      // Loser does NOT run the handler; it replays the winner's response.
      expect(next).not.toHaveBeenCalled();
      expect(capturedStatus()).toBe(201);
      expect(capturedBody()).toEqual({ id: 'deal_1' });
    });
  });
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Reproduce the middleware's request fingerprint so tests can seed cache
 * rows with the same hash a real first call would produce. Mirrors the
 * `computeRequestHash` implementation by routing the request through the
 * middleware once with a no-op handler.
 */
async function firstCallHashFor(spec: {
  method: string;
  url: string;
  body?: unknown;
}): Promise<string> {
  const localTable = new FakeIdempotencyTable();
  const localMw = new IdempotencyMiddleware(makePrisma(localTable));
  const req = makeReq({
    method: spec.method,
    url: spec.url,
    headers: { [IDEMPOTENCY_HEADER]: '__hash_probe__' },
    body: spec.body,
    userId: '__probe_user__',
  });
  const { res } = makeRes();
  // No-op handler.
  await localMw.use(req, res, () => {
    res.status(200).json({});
  });
  await flushMicrotasks();
  expect(localTable.create).toHaveBeenCalledTimes(1);
  return localTable.create.mock.calls[0][0].data.request_hash as string;
}
