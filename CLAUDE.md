# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

BothSafe is an escrow-based payment protection platform for Cambodia's social commerce ecosystem (Telegram, Messenger, WeChat, Facebook). The core product is the **Deal Room** — a shareable URL where buyer and seller complete a protected transaction. BothSafe holds payment in escrow until delivery is confirmed.

The repository is a two-folder monorepo (`backend/` + `frontend/`) plus a detailed spec under `.kiro/specs/bothsafe-deal-flow/`. The repo root `AGENTS.md` is the **architecture contract** every change must respect; `frontend/CLAUDE.md` re-points to it.

Current stage: scaffolded but not implemented. Backend has bootstrapped NestJS with config + validation + global rate limiting; frontend has only the default Next.js `app/page.tsx`. No Prisma schema, no domain modules, no `frontend/package.json` yet — most work consists of creating the modules listed in `AGENTS.md`.

## Authoritative documents (read these before non-trivial work)

- `AGENTS.md` — Module map, API contract, Deal Status enum, token strategy, notification events, ledger entry types, and per-layer coding rules. **All three layers (backend, frontend, bot) must use the exact Deal Status enum and event names defined here. Never invent intermediate statuses.**
- `.kiro/specs/kiro-task-execution.prompt.md` — **Meta-instruction for how to consume the three spec files below.** Whenever you're asked to execute a Kiro task ("do task 2.4 in bothsafe-deal-flow", "implement R7", etc.), follow that prompt's workflow exactly — it's the project's contract for spec-driven work, not just a suggestion.
- `.kiro/specs/bothsafe-deal-flow/requirements.md` — 20 numbered requirements with EARS-style acceptance criteria (R1–R20, referenced as `R9.2` etc. in tasks).
- `.kiro/specs/bothsafe-deal-flow/design.md` — Implementation design that **supersedes parts of `AGENTS.md`**: the deal-flow feature uses **PostgreSQL** (not MySQL), Docker Compose with Nginx fronting frontend/backend/MinIO, atomic auto-release on buyer confirmation, internal Wallet ledger, KHQR auto-verify, and admin-gated withdrawals. When `AGENTS.md` and `design.md` disagree, `design.md` wins for the deal-flow feature.
- `.kiro/specs/bothsafe-deal-flow/tasks.md` — Foundation-first task breakdown (Docker → Prisma → Auth → Deal/Invite/Approval → Wallet → Payment+KHQR → Shipping/Confirmation/Dispute → Withdrawal → Notification outbox → Storage → Bot → Frontend). Tasks reference requirement IDs.

### Three-file workflow for executing a Kiro task

When given a task id (e.g. "task 2.4 in `bothsafe-deal-flow`"), follow the order in `.kiro/specs/kiro-task-execution.prompt.md`:

1. **`tasks.md`** — locate the task block. Extract its id, title, sub-steps, and the `_Requirements:_` ids it cites (e.g. `R2.6`, `R5.6`). Sub-tasks marked `*` are optional (mostly tests); top-level tasks are not.
2. **`requirements.md`** — for every requirement id from step 1, copy out the acceptance criteria. These are the pass/fail conditions; do not paraphrase or skip them.
3. **`design.md`** — pull the relevant interfaces, schemas, file paths, and patterns. Implementation must match `design.md` exactly; if it disagrees with `AGENTS.md`, `design.md` wins for the deal-flow feature.
4. **Implement only the current task.** No extra features, no speculative abstractions. Reference requirement ids in code comments only when the *why* is non-obvious.
5. **Verify** acceptance criteria are covered, then run lint/test/build for the area you touched (`npm run lint`, `npm test`, `npm run build` in `/backend`).
6. **Update `tasks.md`**: tick `[x]` on the task and any completed sub-steps only after verification passes. Don't tick a task whose tests are red or build is broken.

The prompt file also defines a structured output template — use it when reporting task completion to the user so the read → criteria → design → implement → verify → status chain is auditable.

## Common commands

### Local dev stack (root)

Postgres, MinIO, and Redis run in Docker; backend and frontend run on the host for fast iteration.

```bash
./scripts/dev-up.sh        # bring up bothsafe-{postgres,minio,redis}
./scripts/dev-up.sh down   # stop, keep volumes
./scripts/dev-up.sh nuke   # stop + WIPE volumes (prompts for confirmation)
docker compose ps          # see what's running
```

