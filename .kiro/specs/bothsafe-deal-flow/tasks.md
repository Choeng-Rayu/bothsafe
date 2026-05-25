# Implementation Plan: BothSafe Deal Flow

## Overview

This plan implements the authenticated, wallet-backed escrow flow defined in `requirements.md` and `design.md`. Tasks are ordered foundation-first so each layer is built on a working substrate: Docker stack → Prisma schema → shared utilities → Auth → Deal/Invite/Approval → Wallet → Payment+KHQR → Shipping/Confirmation/Dispute → Withdrawal+Admin → Notification (outbox) → Storage → Telegram bot → Frontend pages → cross-cutting property tests → deployment finalization.

Implementation language: **TypeScript** (NestJS for backend and bot, Next.js App Router for frontend). Database: **PostgreSQL 16**. Object storage: **MinIO**. Tests use **Jest** (unit + integration), **fast-check** (property-based), **Testcontainers** (Postgres-backed integration).

Convention reminders from `AGENTS.md`/`design.md`:
- Status transitions only via the Deal Service transition engine.
- Every status change writes an `AuditLogEntry` in the same transaction.
- Wallet ledger and audit log are append-only at the DB role level.
- Notifications go through the outbox; dispatch failure does not roll back business state.
- All user-facing strings return a `message_key`, not literal text.

Convention for this file:
- Sub-tasks marked with `*` are optional (mostly tests). Top-level tasks are never optional.
- `_Requirements:_` references granular acceptance criteria (e.g., `R9.2`).
- Property test tasks reference the design's "Property-based testing hooks" section.

## Tasks

- [x] 1. Set up Docker Compose stack and infrastructure scaffolding
  - [x] 1.1 Create dev `docker-compose.yml` (data services only) at repo root
    - Services: `postgres`, `minio`, `minio-init` (one-shot bucket creator), `redis`.
    - Container names prefixed `bothsafe-dev-` so they coexist with anything else on the developer's machine; host ports shifted to `55432` (postgres), `59000`/`59001` (minio API/console), `56379` (redis).
    - Healthchecks for postgres (`pg_isready`), minio (`/minio/health/ready`), redis (`redis-cli ping`).
    - Named volumes: `bothsafe-dev-postgres-data`, `bothsafe-dev-minio-data`, `bothsafe-dev-redis-data`.
    - Backend and frontend run on the host in dev (`npm run start:dev` / `npm run dev`) — they are NOT in this compose file.
    - Helper script: `scripts/dev-up.sh {up|down|nuke|logs}`.
    - _Requirements: design "Deployment Topology → Dev `docker-compose.yml`"_

  - [x] 1.2 Create prod `docker-compose.prod.yml` with Dockerfiles and Nginx config
    - Six services: `nginx`, `frontend`, `backend`, `bothsafe-postgres`, `bothsafe-minio`, `bothsafe-redis`. Only Nginx binds host ports (80/443); everything else stays on the internal `bothsafe-net` bridge network.
    - All required secrets use `${VAR:?msg}` so `compose up` fails loudly when `.env` is incomplete.
    - `backend/Dockerfile`: Node 20-alpine multi-stage (deps → build → runtime), Prisma generate, `npm prune --omit=dev`, `tini` as PID 1 for clean SIGTERM handling.
    - `frontend/Dockerfile`: Next.js standalone output, runs as non-root `nextjs` user. Requires `output: "standalone"` in `next.config.ts` (set this before first prod build).
    - `.dockerignore` files in both `backend/` and `frontend/` to keep the build context lean.
    - `nginx/nginx.conf`: TLS termination via certs at `/etc/nginx/certs/{fullchain,privkey}.pem`, HTTP→HTTPS redirect, `client_max_body_size 12m`, `limit_req_zone` for `auth` (60r/m, burst 20) and `invite` (120r/m, burst 40), `X-Request-Id` propagation, MinIO subdomain server with `proxy_buffering off`.
    - Routes: `/v1/auth/*` → backend (auth zone), `/v1/deals/*/invite-preview` → backend (invite zone), `/v1/*` → backend, `/` → frontend, `s3.*` → minio.
    - _Requirements: R1.7, R4.5, design "Deployment Topology → Prod `docker-compose.prod.yml`", design "Nginx config sketch"_

  - [x] 1.3 Create `backend/.env.example` and `frontend/.env.example`
    - Backend covers: `NODE_ENV`, `PORT=3003`, `APP_BASE_URL`, `DATABASE_URL` (postgres on `bothsafe-dev-postgres:55432`), `REDIS_URL` (`bothsafe-dev-redis:56379`), `MINIO_*` (`bothsafe-dev-minio:59000`, bucket `bothsafe`), `JWT_SECRET` (≥32 chars), `JWT_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`, `SESSION_SECRET`, `ENCRYPTION_MASTER_KEY`, `SESSION_TTL_DAYS`, `INVITE_TOKEN_TTL_HOURS`, `DEAL_EXPIRES_HOURS`, `PLATFORM_FEE_PERCENT`, `DEFAULT_CURRENCY`, `RECEIVER_ACCOUNT_LABEL`, `BAKONG_*` (`ACCOUNT_ID`, `MERCHANT_NAME`, `MERCHANT_CITY`, `API_TOKEN`), `CORS_ORIGINS`, `TELEGRAM_BOT_*` (`ENABLED`, `TOKEN`, `USERNAME`, `WEBHOOK_SECRET`, `WEBHOOK_URL`, `CLIENT_ID`, `CLIENT_SECRET`), `GOOGLE_CLIENT_*`, `AUTH_CALLBACK_BASE_URL`, `ADMIN_BOOTSTRAP_*`.
    - Frontend covers: `NEXT_PUBLIC_API_BASE=http://localhost:3003`, `NEXT_PUBLIC_APP_BASE_URL=http://localhost:3000`, `INTERNAL_API_BASE`, `NEXTAUTH_SECRET`.
    - Note: env names differ from earlier design draft. Use `TELEGRAM_BOT_TOKEN` (not `BOT_TELEGRAM_TOKEN`), `GOOGLE_CLIENT_ID` (not `GOOGLE_OAUTH_CLIENT_ID`), `CORS_ORIGINS` (not `FRONTEND_ORIGIN`), and there is no `BAKONG_API_BASE` — only `BAKONG_API_TOKEN`. The Joi env validation schema in `backend/src/config/env.validation.ts` is the source of truth for required vars and bounds; the typed accessor lives in `backend/src/config/configuration.ts`.
    - `.env`, `.env.local`, and `*.dump` are already in `.gitignore` for both folders.
    - _Requirements: design "Cross-Cutting Concerns → Security → Secrets"_

  - [x] 1.4 Wire Claude Code auto-format hooks
    - `.claude/settings.json` PostToolUse hooks scoped to each folder: prettier + eslint + tsc on backend `.ts` edits, prettier + eslint + tsc on frontend `.ts/.tsx/.js/.jsx/.css` edits.
    - Frontend hook self-skips until `frontend/package.json` exists.
    - tsc failures block the edit (exit 2); prettier/eslint warnings don't.
    - _Requirements: none directly — developer ergonomics, complements R-lint discipline._

