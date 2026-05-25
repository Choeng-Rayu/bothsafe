/**
 * SessionService unit tests.
 *
 * Source of truth: tasks.md §4.4; design §"AuthService"; R1.2, R1.9.
 *
 * These tests exercise the service surface against an in-memory fake of
 * the `Session` table that the real implementation reaches for via
 * `PrismaService`. The fake is intentionally minimal — it implements
 * exactly the four delegate calls SessionService uses
 * (`session.create`, `session.findUnique`, `session.update`,
 * `session.delete`) — so each assertion talks about the row that would
 * be persisted, not call counts.
 *
 * Why a fake (not a Prisma test container)? The TTL / hashing / sliding
 * logic is pure and database-agnostic; we want to keep the spec fast
 * and deterministic. Round-trip integration with the real schema is
 * already covered by the migration tests (task 2.11) and will be
 * covered end-to-end by the AuthService specs (task 4.9).
 */

import type { ConfigService } from '@nestjs/config';
import { Prisma, type Session } from '@prisma/client';

import { hashToken } from '../common/tokens';
import { SessionService } from './session.service';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Subset of the `Session` columns the service touches. Aligning with the
 * real model lets us cast the fake row to `Session` without `any` while
 * keeping the test setup small.
 */
function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date();
  return {
    id: 'sess_id_default',
    user_id: 'user_id_default',
    token_hash: 'hash_default',
    expires_at: new Date(now.getTime() + 60_000),
    revoked_at: null,
    created_at: now,
    user_agent: null,
    ip_inet: null,
    ...overrides,
  } as Session;
}

interface FakeSessionDelegate {
  rows: Map<string, Session>;
  create: jest.Mock;
  findUnique: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
}

function makeFakeSessionDelegate(): FakeSessionDelegate {
  const rows = new Map<string, Session>();

  const create = jest.fn(async ({ data }: { data: Prisma.SessionUncheckedCreateInput }) => {
    const row = makeSession({
      id: `sess_${rows.size + 1}`,
      user_id: data.user_id,
      token_hash: data.token_hash,
      expires_at: new Date(data.expires_at as Date),
      revoked_at: null,
      user_agent: (data.user_agent as string | null) ?? null,
      ip_inet: (data.ip_inet as string | null) ?? null,
      created_at: new Date(),
    });
    rows.set(row.token_hash, row);
    return row;
  });

  const findUnique = jest.fn(async ({ where }: { where: { token_hash: string } }) => {
    return rows.get(where.token_hash) ?? null;
  });

  const update = jest.fn(
    async ({ where, data }: { where: { id: string }; data: { expires_at: Date } }) => {
      const found = [...rows.values()].find((r) => r.id === where.id);
      if (!found) {
        throw new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
          code: 'P2025',
          clientVersion: 'test',
        });
      }
      const updated = { ...found, expires_at: data.expires_at };
      rows.set(found.token_hash, updated);
      return updated;
    },
  );

  const del = jest.fn(async ({ where }: { where: { token_hash: string } }) => {
    const existed = rows.delete(where.token_hash);
    if (!existed) {
      throw new Prisma.PrismaClientKnownRequestError('Record to delete does not exist.', {
        code: 'P2025',
        clientVersion: 'test',
      });
    }
    return undefined;
  });

  return {
    rows,
    create,
    findUnique,
    update,
    delete: del,
  };
}

function makeFakePrisma(delegate: FakeSessionDelegate) {
  return { session: delegate } as never;
}