Containers and ports (dev container names are prefixed `bothsafe-dev-` and use shifted host ports so they coexist with any other Postgres/MinIO/Redis already running on this machine):
- `bothsafe-dev-postgres` → `localhost:55432` (`bothsafe / bothsafe / bothsafe`)
- `bothsafe-dev-minio` → `:59000` (S3 API), `:59001` (console). Bucket `bothsafe` is auto-created on first boot by the `minio-init` job. Default creds `minioadmin / minioadmin`.
- `bothsafe-dev-redis` → `localhost:56379`

The plain `bothsafe-{postgres,minio,redis}` names (default ports) are reserved for `docker-compose.prod.yml`.

For production (single VPS, all containerized including nginx + frontend + backend) use `docker-compose.prod.yml`. It requires a `.env` next to it with the required secrets — the file uses `${VAR:?msg}` to fail fast on missing values. Backend and frontend Dockerfiles and `nginx/nginx.conf` are committed; the prod nginx config expects TLS certs at `/etc/nginx/certs/{fullchain,privkey}.pem` (wire certbot or place certs there before going live).

The frontend Dockerfile assumes `output: "standalone"` in `next.config.ts` — set that before the first prod build.

### Backend (`/backend`)

```bash
npm install
npm run start:dev          # watch mode, default port 3000 (PORT in .env overrides)
npm run start              # one-shot start
npm run start:prod         # run compiled dist/main
npm run build              # nest build
npm run lint               # eslint --fix on src/, apps/, libs/, test/
npm run format             # prettier --write on src/ and test/
npm test                   # jest, picks up *.spec.ts under src/
npm test -- path/to/file.spec.ts             # single test file
npm test -- -t "name fragment"               # single test by name
npm run test:watch
npm run test:cov           # coverage to ../coverage
npm run test:e2e           # uses test/jest-e2e.json
npx prisma migrate dev     # local schema changes (once schema exists)
npx prisma db seed         # seed data (once seed exists)
```

The current `.env` points at PostgreSQL (`postgresql://bothsafe:bothsafe@localhost:5432/bothsafe`) — design.md is the source of truth on DB choice. The default `PORT` in `.env` is 3003 but `AGENTS.md` documents 3001; check before assuming.

### Frontend (`/frontend`)

`package.json` does **not exist yet** — the frontend is bootstrapped from `create-next-app` but the manifest hasn't been committed. When adding it, the standard scripts (`dev`, `build`, `start`, `lint`) align with `next.config.ts` + `eslint.config.mjs`. Frontend dev server runs on `:3000`. Copy `frontend/.env.example` to `frontend/.env.local`; `NEXT_PUBLIC_API_BASE` should point at `http://localhost:3003` to match the backend.

### Auto-format hooks

`.claude/settings.json` has `PostToolUse` hooks that run prettier + eslint + tsc on backend `.ts` edits, and prettier + eslint + tsc on frontend `.ts/.tsx/.js/.jsx/.css` edits. The frontend hook is a no-op until `frontend/package.json` exists. tsc failures block the edit (exit 2); prettier/eslint warnings don't.

## Architecture you must internalize

### Deal Status state machine (canonical)

```
DRAFT → AWAITING_COUNTERPARTY → AWAITING_BOTH_APPROVAL → READY_FOR_PAYMENT
  → PAYMENT_PENDING_VERIFICATION → PAID_ESCROWED → SELLER_PREPARING
  → SHIPPED → BUYER_CONFIRMED → RELEASE_PENDING → RELEASED
Side branches: DISPUTED, REFUNDED, CANCELLED, EXPIRED
```

Hard rules (from `AGENTS.md` + `design.md`):

1. **Buyer pays BothSafe, never the seller directly.** Seller's KHQR is payout-only and must never be shown to the buyer.
2. **Status transitions only happen inside the Deal service's transition engine.** No module mutates `Deal_Status` directly.
3. **Every status change writes an `AuditLogEntry` in the same DB transaction.** Audit and wallet ledger are append-only at the DB role level (`migrator` does DDL, `app` only does DML).
4. **Either side can create the Deal Room.** `creator_role` is stored. Both sides must exist and approve before payment — no skipping.
5. **Material edits (Product_Title, Product_Description, Deal_Amount, Currency) reset both approvals** and bounce status back to `AWAITING_BOTH_APPROVAL`. Non-material edits preserve approvals.
6. **After payment, deal fields lock.** Admin override only.
7. **Tokens (creator/participant/invite) are stored as hashes; raw values are returned exactly once.** Never log raw tokens or the bot token.

### API shape