- [x] 2. Define Prisma schema and database migrations
  - [x] 2.1 Switch Prisma datasource to PostgreSQL provider and configure `migrator` vs `app` DB roles
    - Update `prisma/schema.prisma` provider to `postgresql`.
    - Document role split (`migrator` for DDL, `app` for DML) in `prisma/README.md`.
    - _Requirements: design "Stack and deployment summary", "Append-only enforcement"_

  - [x] 2.2 Add native Postgres enums to schema
    - `deal_status`, `currency`, `participant_role`, `creator_source`, `preferred_lang`, `withdrawal_status`, `withdrawal_destination`, `dispute_reason`, `ledger_entry_type`, `ledger_direction`, `notification_event`, `outbox_status`.
    - _Requirements: design "Postgres-level types and enums"; AGENTS.md "Deal Status Enum"_

  - [x] 2.3 Add `User`, `ExternalIdentity`, `Session`, `AuthAttempt` models
    - Unique `(provider, external_id)` on `ExternalIdentity` for dedup.
    - `Session.token_hash` UNIQUE; `expires_at` index.
    - `AuthAttempt(identity_key, attempted_at)` index for sliding window.
    - _Requirements: R1.1, R1.2, R1.3, R1.4, R1.7, R1.9_

  - [x] 2.4 Add `DealRoom`, `DealParticipant` models
    - `DealRoom.public_id` UNIQUE; `reference_note` UNIQUE; `terms_hash` column; `expires_at` for invite clock.
    - `DealParticipant`: UNIQUE `(deal_id, role)` and UNIQUE `(deal_id, user_id)`.
    - Indexes: `(status)`, `(creator_user_id, created_at DESC)`.
    - _Requirements: R2.6, R2.8, R3.4, R3.5, R5.6, R6.1, R7.1, R7.2_

  - [x] 2.5 Add `InviteToken`, `CreatorAccessToken`, `ParticipantAccessToken` models
    - Token hash storage only; `expires_at` and `invalidated_at` on `InviteToken`.
    - UNIQUE constraints to prevent duplicate token hashes.
    - _Requirements: R2.9, R3.6, R5.6, R5.8_

  - [x] 2.6 Add `Approval`, `PaymentProof`, `ShippingProof`, `Confirmation`, `Dispute`, `DisputeEvidence` models
    - `Approval.terms_hash` snapshot; `invalidated_at` for material-edit invalidation.
    - `Confirmation`: UNIQUE `(deal_id)` and `(deal_id, idempotency_key)`.
    - `Dispute` partial UNIQUE index `(deal_id) WHERE status='open'`.
    - _Requirements: R8.1, R8.4, R10.4, R12.2, R13.2, R17.5, R17.6_

  - [x] 2.7 Add `Wallet`, `WalletRole`, `WalletLedgerEntry` models
    - UNIQUE `(user_id, currency)` on `Wallet`.
    - `WalletLedgerEntry.amount NUMERIC(18,2) CHECK (amount > 0)`; `created_at TIMESTAMPTZ(3)` (ms precision).
    - Indexes: `(wallet_id, created_at DESC)`, `(related_deal_id)`, `(related_withdrawal_id)`.
    - _Requirements: R14.1, R14.6_

  - [x] 2.8 Add `WithdrawalRequest` model
    - Branched destination columns (KHQR vs bank).
    - Indexes: `(seller_user_id, created_at DESC)`, `(status, created_at DESC)`.
    - _Requirements: R15.1–R15.5, R16.1_

  - [x] 2.9 Add `AuditLogEntry`, `NotificationOutboxEntry`, `IdempotencyKey`, `BotConversation` models
    - `AuditLogEntry.created_at TIMESTAMPTZ(3)`; indexes on `(deal_id)`, `(actor_user_id)`, `(action_type)`.
    - `NotificationOutboxEntry`: `status, created_at` index for drainer.
    - `IdempotencyKey`: UNIQUE `(scope, key, user_id)`.
    - _Requirements: R18.11, R19.10, R20.1–R20.3_

  - [x] 2.10 Apply append-only enforcement (post-migration SQL)
    - REVOKE UPDATE/DELETE/TRUNCATE on `wallet_ledger_entry`, `audit_log_entry` from `app` role.
    - Create `reject_mutation()` function and `BEFORE UPDATE OR DELETE OR TRUNCATE` triggers.
    - Run as `migrator` role; tests that the `app` role cannot mutate.
    - _Requirements: R14.2, R20.5_

  - [x] 2.11 Run initial Prisma migration and seed script
    - `npx prisma migrate dev --name init_deal_flow`.
    - Seed: one platform user, escrow wallets per currency, `WalletRole='escrow'` rows.
    - _Requirements: design "Wallet and ledger" (escrow wallet definition)_

- [x] 3. Build shared utilities and cross-cutting modules
  - [x] 3.1 Implement `PrismaService` and global `PrismaModule`
    - `onModuleInit` connects; `enableShutdownHooks`.
    - Expose typed `$transaction` helper.
    - _Requirements: AGENTS.md "Backend Coding Rules"_

  - [x] 3.2 Create `src/common/constants.ts` and `src/common/enums.ts`
    - Mirror Prisma enums for compile-time use; freeze deal-status transitions table.
    - _Requirements: AGENTS.md "Deal Status Enum"_

  - [x] 3.3 Implement `src/common/money.ts` Decimal helpers
    - Two-decimal fixed-point parse/format; `gte`, `lt`, `minus`, `plus` wrappers around `decimal.js`.
    - _Requirements: R2.1, R3.1, R7.1, R14.1, R15.1_

  - [x] 3.4 Implement `src/common/tokens.ts` (cuid v2 + SHA-256)
    - `generateRawToken()`, `hashToken(raw)`, `verifyToken(raw, hash)` (constant-time compare).
    - _Requirements: R2.9, R5.8, design "Token strategy"_

  - [x] 3.5 Implement `src/auth/password.ts` (argon2id wrapper)
    - `hashPassword`, `verifyPassword`; parameters m=64MiB, t=3, p=4, hashLength=32.
    - Never log plaintext or hash.
    - _Requirements: R1.4, R1.9, design "Password hashing"_

  - [x] 3.6 Implement global exception filter and error envelope
    - Map domain exceptions to `{ error: { code, message_key, details? } }` shape.
    - Codes: `auth.*`, `deal.*`, `wallet.*`, `payment.*`, `shipping.*`, `confirmation.*`, `dispute.*`, `withdrawal.*`, `invite.*`, `storage.*`, `rate.exceeded`.
    - _Requirements: AGENTS.md "Backend Coding Rules" (`message_key`); R1.5, R1.6, R1.7, R7.5, R7.7, R8.2, R9.3–R9.6, R10.5, R10.7, R10.8, R11.6, R11.7, R12.3, R12.5, R12.6, R13.7, R14.2, R15.6, R15.7, R16.4, R16.5, R16.8, R17.4, R17.6, R17.9_

  - [x] 3.7 Configure `@nestjs/throttler` with named buckets
    - Global default; named buckets for `auth_login`, `auth_signup`, `invite_preview`.
    - _Requirements: R1.7, R4.5, R4.6_

  - [x] 3.8 Implement `IdempotencyMiddleware` keyed on `Idempotency-Key` header
    - Store `(scope, key, user_id)` row; on cache hit, return previous response from `result_ref`.
    - Insert inside the originating transaction.
    - Scopes: `confirm_received`, `approve_withdrawal`, `reject_withdrawal`, `khqr_receipt`, `tg_create`.
    - _Requirements: R13.2, R16.2, R16.3, R18.11, design "Idempotency"_

  - [x] 3.9 Implement `AuditService.record(entry, tx)`
    - Required to be called inside the originating tx; throws if no tx is provided.
    - _Requirements: R20.1, R20.2, R20.3, R20.4_

  - [x] 3.10 Set up i18n key conventions (backend message keys + frontend translation files)
    - Create `frontend/messages/{km,en,zh}.json` with stub keys for `auth.*`, `deal.*`, `wallet.*`, `payment.*`, `bot.*`.
    - _Requirements: AGENTS.md "i18n Key Structure"_

  - [x] 3.11 Property tests for shared utilities*
    - **Property: hash determinism** — `hashToken(x) === hashToken(x)` and uniqueness across distinct inputs (sample of 1000).
    - **Property: money round-trip** — `parse(format(x)) === x` for all 2-decimal values in range.
    - **Validates: R2.1, R14.1**

- [x] 4. Implement Auth module
  - [x] 4.1 `AuthService.signupEmail` (validation + argon2id + create User + Session)
    - Email format + 8–128 char password; no `User` row on validation failure.
    - _Requirements: R1.1, R1.4, R1.5, R1.9_

  - [x] 4.2 `AuthService.loginEmail` (verify + Session) with 2 s upper bound
    - Constant-time password verify; record `AuthAttempt`.
    - _Requirements: R1.1, R1.6, R1.7, R1.9_

  - [x] 4.3 `AuthService.loginTelegram` (initData HMAC verify) and `loginGoogle` (id_token verify)
    - Look up or upsert `ExternalIdentity` (`provider`, `external_id`); link to existing `User`.
    - _Requirements: R1.1, R1.3_

  - [x] 4.4 Session issuance + cookie middleware
    - 24 h TTL; SHA-256 token hash stored in `Session.token_hash`; `Set-Cookie: bs_session; HttpOnly; Secure; SameSite=Lax; Path=/`.
    - _Requirements: R1.2_

  - [x] 4.5 Sliding-window rate limiter (5 fails / 15 min) backed by `AuthAttempt`
    - Bucketed by `identity_key` (`email` or `tg:<id>` or `google:<sub>`).
    - _Requirements: R1.7_

  - [x] 4.6 `AuthGuard` (session) + `AdminGuard` (`User.is_admin === true`)
    - Unauthenticated requests on guarded routes return `auth.required` with redirect target.
    - _Requirements: R1.8, R16.6, R16.8_

  - [x] 4.7 Auth controller + DTOs
    - Routes: `POST /v1/auth/email/signup|login`, `/auth/telegram`, `/auth/google`, `/auth/logout`, `GET /auth/me`.
    - _Requirements: R1.1–R1.8_

  - [x] 4.8 Property test: rate limiter window correctness
    - **Property: sliding window** — for any sequence of timestamps, the deny decision matches the spec (≥5 fails in last 15 min ⇒ deny).
    - **Validates: R1.7**

  - [x] 4.9 Unit tests: argon2id round-trip and timing safety
    - _Requirements: R1.4, R1.6, R1.9_