function makeFakeConfig(ttlDays = 1): ConfigService {
  return {
    get: jest.fn((key: string) => {
      if (key === 'session.ttlDays') return ttlDays;
      return undefined;
    }),
  } as unknown as ConfigService;
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

describe('SessionService', () => {
  describe('issueSession', () => {
    it('persists a SHA-256 hash of the raw token and returns the raw value', async () => {
      const delegate = makeFakeSessionDelegate();
      const svc = new SessionService(makeFakePrisma(delegate), makeFakeConfig(1));

      const { rawToken, sessionRow } = await svc.issueSession('user_a');

      expect(typeof rawToken).toBe('string');
      expect(rawToken.length).toBeGreaterThanOrEqual(16);
      expect(sessionRow.token_hash).toBe(hashToken(rawToken));
      // Raw value MUST NOT be persisted (R1.9).
      expect([...delegate.rows.values()]).toHaveLength(1);
      expect([...delegate.rows.values()][0].token_hash).not.toContain(rawToken);
    });

    it('sets expires_at = now + sessionTtlMs (R1.2)', async () => {
      const delegate = makeFakeSessionDelegate();
      const svc = new SessionService(makeFakePrisma(delegate), makeFakeConfig(2));

      const before = Date.now();
      const { sessionRow } = await svc.issueSession('user_a');
      const after = Date.now();

      const ttlMs = 2 * 24 * 60 * 60 * 1000;
      expect(sessionRow.expires_at.getTime()).toBeGreaterThanOrEqual(before + ttlMs - 5);
      expect(sessionRow.expires_at.getTime()).toBeLessThanOrEqual(after + ttlMs + 5);
    });

    it('mints distinct tokens for back-to-back issuances', async () => {
      const delegate = makeFakeSessionDelegate();
      const svc = new SessionService(makeFakePrisma(delegate), makeFakeConfig(1));

      const a = await svc.issueSession('user_a');
      const b = await svc.issueSession('user_a');

      expect(a.rawToken).not.toEqual(b.rawToken);
      expect(a.sessionRow.token_hash).not.toEqual(b.sessionRow.token_hash);
    });

    it('captures requestMeta (ip, user-agent) on the row', async () => {
      const delegate = makeFakeSessionDelegate();
      const svc = new SessionService(makeFakePrisma(delegate), makeFakeConfig(1));

      const { sessionRow } = await svc.issueSession('user_a', {
        ip: '203.0.113.5',
        userAgent: 'jest-test/1.0',
      });

      expect(sessionRow.ip_inet).toBe('203.0.113.5');
      expect(sessionRow.user_agent).toBe('jest-test/1.0');
    });

    it('strips an IPv6-mapped-IPv4 prefix from the ip', async () => {
      const delegate = makeFakeSessionDelegate();
      const svc = new SessionService(makeFakePrisma(delegate), makeFakeConfig(1));

      const { sessionRow } = await svc.issueSession('user_a', {
        ip: '::ffff:198.51.100.7',
      });

      expect(sessionRow.ip_inet).toBe('198.51.100.7');
    });

    it('coerces missing meta to null', async () => {
      const delegate = makeFakeSessionDelegate();
      const svc = new SessionService(makeFakePrisma(delegate), makeFakeConfig(1));

      const { sessionRow } = await svc.issueSession('user_a');

      expect(sessionRow.ip_inet).toBeNull();
      expect(sessionRow.user_agent).toBeNull();
    });
  });

  describe('findActiveSession', () => {
    it('returns the row for a live token', async () => {
      const delegate = makeFakeSessionDelegate();
      const svc = new SessionService(makeFakePrisma(delegate), makeFakeConfig(1));

      const { rawToken } = await svc.issueSession('user_a');
      const found = await svc.findActiveSession(rawToken);

      expect(found).not.toBeNull();
      expect(found!.user_id).toBe('user_a');
    });

    it('returns null for an expired token', async () => {
      const delegate = makeFakeSessionDelegate();
      const svc = new SessionService(makeFakePrisma(delegate), makeFakeConfig(1));

      const { rawToken, sessionRow } = await svc.issueSession('user_a');
      // Expire it manually.
      delegate.rows.set(sessionRow.token_hash, {
        ...sessionRow,
        expires_at: new Date(Date.now() - 1_000),
      });

      const found = await svc.findActiveSession(rawToken);
      expect(found).toBeNull();
    });

    it('returns null for a revoked token', async () => {
      const delegate = makeFakeSessionDelegate();
      const svc = new SessionService(makeFakePrisma(delegate), makeFakeConfig(1));

      const { rawToken, sessionRow } = await svc.issueSession('user_a');
      delegate.rows.set(sessionRow.token_hash, {
        ...sessionRow,
        revoked_at: new Date(),
      });

      const found = await svc.findActiveSession(rawToken);
      expect(found).toBeNull();
    });

    it('returns null for empty / non-string input without hitting the DB', async () => {
      const delegate = makeFakeSessionDelegate();
      const svc = new SessionService(makeFakePrisma(delegate), makeFakeConfig(1));

      // @ts-expect-error - exercising runtime contract
      await expect(svc.findActiveSession(undefined)).resolves.toBeNull();
      await expect(svc.findActiveSession('')).resolves.toBeNull();
      expect(delegate.findUnique).not.toHaveBeenCalled();
    });

    it('returns null for an unknown token', async () => {
      const delegate = makeFakeSessionDelegate();
      const svc = new SessionService(makeFakePrisma(delegate), makeFakeConfig(1));

      await svc.issueSession('user_a');
      const found = await svc.findActiveSession('not-a-real-token');
      expect(found).toBeNull();
    });
  });

  describe('slideExpiry', () => {
    it('extends expires_at to now + ttl (R1.2 sliding window)', async () => {
      const delegate = makeFakeSessionDelegate();
      const svc = new SessionService(makeFakePrisma(delegate), makeFakeConfig(1));

      const { sessionRow } = await svc.issueSession('user_a');
      // Move the existing row's expiry into the past to make the slide
      // observably move it forward.
      delegate.rows.set(sessionRow.token_hash, {
        ...sessionRow,
        expires_at: new Date(Date.now() + 5_000),
      });

      const before = Date.now();
      const slid = await svc.slideExpiry({ ...sessionRow, expires_at: new Date(Date.now() + 5_000) });
      const after = Date.now();

      const ttlMs = 24 * 60 * 60 * 1000;
      expect(slid.expires_at.getTime()).toBeGreaterThanOrEqual(before + ttlMs - 5);
      expect(slid.expires_at.getTime()).toBeLessThanOrEqual(after + ttlMs + 5);
    });
  });

  describe('revokeSession', () => {
    it('returns true and removes the row for a known token', async () => {
      const delegate = makeFakeSessionDelegate();
      const svc = new SessionService(makeFakePrisma(delegate), makeFakeConfig(1));

      const { rawToken } = await svc.issueSession('user_a');
      expect(delegate.rows.size).toBe(1);

      await expect(svc.revokeSession(rawToken)).resolves.toBe(true);
      expect(delegate.rows.size).toBe(0);
    });

    it('returns false for an unknown token (no throw)', async () => {
      const delegate = makeFakeSessionDelegate();
      const svc = new SessionService(makeFakePrisma(delegate), makeFakeConfig(1));

      await expect(svc.revokeSession('never-issued')).resolves.toBe(false);
    });

    it('returns false for empty input without hitting the DB', async () => {
      const delegate = makeFakeSessionDelegate();
      const svc = new SessionService(makeFakePrisma(delegate), makeFakeConfig(1));

      await expect(svc.revokeSession('')).resolves.toBe(false);
      // @ts-expect-error - exercising runtime contract
      await expect(svc.revokeSession(undefined)).resolves.toBe(false);
      expect(delegate.delete).not.toHaveBeenCalled();
    });

    it('rethrows non-P2025 errors', async () => {
      const delegate = makeFakeSessionDelegate();
      const svc = new SessionService(makeFakePrisma(delegate), makeFakeConfig(1));

      const boom = new Prisma.PrismaClientKnownRequestError('connection lost', {
        code: 'P2002',
        clientVersion: 'test',
      });
      delegate.delete.mockRejectedValueOnce(boom);

      await expect(svc.revokeSession('any-token-string-here')).rejects.toBe(boom);
    });
  });

  describe('sessionTtlMs', () => {
    it('exposes the configured TTL in ms', () => {
      const svc = new SessionService(
        makeFakePrisma(makeFakeSessionDelegate()),
        makeFakeConfig(7),
      );
      expect(svc.sessionTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('clamps a non-positive TTL to 1 day', () => {
      const svc = new SessionService(
        makeFakePrisma(makeFakeSessionDelegate()),
        makeFakeConfig(0),
      );
      expect(svc.sessionTtlMs).toBe(24 * 60 * 60 * 1000);
    });
  });
});