- All routes prefixed with `/v1` (URI versioning is enabled in `main.ts`).
- Every deal response must include `missing_fields` (array) and `allowed_actions` (array) so the frontend renders permissions instead of hardcoding them.
- All user-facing strings return a `message_key`, not literal text. i18n keys live in the frontend; the supported locales are `km`, `en`, `zh`.
- Public endpoints are rate-limited via `@nestjs/throttler` (default 10 req/min per IP, configured globally in `app.module.ts`).
- CORS allows configured origins from `CORS_ORIGINS` (comma-separated), or all origins when empty in development only.

### Module map (where each concern lives)

The backend modules below don't exist yet — when creating them, place them at these paths so the rest of the contract aligns:

| Path | Responsibility |
|---|---|
| `backend/src/auth/` | Email/password (argon2id), Telegram login, Google OAuth, sessions, JWT for admin |
| `backend/src/deal/` | Deal Room lifecycle, transition engine, missing-fields calculator, allowed-actions calculator |
| `backend/src/invite/` | Invite/creator/participant token issuance and hashing |
| `backend/src/payment/` | Payment proof upload, KHQR generation, Bakong verification fallback to admin manual verify |
| `backend/src/wallet/` | One Wallet per `(user_id, currency)`, append-only ledger, atomic transfer service, hold management |
| `backend/src/khqr/` | `KhqrGenerator` (image+string+reference note bound to deal) and `KhqrVerifier` (Bakong polling) |
| `backend/src/withdrawal/` | Seller `WithdrawalRequest`, available-balance calc, admin approve/reject |
| `backend/src/ledger/` | Append-only financial records (entry types in `AGENTS.md`) |
| `backend/src/shipping/` | Seller shipping proof upload |
| `backend/src/confirmation/` | Buyer confirm-received → atomic auto-release in single transaction |
| `backend/src/dispute/` | Open dispute, evidence upload, admin resolve |
| `backend/src/admin/` | Admin-only endpoints under `/v1/admin/*` |
| `backend/src/notification/` | Outbox-driven dispatch (in-app timeline + Telegram + admin queue). Notification failure must NOT roll back the originating business state. |
| `backend/src/audit/` | Append-only `AuditLogEntry` writer, called inside the originating action's transaction |
| `backend/src/storage/` | MinIO uploads (payment proofs, product images, shipping proofs, dispute evidence), signed URLs |
| `backend/src/bot/` | Telegram bot module — runs **in-process inside NestJS**, calls `DealService` directly (not HTTP). Same business rules; no bot-only logic. |
| `backend/src/prisma/` | Shared `PrismaService` |

### Telegram bot

The bot is a NestJS module, not a separate service. In MVP it can: `/start`, `/newdeal` (guided creation), `/mydeals`, `/help`, push notification events, and send Deal Room links with inline keyboards. It does **not** accept payment proof, payout KHQR, or admin actions inside chat. When the frontend deal flow changes, mirror it in the bot — both must stay in sync.

### Frontend architecture (Next.js App Router)

- Routes: `/`, `/deals/new`, `/d/[publicId]` (with optional `?invite=` or `?access=` query), `/admin`, `/admin/deals`, `/admin/deals/[dealId]`.
- Tailwind CSS, `next-intl` (or equivalent) for `km`/`en`/`zh`.
- Mobile-first: ≥44px tap targets, sticky bottom action bar on deal pages.
- Client-validate file type/size before upload.
- Render allowed actions from API response — don't hardcode permission logic.
- Store participant access token in `httpOnly` cookie or `localStorage` with a "keep this link safe" warning. Never expose raw tokens in console logs. Never display seller payout KHQR to the buyer.
- `frontend/AGENTS.md` says: this is **not** the Next.js you know — read `node_modules/next/dist/docs/` for current API conventions before writing code, since version-specific behaviour may differ.

## MVP exclusions (do not build yet)

Telegram Mini App, merchant API/SDK, iframe widget, delivery integration, KYC, AI fraud detection, ratings, subscription/digital escrow, Binance / international payments. The full list is in `AGENTS.md`.

## Notes specific to this repo

- The `.kiro/` directory is the spec-driven planning system; treat `tasks.md` as the live work backlog. Sub-tasks marked `*` are optional (mostly tests); top-level tasks are not.
- `AGENTS.md` says MySQL but `.kiro/specs/.../design.md` switched to PostgreSQL — `.env` confirms Postgres is the active choice. Don't add MySQL.
- MinIO and Postgres are expected to run in local Docker. Do not introduce another object-storage or relational-DB provider.
- The repo root `AGENTS.md` ends with a `<claude-mem-context>` block — that's prior-session memory for the claude-mem plugin, not part of the architecture contract.