- [ ] 5. Implement Deal/Invite/Approval module
  - [x] 5.1 `DealService.transition(deal, to, actor, tx)` — single transition engine
    - Validates allowed `prev → next` per state machine; writes `AuditLogEntry` in same tx.
    - _Requirements: R20.1, AGENTS.md "Core Domain Rules" #6, design "Deal Status state machine"_

  - [ ] 5.2 `DealService.create` (seller flow + buyer flow)
    - Validate required fields per role; ignore optional fields not allowed at seller create-step.
    - Issue `Creator_Access_Token` + `Invite_Token`; store hashes; return raw values once.
    - _Requirements: R2.1–R2.9, R3.1–R3.6_

  - [x] 5.3 `DealService.computeTermsHash(deal)`
    - Trim + collapse whitespace; normalise `Deal_Amount` to two-decimal string; sorted-key JSON; SHA-256 hex.
    - _Requirements: R8.1_

  - [x] 5.4 `DealService.computeMissingFields(deal)`
    - Set: `Product_Title`, `Product_Type`, `Deal_Amount`, `Buyer_Name`, `Seller_Name`.
    - Treat null/empty/whitespace and out-of-range `Deal_Amount` as empty.
    - _Requirements: R6.1, R6.2_

  - [x] 5.5 `DealService.computeAllowedActions(deal, viewer)`
    - Viewer-scoped; gates `pay_now`, `submit_khqr_receipt`, `submit_shipping_proof`, `confirm_received`, `open_dispute`.
    - _Requirements: R6.3, R9.1, R12.1, R13.1, R17.1_

  - [ ] 5.6 Section patch endpoints
    - `PATCH /v1/deals/:publicId/sections/{product,participant,delivery,payout}`.
    - Material edit (`Product_Title`/`Description`/`Deal_Amount`/`Currency`) clears approvals + reverts to `AWAITING_BOTH_APPROVAL`.
    - Lock all edits after payment with `deal.locked_after_payment`.
    - _Requirements: R7.1–R7.7_

  - [x] 5.7 `InviteService` — preview + consume
    - `GET /v1/deals/:publicId/invite-preview` (public, rate-limited 30/min/IP).
    - Hash candidate token, check `expires_at` and `invalidated_at`.
    - On invalid token, never leak deal data.
    - _Requirements: R4.1–R4.6_

  - [ ] 5.8 Join endpoint `POST /v1/deals/:publicId/join`
    - Single tx: assign opposite role, set `AWAITING_BOTH_APPROVAL`, issue `Participant_Access_Token`, invalidate `InviteToken`.
    - Validate name length and phone format.
    - _Requirements: R5.1–R5.10_

  - [ ] 5.9 Approval endpoint `POST /v1/deals/:publicId/approval`
    - Snapshot `terms_hash`; idempotent on resubmit; transition to `READY_FOR_PAYMENT` only when both active approvals match current `terms_hash` and `missing_fields = []`.
    - Emit `BOTH_APPROVED` exactly once (outbox).
    - _Requirements: R6.4, R6.5, R8.1–R8.7_

  - [ ] 5.10 Property test: `computeMissingFields` correctness
    - **Property: missing-field characterisation** — for any synthetic deal, the returned array equals `{ f ∈ required | empty(f) }`.
    - **Validates: R6.1, R6.2**

  - [ ] 5.11 Property test: `computeTermsHash` canonicalisation
    - **Property: hash invariance under whitespace normalisation** — `hash(d) === hash(d')` when `d` and `d'` differ only by whitespace runs / amount precision; otherwise differ.
    - **Validates: R8.1**

  - [ ] 5.12 Property test: state machine `allowedTransitions`
    - **Property: closure under spec** — for any `(prev, next)` pair, `transition` succeeds iff the spec table includes it; on reject, no row mutated.
    - **Validates: R6.5, R7.5, R20.1**

  - [ ] 5.13 Property test: `Approval.areBothApproved`
    - **Property: both-approved iff matching active approvals** — true exactly when the latest non-invalidated approval per role has `terms_hash === deal.terms_hash`.
    - **Validates: R8.3, R8.4, R8.7**

  - [ ] 5.14 Unit tests: invite preview never leaks tokens or participant identities
    - _Requirements: R4.2, R4.3_

  - [ ] 5.15 Checkpoint
    - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement Wallet module
  - [ ] 6.1 `WalletService.getOrCreate(userId, currency)` and `computeBalance(walletId, tx)`
    - Signed sum over `WalletLedgerEntry`; uses index `(wallet_id, created_at DESC)`.
    - _Requirements: R14.3, R14.6_

  - [ ] 6.2 `WalletService.getAvailableBalance(walletId, tx)`
    - Acquires `SELECT ... FOR UPDATE` on `Wallet` row; subtracts pending withdrawal amounts.
    - _Requirements: R15.6, design "Available-balance derivation"_

  - [ ] 6.3 `WalletService.payDealFromWallet(deal, buyer)` — atomic wallet payment
    - Single `$transaction`; lock buyer + escrow wallets in id-ASC order; insert two `ESCROW_RECEIVED` ledger rows; transition `READY_FOR_PAYMENT → PAID_ESCROWED → SELLER_PREPARING`; write audit row.
    - Reject `wallet.insufficient_balance`, `wallet.currency_mismatch`, `wallet.invalid_deal_state`, `auth.role_forbidden` per spec.
    - _Requirements: R9.1–R9.9, R14.4, R14.5, R20.2_

  - [ ] 6.4 `WalletService.settleEscrowFromKhqr(deal, externalRef, tx)`
    - Insert `ESCROW_RECEIVED` credit on escrow wallet; transition to `PAID_ESCROWED → SELLER_PREPARING` in same tx.
    - _Requirements: R11.2, R11.4, R11.8_

  - [ ] 6.5 `WalletService.autoReleaseToSeller(deal)` — atomic auto-release
    - Lock escrow + seller wallets; debit escrow + credit seller (`SELLER_PAYOUT_*`); transition `RELEASE_PENDING → RELEASED`; audit; outbox `PAYOUT_RELEASED`.
    - On any failure, leave status at `RELEASE_PENDING` and emit `ADMIN_RELEASE_FAILED` admin alert.
    - _Requirements: R13.3, R13.5, R13.6, R20.2_

  - [ ] 6.6 Wallet controller
    - `GET /v1/wallet/me`, `GET /v1/wallet/me/ledger?currency&cursor&limit` (cursor on `(created_at, id)`, max 200).
    - _Requirements: R14.1, R14.3, R15.6_

  - [ ] 6.7 Property test: `computeBalance` signed-sum invariant
    - **Property: balance equals signed sum** — for any random sequence of credit/debit entries, `computeBalance === Σ(direction === 'credit' ? amount : -amount)`.
    - **Validates: R14.3**

  - [ ] 6.8 Property test: atomicity (no orphan ledger rows)
    - Using Postgres testcontainer, inject failure between debit and credit; assert wallet rows unchanged after rollback.
    - **Property: all-or-nothing** — for any `payDealFromWallet` invocation that throws, `computeBalance` of buyer/escrow is unchanged.
    - **Validates: R9.8, R9.9, R14.4, R14.5**

  - [ ] 6.9 Unit tests: currency mismatch and insufficient balance error envelopes
    - _Requirements: R9.3, R9.6_

