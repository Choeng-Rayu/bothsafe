/**
 * AuditService unit tests.
 *
 * Source of truth: tasks.md §3.9; design §"AuditService"; R20.1–R20.4.
 *
 * These tests exercise the service surface with an in-memory fake of the
 * `Prisma.TransactionClient` it consumes. We deliberately avoid mocking
 * the entire `PrismaClient` because the service deliberately depends on
 * **only** the transaction client — that is the contract we are
 * verifying. The fake records the `data` argument passed to
 * `tx.auditLogEntry.create(...)` so each test asserts on the row that
 * would be written rather than on call counts.
 */

import { Prisma } from '@prisma/client';
import { Decimal } from 'decimal.js';

import { Currency, DealStatus, ParticipantRole } from '../common/enums';
import { AuditService, type NewAuditLogEntry } from './audit.service';

/**
 * Minimal `Prisma.TransactionClient`-shaped stub. We narrow to the single
 * method the service uses (`auditLogEntry.create`) so the test stays
 * legible — the cast back to `Prisma.TransactionClient` is safe because
 * the service never reaches for any other delegate.
 */
type AuditCreateArgs = Parameters<Prisma.TransactionClient['auditLogEntry']['create']>[0];

interface FakeTx {
  auditLogEntry: {
    create: jest.Mock<Promise<unknown>, [AuditCreateArgs]>;
  };
  /** Captured `data` payloads, oldest-first. */
  captured: NonNullable<AuditCreateArgs['data']>[];
}

function makeFakeTx(opts: { throwOnCreate?: Error } = {}): FakeTx {
  const captured: FakeTx['captured'] = [];
  const create = jest.fn(async (args: AuditCreateArgs) => {
    if (opts.throwOnCreate) throw opts.throwOnCreate;
    captured.push(args.data);
    // We don't model the returned row — the service ignores it.
    return undefined;
  });

  return {
    auditLogEntry: { create } as FakeTx['auditLogEntry'],
    captured,
  };
}

function asTx(fake: FakeTx): Prisma.TransactionClient {
  return fake as unknown as Prisma.TransactionClient;
}

describe('AuditService', () => {
  let service: AuditService;

  beforeEach(() => {
    service = new AuditService();
  });

  describe('record() — `tx` contract (tasks.md §3.9)', () => {
    it('throws synchronously when `tx` is null', async () => {
      const entry: NewAuditLogEntry = { action_type: 'DEAL_STATUS_TRANSITION' };

      await expect(
        service.record(entry, null as unknown as Prisma.TransactionClient),
      ).rejects.toThrow(/tx is required/i);
    });

    it('throws synchronously when `tx` is undefined', async () => {
      const entry: NewAuditLogEntry = { action_type: 'DEAL_STATUS_TRANSITION' };

      await expect(
        service.record(entry, undefined as unknown as Prisma.TransactionClient),
      ).rejects.toThrow(/tx is required/i);
    });

    it('mentions R20.4 in the missing-tx error so the contract is discoverable from the stack trace', async () => {
      const entry: NewAuditLogEntry = { action_type: 'WALLET_PAYMENT' };

      await expect(
        service.record(entry, undefined as unknown as Prisma.TransactionClient),
      ).rejects.toThrow(/R20\.4/);
    });
  });

  describe('record() — happy path (R20.1–R20.3)', () => {
    it('persists every column when the caller supplies a complete entry', async () => {
      const fake = makeFakeTx();
      const entry: NewAuditLogEntry = {
        action_type: 'DEAL_STATUS_TRANSITION',
        actor_user_id: 'user_abc',
        actor_role: ParticipantRole.buyer,
        deal_id: 'deal_xyz',
        withdrawal_id: null,
        amount: new Decimal('123.45'),
        currency: Currency.USD,
        prev_status: DealStatus.READY_FOR_PAYMENT,
        new_status: DealStatus.PAID_ESCROWED,
        metadata: { note: 'wallet payment' },
      };

      await service.record(entry, asTx(fake));

      expect(fake.captured).toHaveLength(1);
      const row = fake.captured[0];
      expect(row.action_type).toBe('DEAL_STATUS_TRANSITION');
      expect(row.actor_user_id).toBe('user_abc');
      expect(row.actor_role).toBe(ParticipantRole.buyer);
      expect(row.deal_id).toBe('deal_xyz');
      expect(row.withdrawal_id).toBeNull();
      // Decimal passes through verbatim — Prisma maps to Decimal(18,2).
      expect((row.amount as Decimal).toString()).toBe('123.45');
      expect(row.currency).toBe(Currency.USD);
      expect(row.prev_status).toBe(DealStatus.READY_FOR_PAYMENT);
      expect(row.new_status).toBe(DealStatus.PAID_ESCROWED);
      expect(row.metadata).toEqual({ note: 'wallet payment' });
    });

    it('coerces undefined optional fields to null and missing metadata to Prisma.JsonNull', async () => {
      const fake = makeFakeTx();
      const entry: NewAuditLogEntry = { action_type: 'WITHDRAWAL_HOLD' };

      await service.record(entry, asTx(fake));

      const row = fake.captured[0];
      expect(row.action_type).toBe('WITHDRAWAL_HOLD');
      expect(row.actor_user_id).toBeNull();
      expect(row.actor_role).toBeNull();
      expect(row.deal_id).toBeNull();
      expect(row.withdrawal_id).toBeNull();
      expect(row.amount).toBeNull();
      expect(row.currency).toBeNull();
      expect(row.prev_status).toBeNull();
      expect(row.new_status).toBeNull();
      // Prisma rejects raw `null` on optional Json columns; we coerce to
      // Prisma.JsonNull so the DB receives SQL NULL.
      expect(row.metadata).toBe(Prisma.JsonNull);
    });

    it('accepts amount as a number or string and forwards verbatim', async () => {
      const fake = makeFakeTx();

      await service.record(
        { action_type: 'WALLET_PAYMENT', amount: 10 },
        asTx(fake),
      );
      await service.record(
        { action_type: 'WALLET_PAYMENT', amount: '20.00' },
        asTx(fake),
      );

      expect(fake.captured[0].amount).toBe(10);
      expect(fake.captured[1].amount).toBe('20.00');
    });

    it('does not return the inserted row (audit ids are internal)', async () => {
      const fake = makeFakeTx();
      const result = await service.record(
        { action_type: 'WALLET_PAYMENT' },
        asTx(fake),
      );
      expect(result).toBeUndefined();
    });
  });

  describe('record() — failure propagation (R20.4)', () => {
    it('lets DB-side errors bubble up so the caller `$transaction` rolls back', async () => {
      const dbError = new Error('audit_log_entry constraint violation');
      const fake = makeFakeTx({ throwOnCreate: dbError });
      const entry: NewAuditLogEntry = { action_type: 'WALLET_PAYMENT' };

      await expect(service.record(entry, asTx(fake))).rejects.toBe(dbError);
    });

    it('does not swallow append-only trigger rejections (defence in depth)', async () => {
      // If a misconfigured environment ever lets the service reach the DB
      // with an UPDATE/DELETE-shaped statement, the `reject_mutation()`
      // trigger raises. We model that as an arbitrary rejection here and
      // assert the service surfaces it untouched.
      const triggerError = new Error('audit_log_entry is append-only');
      const fake = makeFakeTx({ throwOnCreate: triggerError });

      await expect(
        service.record({ action_type: 'WALLET_PAYMENT' }, asTx(fake)),
      ).rejects.toBe(triggerError);
    });
  });
});
