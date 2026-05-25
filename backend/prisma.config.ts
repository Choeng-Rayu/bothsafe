// BothSafe — Prisma 7 CLI configuration.
//
// In Prisma 7 the connection URL is supplied here rather than in the
// `datasource` block of `schema.prisma`. The Prisma CLI (`migrate`,
// `db pull`, etc.) reads this config; the runtime `PrismaClient` in
// the NestJS backend gets its URL from `DATABASE_URL` directly.
//
// Role split — see `./prisma/README.md`:
//   • DDL (`prisma migrate dev|deploy`) authenticates as the `migrator`
//     role. When `MIGRATE_DATABASE_URL` is set we use it; otherwise we
//     fall back to `DATABASE_URL` (acceptable in dev, where compose
//     bootstraps a single `bothsafe` superuser).
//   • DML (NestJS via `@prisma/client`) reads `DATABASE_URL` and must
//     authenticate as the `app` role in any environment that has the
//     append-only privilege revocation applied.

import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL,
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node --transpile-only prisma/seed.ts',
  },
});