- [ ] 7. Implement Payment + KHQR module
  - [ ] 7.1 `KhqrGenerator.generate(input)`
    - Build TLV KHQR string per Bakong spec; PNG ≥ 256×256; cache `khqr_payload_meta` on `DealRoom`.
    - On generator failure: return `payment.khqr_unavailable`, leave status at `READY_FOR_PAYMENT`.
    - _Requirements: R10.1, R10.2, R10.8_

  - [ ] 7.2 `Reference_Note` allocator (Crockford base32, 16 chars, UNIQUE on `deal_room.reference_note`)
    - Retry on unique-violation up to 5 times.
    - _Requirements: R10.1_

  - [ ] 7.3 `KhqrVerifier` polling loop
    - Poll Bakong every 10 s; up to 60 s total or 3 retries; match on `Reference_Note + amount + currency`.
    - On match, call `WalletService.settleEscrowFromKhqr` inside a tx.
    - On timeout/no-match, emit `PAYMENT_PROOF_UPLOADED` to admin queue.
    - _Requirements: R11.1, R11.2, R11.3_

  - [ ] 7.4 `POST /v1/deals/:publicId/payment/wallet`
    - Buyer-only; delegates to `WalletService.payDealFromWallet`.
    - _Requirements: R9.1–R9.9_

  - [ ] 7.5 `POST /v1/deals/:publicId/payment/khqr`
    - Returns `{ khqr_string, khqr_image_url, reference_note, amount_due, currency, receiver_name, bakong_account_id }` within 3 s.
    - _Requirements: R10.1, R10.2, R10.3, R10.8_

  - [ ] 7.6 `POST /v1/deals/:publicId/payment/khqr/receipt`
    - Idempotent (`Idempotency-Key`); accept `paid_amount?`, `buyer_note?`, `attachment_key?`; require at least one of `paid_amount` or `attachment_key`.
    - Transition to `PAYMENT_PENDING_VERIFICATION`.
    - _Requirements: R10.4, R10.5_

  - [ ] 7.7 Admin verify/reject payment proof endpoints
    - `POST /v1/admin/payment-proofs/:id/verify`: write `ESCROW_RECEIVED`, set `PAID_ESCROWED → SELLER_PREPARING` in same tx.
    - `POST /v1/admin/payment-proofs/:id/reject`: 1–500 char reason; revert to `READY_FOR_PAYMENT`; emit `PAYMENT_REJECTED`.
    - _Requirements: R11.4, R11.5, R11.6, R11.7, R11.8, R20.3_

  - [ ] 7.8 Property test: `Reference_Note` format and uniqueness
    - **Property: format** — every generated note is 16 Crockford-base32 chars; rejection of `I/L/O/U`.
    - **Property: collision-free** — 100k generated notes have no duplicates.
    - **Validates: R10.1**

  - [ ] 7.9 Unit tests: KHQR receipt validation (size, MIME)
    - _Requirements: R10.5, R10.6, R10.7_

- [ ] 8. Implement Shipping, Confirmation, and Dispute modules
  - [ ] 8.1 `POST /v1/deals/:publicId/shipping-proofs`
    - Seller-only; require at least one of `delivery_company`, `tracking_number`, `package_photo`, `delivery_receipt`.
    - Transition `SELLER_PREPARING → SHIPPED`; emit `SHIPPING_UPLOADED`.
    - _Requirements: R12.1–R12.7_

  - [ ] 8.2 `POST /v1/deals/:publicId/confirm-received` (idempotent)
    - Buyer-only; transition `SHIPPED → RELEASE_PENDING` exactly once; trigger `WalletService.autoReleaseToSeller`.
    - _Requirements: R13.1, R13.2, R13.4, R13.5, R13.7_

  - [ ] 8.3 `POST /v1/deals/:publicId/disputes`
    - Reason ∈ {`ITEM_NOT_RECEIVED`, `WRONG_ITEM`, `DAMAGED_ITEM`, `FAKE_ITEM`, `PAYMENT_PROBLEM`, `OTHER`}; message 10–2000 chars.
    - Reject if active dispute already exists (partial unique index).
    - Transition to `DISPUTED`; emit `DISPUTE_OPENED` to admin + both participants.
    - _Requirements: R17.1–R17.6, R17.9_

  - [ ] 8.4 `POST /v1/admin/deals/:id/release` (dispute resolution → release)
    - Single tx: credit seller, write payout ledger entries, transition `DISPUTED → RELEASED`, audit.
    - _Requirements: R17.7, R20.3_

  - [ ] 8.5 `POST /v1/admin/deals/:id/refund` (dispute resolution → refund)
    - Single tx: credit buyer, write refund ledger entries, transition `DISPUTED → REFUNDED`, audit; emit `REFUND_COMPLETED`.
    - _Requirements: R17.8, R19.7, R20.3_

  - [ ] 8.6 Property test: confirm-received idempotency
    - **Property: idempotent confirm** — for any sequence of `(idempotency_key, ...)` calls, `RELEASE_PENDING` set exactly once and ledger rows generated exactly once.
    - **Validates: R13.2**

  - [ ] 8.7 Unit tests: dispute reason allow-list and message bounds
    - _Requirements: R17.2, R17.4_

- [ ] 9. Implement Withdrawal module + Admin review endpoints
  - [ ] 9.1 `WithdrawalService.create` with hold
    - Single tx: assert `available_balance ≥ amount`; insert `WithdrawalRequest(status=pending_admin_review)`; insert `SELLER_PAYOUT_PENDING` ledger entry; audit `WITHDRAWAL_HOLD`; outbox `WITHDRAWAL_REQUESTED`.
    - _Requirements: R15.1–R15.9, R20.2_

  - [ ] 9.2 Seller-side withdrawal endpoints
    - `POST /v1/withdrawals`, `GET /v1/withdrawals/me`, `GET /v1/withdrawals/:id` (owner only).
    - _Requirements: R15.1–R15.9_

  - [ ] 9.3 Admin withdrawal listing + detail
    - `GET /v1/admin/withdrawals?status&cursor&limit` (≤50/page); `GET /v1/admin/withdrawals/:id`.
    - _Requirements: R16.1, R16.6_

  - [ ] 9.4 `POST /v1/admin/withdrawals/:id/approve` (idempotent)
    - Status must be `pending_admin_review`. Single tx: write `SELLER_PAYOUT_SENT`, set `paid`, store `payout_reference` + `admin_note`, audit `WITHDRAWAL_PAYOUT`, outbox `WITHDRAWAL_PAID`.
    - _Requirements: R16.2, R16.4, R16.5, R16.7, R20.3_

  - [ ] 9.5 `POST /v1/admin/withdrawals/:id/reject` (idempotent)
    - Status must be `pending_admin_review`. Single tx: write compensating `ADJUSTMENT` credit equal to held amount, set `rejected`, store reason, audit, outbox `WITHDRAWAL_REJECTED`.
    - _Requirements: R16.3, R16.4, R16.5, R16.7, R20.3_

  - [ ] 9.6 `AuthGuard` + `AdminGuard` enforcement on all withdrawal review endpoints
    - Non-admin → `auth.admin_required`; never write audit for rejected attempt.
    - _Requirements: R16.6, R16.8_

  - [ ] 9.7 Property test: available-balance invariant under concurrent withdrawals
    - **Property: no over-withdrawal** — for any sequence of approve/reject and create-withdrawal operations, `available_balance ≥ 0` at every step; sum of pending holds never exceeds wallet balance.
    - **Validates: R15.6, R15.8, R16.2, R16.3**

  - [ ] 9.8 Unit tests: KHQR vs bank destination field validation
    - _Requirements: R15.3, R15.4, R15.5, R15.7_

- [ ] 10. Implement Notification module with outbox pattern
  - [ ] 10.1 `NotificationOutboxService.enqueue(event, recipients, tx)`
    - Insert `NotificationOutboxEntry(status=pending)` in caller's tx; never throw on enqueue.
    - _Requirements: R19.11_

  - [ ] 10.2 `NotificationDispatcher` drainer (`@Cron('* * * * * *')` 1 s)
    - Batch size 50; mark `sent`/`failed`; exponential backoff (1m → 2m → 4m → 8m → 15m, 5 retries).
    - _Requirements: R19.10, R19.11, design "Outbox pattern"_

  - [ ] 10.3 `InAppAdapter` — write timeline rows; `AdminQueueAdapter` — admin queue.
    - _Requirements: R19.8, R19.9, R11.3, R15.9_

  - [ ] 10.4 `TelegramAdapter` (4 s timeout per call)
    - Resolves recipient `User` → `ExternalIdentity('telegram')`; sends message with `Open Deal Room` inline button.
    - _Requirements: R18.9, R19.1–R19.9_

  - [ ] 10.5 Wire all notification events
    - `COUNTERPARTY_JOINED`, `BOTH_APPROVED`, `PAYMENT_PROOF_UPLOADED`, `PAYMENT_VERIFIED`, `PAYMENT_REJECTED`, `SELLER_SHOULD_SHIP`, `SHIPPING_UPLOADED`, `BUYER_CONFIRMED`, `DISPUTE_OPENED`, `PAYOUT_RELEASED`, `REFUND_COMPLETED`, `WITHDRAWAL_REQUESTED`, `WITHDRAWAL_PAID`, `WITHDRAWAL_REJECTED`, `ADMIN_RELEASE_FAILED`.
    - Within-5 s budget verified by integration tests.
    - _Requirements: R8.5, R12.7, R13.5, R17.5, R19.1–R19.9_

  - [ ] 10.6 Failure logging (does not roll back business state)
    - Structured `pino` log with `event_type`, `recipient_kind`, `recipient_id`, `deal_id|withdrawal_id`, `last_error`.
    - _Requirements: R19.10, R19.11_

  - [ ] 10.7 Property test: outbox at-least-once delivery
    - **Property: at-least-once** — every `enqueue` that commits eventually transitions to `sent` or hits the retry cap as `failed`; no row stays `pending` forever.
    - **Validates: R19.10, R19.11**

  - [ ] 10.8 Unit tests: exponential backoff schedule
    - _Requirements: R19.10_

