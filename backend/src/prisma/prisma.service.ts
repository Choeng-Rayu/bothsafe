import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  type INestApplication,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Shared Prisma client for the BothSafe backend.
 *
 * **Driver adapter (Prisma 7).** Prisma 7 mandates a driver adapter; the JS
 * engine no longer reads `datasource.url` from `schema.prisma`. We therefore
 * construct a {@link PrismaPg} adapter from `process.env.DATABASE_URL` and
 * hand it to {@link PrismaClient}. The CLI (`prisma migrate`, `db pull`) gets
 * its URL from `prisma.config.ts` instead.
 *
 * **Database role.** The runtime backend MUST connect as the `app` Postgres
 * role — never as `migrator`. The `app` role has `UPDATE`, `DELETE`, and
 * `TRUNCATE` revoked on `wallet_ledger_entry` and `audit_log_entry`, with a
 * `BEFORE UPDATE OR DELETE OR TRUNCATE` trigger calling `reject_mutation()`
 * as defence-in-depth. See `backend/prisma/README.md` and design
 * §"Append-only enforcement (R14.2, R20.5)" for the full role split.
 *
 * **Shutdown.** Prisma 5+ removed `$on('beforeExit', …)` for the JS engine.
 * Graceful shutdown is handled by Nest's lifecycle hooks: `OnModuleDestroy`
 * disconnects the client, and `app.enableShutdownHooks()` in `main.ts`
 * ensures the destroy hook fires on `SIGINT` / `SIGTERM`.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set; PrismaService cannot construct the @prisma/adapter-pg driver adapter.',
      );
    }

    const adapter = new PrismaPg({ connectionString });
    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma client connected via @prisma/adapter-pg');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma client disconnected');
  }

  /**
   * Wire Nest's process-signal shutdown hooks into the application so
   * {@link onModuleDestroy} fires on `SIGINT`/`SIGTERM`.
   *
   * Prisma 5+ no longer exposes `$on('beforeExit', …)` for the JS engine, so
   * the recommended path is `app.enableShutdownHooks()` plus this service's
   * `OnModuleDestroy` implementation. Calling this method is therefore a
   * thin wrapper — `main.ts` may call `app.enableShutdownHooks()` directly
   * and skip this helper.
   */
  enableShutdownHooks(app: INestApplication): void {
    app.enableShutdownHooks();
  }

  /**
   * Run `fn` inside a Prisma interactive transaction with full type safety.
   *
   * Delegates to {@link PrismaClient.$transaction} with a typed callback so
   * call sites get autocomplete / narrowing on the `tx` client without
   * having to import {@link Prisma.TransactionClient} themselves.
   *
   * @example
   *   await prisma.runInTransaction(async (tx) => {
   *     const deal = await tx.dealRoom.update({ ... });
   *     await tx.walletLedgerEntry.create({ ... });
   *     return deal;
   *   });
   */
  runInTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(fn);
  }
}
