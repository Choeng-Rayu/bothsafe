# Backend — Agent Guide

This guide is scoped to `/backend`. For the cross-layer architecture contract (Deal Status enum, API contract, token strategy, notification events, ledger entry types), read **`../AGENTS.md`** first. For requirement IDs and acceptance criteria, see **`../.kiro/specs/bothsafe-deal-flow/{requirements,design,tasks}.md`**.

When `../AGENTS.md` and `../.kiro/specs/bothsafe-deal-flow/design.md` disagree, **`design.md` wins for the deal-flow feature** — most notably, the database is **PostgreSQL**, not MySQL.

---

## Stack

- **NestJS 11** (TypeScript, decorators, `emitDecoratorMetadata`)
- **Prisma 7.x** ORM (PostgreSQL provider)
- **PostgreSQL 16** (local Docker)
- **MinIO** for object storage (local Docker)
- **Joi** for env validation, **class-validator** for DTOs
- **`@nestjs/throttler`** for rate limiting
- **`@nestjs/jwt`** + **bcrypt** (admin); **argon2id** is specified in `design.md` for user passwords

## Current state

Bootstrapped only. The following exists:

```
src/
  app.controller.ts        ← stub "Hello World"
  app.module.ts            ← ConfigModule (with Joi validation) + ThrottlerModule
  app.service.ts
  config/
    configuration.ts       ← typed config factory
    env.validation.ts      ← Joi schema (required vars + defaults)
  main.ts                  ← /v1 URI versioning, CORS, global ValidationPipe
```

No domain modules, no Prisma schema, no migrations, no seed. The work ahead is to create the modules listed in `../AGENTS.md` (`auth`, `deal`, `invite`, `payment`, `wallet`, `khqr`, `withdrawal`, `ledger`, `shipping`, `confirmation`, `dispute`, `admin`, `notification`, `audit`, `storage`, `bot`, `prisma`) following the foundation-first order in `tasks.md`.

## Common commands

```bash
npm install
npm run start:dev          # watch mode
npm run start              # one-shot
npm run start:prod         # node dist/main
npm run build              # nest build (deletes dist first)
npm run lint               # eslint --fix on src/, apps/, libs/, test/
npm run format             # prettier --write src/ test/
npm test                   # jest, *.spec.ts under src/
npm test -- src/path/to/foo.spec.ts          # single file
npm test -- -t "fragment of describe/it"     # by name
npm run test:watch
npm run test:cov           # coverage to ../coverage
npm run test:e2e           # uses test/jest-e2e.json
npm run test:debug         # node --inspect-brk + jest --runInBand
npx prisma migrate dev     # once schema.prisma exists
npx prisma db seed
```

Jest config lives inside `package.json` (`rootDir: src`, `testRegex: .*\\.spec\\.ts$`). E2E config is `test/jest-e2e.json`.

## Bootstrapping rules already in place — do not regress

`main.ts` enables behaviour every new module must respect:

1. **URI versioning**: routes get `/v1` automatically. Use `@Controller({ path: 'deals', version: '1' })` or rely on the default. Never hardcode `/v1` in route strings.
2. **Global `ValidationPipe`** with `whitelist: true`, `transform: true`, `enableImplicitConversion: true`. Every input MUST be a `class-validator` DTO; unknown properties are stripped. Don't accept raw bodies.
3. **CORS**: origin list comes from `CORS_ORIGINS` (comma-separated). Empty list + `NODE_ENV=development` allows all; production with empty list blocks all. Allowed headers include `X-Access-Token` (used by participant/creator tokens).
4. **Global `ThrottlerModule`**: 10 req/min per IP by default. Public endpoints (invite preview, deal create) need tighter overrides per `requirements.md` (e.g. R4.5 → 30 req/min/IP for invite preview).
5. **`ConfigModule.forRoot({ isGlobal: true })`** with Joi validation — fail fast on bad env. Read config via `ConfigService.get('namespace.key')` (see `config/configuration.ts`); don't reach into `process.env` from feature code.

## Environment variables

`.env.example` doesn't exist yet — create one when writing the deal-flow stack. The current `.env` (and what new modules should expect):