- [ ] 11. Implement Storage module on MinIO
  - [ ] 11.1 MinIO client setup (`@aws-sdk/client-s3` against MinIO endpoint)
    - Bucket bootstrap on startup; idempotent bucket create.
    - _Requirements: AGENTS.md "File Storage"_

  - [ ] 11.2 `POST /v1/storage/uploads/sign`
    - Pre-signed PUT, ≤15 min TTL; allowed `kind`: `payment_receipt`, `shipping`, `dispute`, `withdrawal_khqr`.
    - Returns `{ object_key, put_url, expires_at }`.
    - _Requirements: R10.6, R10.7, R12.4, R15.3_

  - [ ] 11.3 Server-side post-upload validation
    - On reference (e.g., `attachment_key` in receipt body), HEAD object and verify MIME ∈ {`image/png`, `image/jpeg`, `application/pdf`} and size ≤ 10 MB; KHQR images cap 5 MB.
    - On violation: `storage.invalid_file`.
    - _Requirements: R10.6, R10.7, R12.4, R15.3_

  - [ ] 11.4 Unit tests: MIME sniff + size cap
    - _Requirements: R10.7, R12.4_

- [ ] 12. Implement Telegram bot module
  - [ ] 12.1 Bot bootstrap (`telegraf` or `node-telegram-bot-api`)
    - Long-poll in dev; webhook in prod via `POST /v1/telegram/webhook` behind Nginx.
    - Read `TELEGRAM_BOT_TOKEN`; redact in pino logs.
    - _Requirements: R18.8_

  - [ ] 12.2 `BotConversationService` (Postgres-backed FSM)
    - Upsert by `telegram_chat_id`; `state`, `partial_payload`, `retries`.
    - _Requirements: R18.2, R18.11, R18.13_

  - [ ] 12.3 `/start`, `/help`, `/mydeals` handlers (≤3 s response)
    - `/mydeals` lists last N deals for the user (joined via `ExternalIdentity`).
    - _Requirements: R18.1_

  - [ ] 12.4 `/newdeal` conversation flow
    - States: `ASK_ROLE → ASK_TITLE → ASK_AMOUNT → ASK_TYPE_SELLER|ASK_DESC_BUYER → ASK_DESC_SELLER → CREATE`.
    - Re-prompt on field validation failure with `bot.error.invalid_*`.
    - _Requirements: R18.2–R18.6, R18.12_

  - [ ] 12.5 `BotDealCreator.createFromConversation` → `DealService.create` in-process
    - Idempotency scope `tg_create`, key = `<chat_id>:<conversation_id>`.
    - Send Creator_Link and Invite_Link in two separate messages with `Open Deal Room` inline button.
    - _Requirements: R18.7, R18.9, R18.10_

  - [ ] 12.6 Retry on `DealService.create` failure (≤3) without losing partial payload
    - On 3rd failure, send `bot.error.deal_create_failed` and reset.
    - _Requirements: R18.11_

  - [ ] 12.7 `/cancel` handler
    - Discard conversation row; return main menu.
    - _Requirements: R18.13_

  - [ ] 12.8 Wire `TelegramAdapter` to bot for inbound notifications
    - _Requirements: R18.9, R19.1–R19.9_

  - [ ] 12.9 Property test: conversation FSM transitions
    - **Property: FSM closure** — for any input sequence, the FSM only ever reaches states defined in design's bot diagram; `/cancel` from any non-terminal state ends the conversation.
    - **Validates: R18.2–R18.6, R18.12, R18.13**

  - [ ] 12.10 Unit test: bot token never appears in logs or user messages
    - _Requirements: R18.8_

- [ ] 13. Build frontend pages and components
  - [ ] 13.1 Auth pages (`/auth/login`, `/auth/signup`)
    - Email + password forms; Telegram login widget; Google Sign-In button.
    - On success, set `bs_session` cookie via API; redirect to `next` param.
    - _Requirements: R1.1, R1.4–R1.6, R1.8_

  - [ ] 13.2 `/wallet` page (server component)
    - `WalletBalanceCard` per currency; cursor-paginated `WalletLedgerList`.
    - _Requirements: R14.3, R15.6_

  - [ ] 13.3 `/wallet/withdraw` page
    - `WithdrawalForm` with `khqr ↔ bank` toggle; client-side and server action validation.
    - _Requirements: R15.1–R15.5_

  - [ ] 13.4 `/deals/new` page
    - Buyer/seller role tabs; required-field-only form; on success, show one-time creator/invite links with `bot.link.private_warning`.
    - _Requirements: R2.1–R2.9, R3.1–R3.6_

  - [ ] 13.5 `/d/[publicId]` Deal Room base
    - Server fetch of `DealRoomResponse`; render `StatusBadge`, `DealStatusCard`, `ProductCard`, `ParticipantCard`, `PriceSummaryCard`, `EscrowExplanationCard`, `MissingFieldsChecklist`, `Timeline`.
    - Section edit forms gated by `allowed_actions`.
    - _Requirements: R5, R6.2, R6.3, R7.1–R7.7, R8.1–R8.7_

  - [ ] 13.6 Invite preview / join state for `/d/[publicId]?invite=...`
    - Public preview from `/v1/deals/:publicId/invite-preview`; prompt sign-in to join.
    - _Requirements: R4.1–R4.6, R5.1–R5.10_

  - [ ] 13.7 Payment surfaces (buyer side)
    - `PrimaryActionBar` shows `Pay from wallet` (if `pay_from_wallet ∈ allowed_actions`) and `Pay with KHQR`.
    - `KhqrPaymentPanel` (image, `Reference_Note`, deeplink), `KhqrVerificationStatus` polling `GET /v1/deals/:publicId` every 5 s up to 70 s.
    - _Requirements: R9.1, R10.2, R10.3, R11.1_

  - [ ] 13.8 Shipping, confirmation, and dispute components
    - `submit_shipping_proof` form (seller); `confirm_received` / `open_dispute` buttons (buyer); `DisputeForm` with reason select + message + evidence upload.
    - _Requirements: R12.1, R13.1, R17.1–R17.4_

  - [ ] 13.9 Admin login + admin routes guard
    - `/admin/login`; server-side admin session check on all `/admin/*` routes.
    - _Requirements: R16.6, R16.8_

  - [ ] 13.10 Admin withdrawals queue + detail
    - `AdminWithdrawalTable` with status filter and pagination; `AdminWithdrawalDetail` with approve/reject inline forms (idempotency key in header).
    - _Requirements: R16.1–R16.5, R16.7_

  - [ ] 13.11 Admin deals + payment-proof viewer + dispute resolution panel
    - Existing `AdminDealTable`, `AdminDealFilters`, `PaymentProofViewer`, `ShippingProofViewer`, `DisputeEvidenceViewer`, `AdminActionPanel`, `AdminNoteBox`.
    - _Requirements: R11.4–R11.7, R17.7, R17.8_

  - [ ] 13.12 i18n setup (`next-intl`) with `km`, `en`, `zh` and `LanguageSwitcher`
    - Wire all keys from `auth.*`, `deal.*`, `payment.*`, `shipping.*`, `confirmation.*`, `dispute.*`, `wallet.*`, `withdrawal.*`, `admin.*`, `bot.*`.
    - _Requirements: AGENTS.md "i18n Key Structure"_

  - [ ] 13.13 Mobile-first styling and 44 px tap targets
    - Sticky `PrimaryActionBar`; verify Tailwind class baseline.
    - _Requirements: AGENTS.md "Frontend Coding Rules"_

  - [ ] 13.14 Token-handling guardrails
    - Raw access tokens shown exactly once; never logged to `console.log`; never exposed to buyer view of seller payout KHQR.
    - _Requirements: R2.9, R5.8, AGENTS.md "Frontend Coding Rules"_

  - [ ] 13.15 Component unit tests for `MissingFieldsChecklist`, `KhqrPaymentPanel`, `WithdrawalForm`
    - _Requirements: R6.2, R10.2, R15.3, R15.4_

- [ ] 14. Cross-cutting property and integration test pass
  - [ ] 14.1 Property test: deal state machine end-to-end invariants
    - **Property: monotonic terminal states** — once `RELEASED`/`REFUNDED`/`CANCELLED`/`EXPIRED`, no further transition succeeds.
    - **Property: tx atomicity per transition** — each `transition` either commits both the status change and the audit row or commits neither.
    - **Validates: R20.1, R20.4, design state diagram**

  - [ ] 14.2 Property test: total wallet conservation across auto-release
    - **Property: zero-sum** — `Δ(escrow) + Δ(seller) === 0` over `RELEASE_PENDING → RELEASED`.
    - **Validates: R13.3, R14.4**

  - [ ] 14.3 Property test: withdrawal hold ↔ rejection compensation
    - **Property: rejection cancels hold** — after `reject`, `available_balance` returns to value at the moment before the corresponding `create`.
    - **Validates: R15.8, R16.3**

  - [ ] 14.4 Property test: idempotency middleware
    - **Property: at-most-once side effect** — for any `(scope, key, user_id)`, repeated calls produce identical responses and exactly one persisted side effect.
    - **Validates: R13.2, R16.2, R16.3, R18.11**

  - [ ] 14.5 Integration test suite via Postgres + MinIO testcontainers
    - End-to-end: signup → create deal → join → approve → pay (wallet) → ship → confirm → release; assert audit and ledger rows.
    - End-to-end: KHQR path with mocked Bakong.
    - End-to-end: withdrawal request → admin approve.
    - End-to-end: dispute → admin refund.
    - _Requirements: R1–R20 (smoke coverage)_

  - [ ] 14.6 Checkpoint
    - Ensure all tests pass, ask the user if questions arise.

- [ ] 15. Deployment finalization
  - [ ] 15.1 Production `Dockerfile` for backend (multi-stage)
    - Builder runs `prisma generate` + `npm run build`; runner uses non-root user.
    - _Requirements: design "Deployment Topology"_

  - [ ] 15.2 Production `Dockerfile` for frontend (Next.js standalone output)
    - `next.config.ts` `output: 'standalone'`; copy `.next/standalone` + `static` + `public`.
    - _Requirements: design "Deployment Topology"_

  - [ ] 15.3 Backend health endpoint `GET /v1/health`
    - Returns `{ db: 'ok'|'fail', minio: 'ok'|'fail' }`; used by Docker healthcheck.
    - _Requirements: design "Observability → Healthchecks"_

  - [ ] 15.4 One-shot `migrator` service in `docker-compose.yml`
    - Runs `prisma migrate deploy` then exits; uses `migrator` Postgres role with DDL privileges.
    - _Requirements: design "Append-only enforcement"_

  - [ ] 15.5 Postgres backup script
    - Host cron entry; `pg_dump -Fc` nightly to `/var/bothsafe/backups/postgres/$(date +%F).dump`; 14-day retention.
    - _Requirements: design "Backups"_

  - [ ] 15.6 TLS via Let's Encrypt
    - Certbot via webroot; renewal cron with deploy hook `docker compose exec nginx nginx -s reload`.
    - _Requirements: design "TLS"_

  - [ ] 15.7 Pino logger redaction config
    - Redact `password`, `password_hash`, `token`, `raw_*_token`, `Authorization`, `Cookie`, `TELEGRAM_BOT_TOKEN`, `*_secret`.
    - _Requirements: R1.9, R18.8, design "Cross-Cutting → Security → Logging"_

  - [ ] 15.8 Final checkpoint
    - Ensure all tests pass, ask the user if questions arise.

- [ ] 16. Implement Binance Pay buyer payment (R21)
  - [ ] 16.1 Add `BinanceOrder`, `BinanceOrderEvent` Prisma models and migration
    - Native enum `binance_order_status` per design.
    - `BinanceOrder.merchant_trade_no UNIQUE`, `prepay_id UNIQUE`, `expire_time` ≤ now() + 30min.
    - `BinanceOrderEvent UNIQUE (prepay_id, event_type, nonce)` for webhook dedup.
    - _Requirements: R21.4, R21.11_

  - [ ] 16.2 Extend `.env.example` and Joi env validation with `BINANCE_PAY_*`
    - Required: `BINANCE_PAY_BASE_URL`, `BINANCE_PAY_API_KEY`, `BINANCE_PAY_API_SECRET`, `BINANCE_PAY_WEBHOOK_BUYER_URL`, `BINANCE_PAY_WEBHOOK_PAYOUT_URL`. Optional: `BINANCE_PAY_SANDBOX` (default `true`).
    - Add same redaction entries to the Pino logger config (`BINANCE_PAY_API_SECRET`, `BinancePay-Signature`).
    - _Requirements: R21.13_

  - [ ] 16.3 Implement `BinancePayClient` (`src/binance-pay/`)
    - `createOrder`, `queryOrder`, `payout`, `queryPayout` with HMAC-SHA512 signing.
    - 8s connect + 12s read timeout; 3 retries with exponential backoff (0.5/1/2s) only on 5xx and network errors; never on 4xx.
    - `BinancePayCertificateCache` — 1h TTL, refresh-ahead, fetched via `/binancepay/openapi/certificates` with a signed merchant request.
    - Strip `signature` and `secret` fields from responses before returning to callers.
    - _Requirements: R21.6, R22.5, design "Binance Pay request signing"_

  - [ ] 16.4 Implement `BinancePaySignatureVerifier`
    - HMAC-SHA512 over `${timestamp}\n${nonce}\n${rawBody}\n` against merchant secret.
    - RSA-SHA256 verify of `BinancePay-Signature` against cert resolved from `BinancePay-Certificate-SN`.
    - Reject on missing headers, ±5min timestamp skew, hash mismatch, or unknown cert serial.
    - _Requirements: R21.6, R21.7, R22.7_

  - [ ] 16.5 Implement `BinanceOrderService.createOrderForDeal`
    - Buyer-only; reject when deal Currency is KHR with `payment.binance_currency_unsupported`.
    - Idempotency scope `binance_create_order` keyed on deal id (prevents double-tap double orders).
    - Single tx: insert `BinanceOrder` row, transition `READY_FOR_PAYMENT → PAYMENT_PENDING_VERIFICATION`, write Audit_Log.
    - On Binance API failure after retries: leave Deal_Status at `READY_FOR_PAYMENT`, return `payment.binance_unavailable`, do NOT persist a `BinanceOrder` row.
    - _Requirements: R21.1, R21.2, R21.3, R21.4, R21.5_

  - [ ] 16.6 Implement `BinanceWebhookService.handle` (POST `/v1/payment/binance/webhook`)
    - Verify signature → check timestamp skew → look up by `merchantTradeNo` → dedup on `(prepay_id, event_type, nonce)`.
    - On `PAY_SUCCESS` for `PENDING` order: single tx — set `BinanceOrder.status=PAID`, call `WalletService.settleEscrowFromBinance`, transition `PAYMENT_PENDING_VERIFICATION → PAID_ESCROWED → SELLER_PREPARING`, audit, outbox `PAYMENT_VERIFIED + SELLER_SHOULD_SHIP`.
    - On `PAY_SUCCESS` for already-`PAID` order: respond 200 `{ code: 'SUCCESS' }` no-op.
    - On `PAY_REFUND` for `PAID` order: single tx — `BinanceOrder.status=REFUNDED`, `BUYER_REFUND_SENT` ledger entry on buyer wallet, transition to `REFUNDED`, outbox `REFUND_COMPLETED`.
    - On `PAY_CLOSED` for `PENDING` order: set status `CANCELED`, transition Deal_Status back to `READY_FOR_PAYMENT`, no ledger entry.
    - On signature/timestamp/lookup failure: respond HTTP 401 `{ code: 'FAIL' }` and log `prepayId`/cert SN/reason.
    - _Requirements: R21.6–R21.9, R21.11, R21.12_

  - [ ] 16.7 Implement `WalletService.settleEscrowFromBinance` and `refundFromBinance`
    - Same shape as `settleEscrowFromKhqr`: insert `ESCROW_RECEIVED` credit on escrow wallet inside the caller's tx; transition `PAID_ESCROWED → SELLER_PREPARING`.
    - `refundFromBinance`: insert `BUYER_REFUND_SENT` debit/credit pair, transition to `REFUNDED`.
    - _Requirements: R21.8, R21.12, R14.4_

  - [ ] 16.8 Implement reconciliation processor `binance.reconcile.order`
    - BullMQ cron job every 60s on Redis.
    - `SELECT ... FOR UPDATE SKIP LOCKED` over `BinanceOrder WHERE status='PENDING' AND created_at < now() - interval '60s' AND (last_polled_at IS NULL OR last_polled_at < now() - interval '60s') LIMIT 50`.
    - On `PAID` response: same single-tx settlement logic as the webhook handler.
    - On `EXPIRED`/`CANCELED`: set `BinanceOrder.status` and revert `PAYMENT_PENDING_VERIFICATION → READY_FOR_PAYMENT`.
    - Update `last_polled_at` on every poll.
    - _Requirements: R21.10_

  - [ ] 16.9 Frontend: `Pay with Binance` panel on Deal Room
    - Add `pay_with_binance` to allowed-action rendering; on click POST `/v1/deals/:publicId/payment/binance` and show the returned `qrcode_link` (image), `deeplink`, and `universal_url` with copy buttons.
    - Poll `GET /v1/deals/:publicId/payment/binance/status` every 5s up to 5min for status changes.
    - Localised i18n keys under `payment.binance.*`.
    - _Requirements: R21.1, R21.2_

  - [ ] 16.10 Property test: webhook idempotency*
    - **Property: at-most-once apply** — for any sequence of identical webhook deliveries (`prepay_id`, `event_type`, `nonce`), the ledger has exactly one `ESCROW_RECEIVED` row and Deal_Status reaches `SELLER_PREPARING` exactly once.
    - **Validates: R21.8, R21.9, R21.11**

  - [ ] 16.11 Unit test: signature verifier rejection paths*
    - Stale timestamp, wrong HMAC, unknown cert SN, missing header — each returns HTTP 401 and writes no rows.
    - **Validates: R21.6, R21.7**

  - [ ] 16.12 Integration test: Binance sandbox happy path*
    - Using recorded fixtures (since merchant approval pending), exercise create-order → webhook → reconciliation → query-order parity.
    - **Validates: R21.4, R21.8, R21.10**