| Group | Keys |
|---|---|
| Core | `NODE_ENV`, `PORT`, `APP_BASE_URL`, `CORS_ORIGINS` |
| DB | `DATABASE_URL` (postgres) |
| Auth | `JWT_SECRET` (min 32 chars), `SESSION_SECRET`, `ENCRYPTION_MASTER_KEY` |
| Deal | `INVITE_TOKEN_TTL_HOURS` (72), `DEAL_EXPIRES_HOURS` (720), `PLATFORM_FEE_PERCENT` (2), `DEFAULT_CURRENCY` (USD) |
| Bakong | `BAKONG_ACCOUNT_ID`, `BAKONG_MERCHANT_NAME`, `BAKONG_MERCHANT_CITY`, `BAKONG_API_TOKEN` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_BOT_ENABLED`, `TELEGRAM_CLIENT_ID`, `TELEGRAM_CLIENT_SECRET` |
| OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_CALLBACK_BASE_URL` |
| Admin bootstrap | `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD` (min 8) |
| MinIO | `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_USE_SSL`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET` |
| Sessions | `SESSION_TTL_DAYS` (30) |

When you add a new required var, add it to **both** `configuration.ts` (typed accessor) **and** `env.validation.ts` (Joi rule) — boot will fail fast otherwise.

Note: the committed `.env` contains real-looking tokens. Treat it as a dev-only file; never copy it into examples or commit secrets.

## Module-creation conventions

When adding a new feature module under `src/<name>/`:

- File layout: `<name>.module.ts`, `<name>.controller.ts`, `<name>.service.ts`, `dto/`, `entities/` if needed. Specs sit beside their subjects: `foo.service.spec.ts`.
- Inject the shared `PrismaService` from `src/prisma/`. Don't instantiate `PrismaClient` directly in feature code.
- DTOs use `class-validator` decorators (`@IsString`, `@Length`, `@IsIn`, `@IsNumber`, etc.). The global pipe transforms and strips unknown fields; you don't need to wire it per-route.
- Throw typed exceptions (`BadRequestException`, `ForbiddenException`, `NotFoundException`). Return `message_key` strings (e.g. `deal.missing_required_fields`) — never literal English. Per-status-code error shape is the same for all routes.
- Public endpoints: apply `@Throttle({ default: { limit: N, ttl: 60_000 } })` with the limit from `requirements.md` for that route.
- Admin endpoints live under `/v1/admin/*` and require the admin guard.
- Anonymous participant access uses the `X-Access-Token` header (creator or participant token), guarded by a deal-access guard that looks up by token hash.

## Hard rules from the architecture contract

These come from `../AGENTS.md` and `design.md`. Test for them; don't shortcut them:

1. **Status transitions only happen inside the Deal service's transition engine.** No other module mutates `DealRoom.status`.
2. **Every status change writes an `AuditLogEntry` in the same transaction** as the originating action. Audit + wallet ledger are append-only at the DB role level (`migrator` does DDL, `app` only does DML — see `tasks.md` 2.1).
3. **Tokens (creator / participant / invite) are stored as hashes only.** Raw token returned exactly once on creation. Never log raw tokens or the bot token.
4. **Buyer pays BothSafe, never the seller directly.** Seller's payout KHQR is payout-only and never visible to the buyer (enforce in the Deal serializer).
5. **Material edits (Product_Title, Product_Description, Deal_Amount, Currency) reset both approvals** and bounce status to `AWAITING_BOTH_APPROVAL`. Non-material edits (Product_Type, Quantity, Condition, participant-personal fields) preserve approvals.
6. **After payment, deal fields lock.** Reject edits with `deal.locked_after_payment` for any status in `{PAYMENT_PENDING_VERIFICATION, PAID_ESCROWED, SELLER_PREPARING, SHIPPED, BUYER_CONFIRMED, RELEASE_PENDING, RELEASED, DISPUTED, REFUNDED, CANCELLED, EXPIRED}`.
7. **Buyer confirm-received triggers atomic auto-release** — single transaction: debit escrow wallet, credit seller wallet, set status to `RELEASED`, write audit row. Admin involvement only on dispute / withdrawal.
8. **Notifications go through an outbox.** Notification dispatch failure must NOT roll back the originating business state. Write to outbox in the same transaction; dispatch is async.
9. **Every deal response includes `missing_fields[]` and `allowed_actions[]`.** The frontend renders permissions from these — don't hardcode permissions client-side.

## Telegram bot module

The bot is a NestJS module under `src/bot/`, **in-process** with the rest of the backend. It calls `DealService` directly (not HTTP). Same business rules as web; no bot-only logic. Disabled by default via `TELEGRAM_BOT_ENABLED=false` — only register handlers when the flag is true so local dev doesn't fight Telegram for updates.

## Testing expectations

- `*.spec.ts` next to the unit under test. AAA structure (Arrange, Act, Assert).
- Integration tests for transitions and ledger arithmetic should hit a real Postgres (Testcontainers per `tasks.md`), not a mocked `PrismaService` — the transition engine and append-only constraints are exactly the parts mocks lie about.
- Property-based tests (fast-check) for the state machine and ledger sum invariants are called out in `tasks.md`'s "Property-based testing hooks" — use them for those concerns.

## Things the bootstrap already handles — don't re-add

- Global validation pipe (don't apply `ValidationPipe` per-controller).
- Global throttler (don't wire `ThrottlerGuard` per-controller unless overriding limits).
- `/v1` prefix (don't put `v1` in `@Controller` paths).
- CORS (don't write per-route CORS).
- Env validation (don't read `process.env` directly outside `config/`).