- [ ] 17. Implement Binance Pay seller withdrawal (R22)
  - [ ] 17.1 Extend `WithdrawalRequest` schema with `binance_pay_id`, `binance_email`, `binance` enum value
    - Add `'binance'` to `withdrawal_destination` enum.
    - Add `BinancePayout` Prisma model with `binance_payout_status` enum.
    - Add CHECK constraint enforcing the destination-specific field requirements per design.
    - _Requirements: R22.1, R22.2, R22.4_

  - [ ] 17.2 Extend `WithdrawalService.create` validation for `binance` destination
    - Require exactly one of `binance_pay_id` (9–19 numeric) or `binance_email`.
    - Reject KHR with `withdrawal.invalid_field` (`{ field: 'currency' }`).
    - Hold logic stays identical (single tx, `SELLER_PAYOUT_PENDING`).
    - _Requirements: R22.1–R22.4_

  - [ ] 17.3 Implement `BinancePayoutService.initiatePayout`
    - Called from `WithdrawalService.approve` when `destination_type='binance'`.
    - Build `merchantSendId = withdrawal.id` for outbound idempotency.
    - On `PROCESSING`/`SUCCESS` Binance response: single tx — write `SELLER_PAYOUT_SENT`, set `WithdrawalRequest.status='paid'`, persist `payout_reference = payoutTransactionId`, insert `BinancePayout` row, audit per R16.7.
    - On Binance API failure after retries: leave `pending_admin_review`, return `withdrawal.binance_payout_failed { error_code }`, do NOT write any ledger entry.
    - _Requirements: R22.5, R22.6_

  - [ ] 17.4 Implement payout webhook (POST `/v1/withdrawal/binance/webhook`)
    - Same signature verification path as 16.4 / 16.6.
    - On verified `SUCCESS` for already-`paid` request: respond 200 no-op.
    - On verified `FAILED`: single tx — write compensating `ADJUSTMENT` credit equal to held amount, set `WithdrawalRequest.status='rejected'` reason `binance_payout_failed`, audit, outbox seller notification.
    - _Requirements: R22.7_

  - [ ] 17.5 Implement reconciliation processor `binance.reconcile.payout`
    - BullMQ cron every 60s.
    - Polls `BinancePayout WHERE status IN ('PENDING','PROCESSING')` with `FOR UPDATE SKIP LOCKED`.
    - Calls `BinancePayClient.queryPayout`. On terminal status, applies the same logic as the payout webhook handler.
    - _Requirements: R22.8_

  - [ ] 17.6 Admin guard on payout API call
    - Only `WithdrawalService.approve` may call `BinancePayoutService.initiatePayout`. The route is admin-gated already; add a service-level check that the caller's `User.is_admin` is true and audit any rejected attempt for the existing audit table without writing a ledger entry.
    - _Requirements: R22.9_

  - [ ] 17.7 Frontend: extend `WithdrawalForm` with `binance` destination toggle
    - Tabs: `KHQR`, `Bank`, `Binance`. Binance tab shows two mutually-exclusive inputs `Binance Pay ID` (numeric, 9–19) and `Email`.
    - Hide KHR option when Binance tab is active.
    - i18n keys under `withdrawal.binance.*`.
    - _Requirements: R22.1, R22.2, R22.3_

  - [ ] 17.8 Property test: payout reconciliation idempotency*
    - **Property: at-most-once payout settlement** — repeated `SUCCESS` callbacks and reconciliation hits never produce a second `SELLER_PAYOUT_SENT` ledger row.
    - **Validates: R22.5, R22.7, R22.8**

  - [ ] 17.9 Integration test: payout failure compensation*
    - Mock Binance `FAILED` callback; assert ledger holds zero net change, `WithdrawalRequest` ends `rejected`, seller available_balance returns to pre-create value.
    - **Validates: R22.7, R15.8**

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP path; they cover unit, property, and integration tests.
- Every task references the requirement criteria it implements so an agent can re-derive context from `requirements.md`.
- Property tests target the design's "Property-based testing hooks" section: `computeBalance`, `areBothApproved`, `computeMissingFields`, `allowedTransitions`, `computeTermsHash`, and `IdempotencyMiddleware`.
- Status transitions go exclusively through `DealService.transition`; every transition writes an `AuditLogEntry` in the same DB transaction.
- The wallet ledger and audit log are append-only, enforced both at the role-privilege level and via Postgres triggers.
- Notifications use the outbox pattern: dispatch failures never roll back business state.

## Task Dependency Graph

The graph below scheduling each leaf sub-task into a wave. Tasks within the same wave are independent and may run in parallel; a wave only starts after every task in earlier waves has completed. Sub-tasks that mutate the same file (e.g., `prisma/schema.prisma` across 2.2–2.9) are placed in different waves to avoid conflicts.

### Mermaid view

```mermaid
flowchart LR
  classDef wave fill:#eef,stroke:#88a,color:#113

  subgraph W0["Wave 0 — Infrastructure scaffold"]
    T11["1.1"]
    T12["1.2"]
    T13["1.3"]
  end

  subgraph W1["Wave 1 — Prisma datasource"]
    T21["2.1"]
  end

  subgraph W2["Wave 2 — Enums"]
    T22["2.2"]
  end

  subgraph W3["Wave 3 — Auth tables"]
    T23["2.3"]
  end

  subgraph W4["Wave 4 — Deal tables"]
    T24["2.4"]
  end

  subgraph W5["Wave 5 — Token tables"]
    T25["2.5"]
  end

  subgraph W6["Wave 6 — Approvals/proofs"]
    T26["2.6"]
  end

  subgraph W7["Wave 7 — Wallet/ledger"]
    T27["2.7"]
  end

  subgraph W8["Wave 8 — Withdrawal"]
    T28["2.8"]
  end

  subgraph W9["Wave 9 — Audit/outbox/idempotency"]
    T29["2.9"]
  end

  subgraph W10["Wave 10 — Append-only + migrate"]
    T210["2.10"]
    T211["2.11"]
  end

  subgraph W11["Wave 11 — Shared utilities (parallel)"]
    T31["3.1"]; T32["3.2"]; T33["3.3"]; T34["3.4"]; T35["3.5"]
    T36["3.6"]; T37["3.7"]; T38["3.8"]; T39["3.9"]; T310["3.10"]
  end

  subgraph W12["Wave 12 — Util property tests + Auth core"]
    T311["3.11*"]
    T41["4.1"]; T43["4.3"]; T44["4.4"]; T45["4.5"]; T46["4.6"]
  end

  subgraph W13["Wave 13 — Auth login + controllers"]
    T42["4.2"]; T47["4.7"]
  end

  subgraph W14["Wave 14 — Auth tests + Deal core"]
    T48["4.8*"]; T49["4.9*"]
    T51["5.1"]; T53["5.3"]; T54["5.4"]; T55["5.5"]; T57["5.7"]
  end

  subgraph W15["Wave 15 — Deal services round 2"]
    T52["5.2"]; T56["5.6"]; T58["5.8"]; T59["5.9"]
  end

  subgraph W16["Wave 16 — Deal property tests + Wallet"]
    T510["5.10*"]; T511["5.11*"]; T512["5.12*"]; T513["5.13*"]; T514["5.14*"]
    T61["6.1"]; T62["6.2"]
  end

  subgraph W17["Wave 17 — Wallet ops + Storage + Notif core"]
    T63["6.3"]; T64["6.4"]; T65["6.5"]; T66["6.6"]
    T111["11.1"]; T101["10.1"]
  end

  subgraph W18["Wave 18 — Wallet tests + Storage uploads + Notif drainer"]
    T67["6.7*"]; T68["6.8*"]; T69["6.9*"]
    T112["11.2"]; T113["11.3"]
    T102["10.2"]; T103["10.3"]; T104["10.4"]
  end

  subgraph W19["Wave 19 — KHQR + Storage tests + Notif wiring"]
    T71["7.1"]; T72["7.2"]; T73["7.3"]
    T114["11.4*"]
    T105["10.5"]; T106["10.6"]
  end

  subgraph W20["Wave 20 — Payment endpoints + Notif tests"]
    T74["7.4"]; T75["7.5"]; T76["7.6"]; T77["7.7"]
    T107["10.7*"]; T108["10.8*"]
  end

  subgraph W21["Wave 21 — Shipping/Confirm/Dispute + KHQR tests"]
    T78["7.8*"]; T79["7.9*"]
    T81["8.1"]; T82["8.2"]; T83["8.3"]; T84["8.4"]; T85["8.5"]
  end

  subgraph W22["Wave 22 — Withdrawal core + S/C/D tests"]
    T86["8.6*"]; T87["8.7*"]
    T91["9.1"]; T93["9.3"]; T96["9.6"]
  end

  subgraph W23["Wave 23 — Withdrawal endpoints"]
    T92["9.2"]; T94["9.4"]; T95["9.5"]
  end

  subgraph W24["Wave 24 — Bot + Withdrawal tests"]
    T97["9.7*"]; T98["9.8*"]
    T121["12.1"]; T122["12.2"]; T123["12.3"]
  end

  subgraph W25["Wave 25 — Bot conversation + handlers"]
    T124["12.4"]; T125["12.5"]; T126["12.6"]; T127["12.7"]; T128["12.8"]
  end

  subgraph W26["Wave 26 — Bot tests + Frontend foundation"]
    T129["12.9*"]; T1210["12.10*"]
    T131["13.1"]; T1312["13.12"]; T1313["13.13"]; T1314["13.14"]
  end

  subgraph W27["Wave 27 — Frontend pages"]
    T132["13.2"]; T133["13.3"]; T134["13.4"]; T135["13.5"]; T136["13.6"]
    T137["13.7"]; T138["13.8"]; T139["13.9"]
  end

  subgraph W28["Wave 28 — Admin frontend + frontend tests"]
    T1310["13.10"]; T1311["13.11"]; T1315["13.15*"]
  end

  subgraph W29[Wave 29 — Binance Pay buyer payment]
    T161["16.1"]; T162["16.2"]; T163["16.3"]; T164["16.4"]; T165["16.5"]
    T166["16.6"]; T167["16.7"]; T168["16.8"]; T169["16.9"]
    T1610["16.10*"]; T1611["16.11*"]; T1612["16.12*"]
  end

  subgraph W30[Wave 30 — Binance Pay seller withdrawal]
    T171["17.1"]; T172["17.2"]; T173["17.3"]; T174["17.4"]; T175["17.5"]
    T176["17.6"]; T177["17.7"]; T178["17.8*"]; T179["17.9*"]
  end

  subgraph W31["Wave 31 — Cross-cutting property tests"]
    T141["14.1*"]; T142["14.2*"]; T143["14.3*"]; T144["14.4*"]; T145["14.5*"]
  end

  subgraph W32["Wave 32 — Deployment finalization"]
    T151["15.1"]; T152["15.2"]; T153["15.3"]; T154["15.4"]
    T155["15.5"]; T156["15.6"]; T157["15.7"]
  end

  W0 --> W1 --> W2 --> W3 --> W4 --> W5 --> W6 --> W7 --> W8 --> W9 --> W10
  W10 --> W11 --> W12 --> W13 --> W14 --> W15 --> W16 --> W17 --> W18
  W18 --> W19 --> W20 --> W21 --> W22 --> W23 --> W24 --> W25 --> W26
  W26 --> W27 --> W28 --> W29 --> W30 --> W31 --> W32
```

### JSON wave schedule (machine-readable)

```json
{
  "waves": [
    { "id": 0,  "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1,  "tasks": ["2.1"] },
    { "id": 2,  "tasks": ["2.2"] },
    { "id": 3,  "tasks": ["2.3"] },
    { "id": 4,  "tasks": ["2.4"] },
    { "id": 5,  "tasks": ["2.5"] },
    { "id": 6,  "tasks": ["2.6"] },
    { "id": 7,  "tasks": ["2.7"] },
    { "id": 8,  "tasks": ["2.8"] },
    { "id": 9,  "tasks": ["2.9"] },
    { "id": 10, "tasks": ["2.10", "2.11"] },
    { "id": 11, "tasks": ["3.1", "3.2", "3.3", "3.4", "3.5", "3.6", "3.7", "3.8", "3.9", "3.10"] },
    { "id": 12, "tasks": ["3.11", "4.1", "4.3", "4.4", "4.5", "4.6"] },
    { "id": 13, "tasks": ["4.2", "4.7"] },
    { "id": 14, "tasks": ["4.8", "4.9", "5.1", "5.3", "5.4", "5.5", "5.7"] },
    { "id": 15, "tasks": ["5.2", "5.6", "5.8", "5.9"] },
    { "id": 16, "tasks": ["5.10", "5.11", "5.12", "5.13", "5.14", "6.1", "6.2"] },
    { "id": 17, "tasks": ["6.3", "6.4", "6.5", "6.6", "11.1", "10.1"] },
    { "id": 18, "tasks": ["6.7", "6.8", "6.9", "11.2", "11.3", "10.2", "10.3", "10.4"] },
    { "id": 19, "tasks": ["7.1", "7.2", "7.3", "11.4", "10.5", "10.6"] },
    { "id": 20, "tasks": ["7.4", "7.5", "7.6", "7.7", "10.7", "10.8"] },
    { "id": 21, "tasks": ["7.8", "7.9", "8.1", "8.2", "8.3", "8.4", "8.5"] },
    { "id": 22, "tasks": ["8.6", "8.7", "9.1", "9.3", "9.6"] },
    { "id": 23, "tasks": ["9.2", "9.4", "9.5"] },
    { "id": 24, "tasks": ["9.7", "9.8", "12.1", "12.2", "12.3"] },
    { "id": 25, "tasks": ["12.4", "12.5", "12.6", "12.7", "12.8"] },
    { "id": 26, "tasks": ["12.9", "12.10", "13.1", "13.12", "13.13", "13.14"] },
    { "id": 27, "tasks": ["13.2", "13.3", "13.4", "13.5", "13.6", "13.7", "13.8", "13.9"] },
    { "id": 28, "tasks": ["13.10", "13.11", "13.15"] },
    { "id": 29, "tasks": ["16.1", "16.2", "16.3", "16.4", "16.5", "16.6", "16.7", "16.8", "16.9", "16.10", "16.11", "16.12"] },
    { "id": 30, "tasks": ["17.1", "17.2", "17.3", "17.4", "17.5", "17.6", "17.7", "17.8", "17.9"] },
    { "id": 31, "tasks": ["14.1", "14.2", "14.3", "14.4", "14.5"] },
    { "id": 32, "tasks": ["15.1", "15.2", "15.3", "15.4", "15.5", "15.6", "15.7"] }
  ]
}
```
