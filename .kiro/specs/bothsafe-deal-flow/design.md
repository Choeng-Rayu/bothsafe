# Design Document — BothSafe Deal Flow

## Overview

BothSafe Deal Flow evolves the manual MVP into an authenticated, wallet-backed escrow platform with auto-generated KHQR payments, atomic auto-release on buyer confirmation, and an admin-gated withdrawal payout flow that supports any KHQR-compatible bank or traditional bank account.

The design preserves the canonical Deal Status state machine and module map established in `AGENTS.md`, and layers in five new concerns:

1. **User accounts.** A persistent `User` record now backs every participant. Three sign-in providers — Email/password, Telegram, Google — converge on the same `User` via an `ExternalIdentity` join table.
2. **Internal wallet.** Every `User` may hold one `Wallet` per supported currency (USD, KHR). All movements are recorded as append-only `WalletLedgerEntry` rows, and the live balance is derived from a signed sum of those rows.
3. **Auto-generated KHQR.** The `KhqrGenerator` service binds a unique `Reference_Note` to each deal so the `KhqrVerifier` can match incoming Bakong credits without manual proof.
4. **Auto-release on confirmation.** When the buyer confirms receipt, the system performs a single transactional debit/credit pair against the escrow and seller wallets, sets `Deal_Status` to `RELEASED`, and writes the audit row — no admin action required.
5. **Admin-gated seller withdrawal.** Sellers submit a `WithdrawalRequest`; the wallet places a `SELLER_PAYOUT_PENDING` hold; an admin reviews and either pays out (writes `SELLER_PAYOUT_SENT`) or rejects (writes a compensating `ADJUSTMENT`).

### Stack and deployment summary

| Concern | Choice | Notes |
|---|---|---|
| Frontend | Next.js (App Router, TypeScript, Tailwind, next-intl) | Same as `AGENTS.md`. |
| Backend | NestJS (TypeScript), Prisma ORM, `/v1` API prefix | Telegram bot module runs in-process. |
| Database | **PostgreSQL** (Prisma `postgresql` provider) | Overrides `AGENTS.md`'s MySQL choice for this feature. Uses `NUMERIC(18,2)`, `TIMESTAMPTZ`, native `ENUM`, `JSONB`. |
| Object storage | **MinIO** (self-hosted) | Replaces external S3. Same Docker stack. |
| Reverse proxy | **Nginx** | Single container, terminates TLS, fronts frontend + backend + MinIO. |
| Deployment | Single VPS, Docker Compose | Five services: `nginx`, `frontend`, `backend`, `postgres`, `minio`. Only Nginx exposes 80/443. |

### Source-of-truth alignment

This design is derived from `requirements.md` (20 requirements) and remains compatible with the canonical contracts in `AGENTS.md`:

- Deal Status enum is identical.
- Notification event names are identical.
- Ledger entry types are identical.
- Existing `/v1/deals/...` endpoints retain their shapes; new endpoints are additive.

Where this feature changes the MVP behaviour (KHQR auto-verify, wallet payment, auto-release, withdrawal flow, authenticated users), the change is explicitly called out and traced to the requirement that drives it.

---

## Architecture

### System context (Docker Compose container diagram)

```mermaid
flowchart LR
  user([Buyer / Seller])
  admin([Admin])
  tg([Telegram User])

  subgraph VPS["VPS — Docker Compose"]
    nginx["nginx<br/>:80, :443"]
    frontend["frontend<br/>Next.js :3000"]
    backend["backend<br/>NestJS :3001<br/>+ bot module"]
    postgres[("postgres<br/>:5432<br/>volume: postgres-data")]
    minio[("minio<br/>:9000 / :9001<br/>volume: minio-data")]
  end

  bakong[/Bakong KHQR API/]
  tgapi[/Telegram Bot API/]
  google[/Google OAuth/]

  user -->|HTTPS| nginx
  admin -->|HTTPS| nginx
  tg -->|HTTPS| tgapi
  tgapi <-->|long-poll or webhook| backend

  nginx -->|/| frontend
  nginx -->|/v1/*| backend
  nginx -->|s3.* or /minio| minio

  frontend -->|server-side fetch| backend
  backend --> postgres
  backend --> minio
  backend --> bakong
  backend --> google
```

Only Nginx is bound to host ports 80/443. All service-to-service traffic stays on the internal Docker network.

### Module decomposition

Existing modules from `AGENTS.md` retained: `Auth`, `Deal`, `Invite`, `Payment`, `Ledger`, `Shipping`, `Confirmation`, `Dispute`, `Admin`, `Notification`, `Storage`, `Telegram Bot`, `Prisma`.

New or significantly expanded modules introduced by this spec:

| Module | Path | New responsibility |
|---|---|---|
| **User & Auth** | `src/auth/` | Email/password (argon2id), Telegram login, Google OAuth, session cookie, `User` + `ExternalIdentity` + `Session` entities. |
| **Wallet** | `src/wallet/` | `Wallet` per `(user_id, currency)`, append-only `WalletLedgerEntry`, balance derivation, atomic transfer service, hold management. |
| **KHQR** | `src/khqr/` | `KhqrGenerator` (image + string + reference note) and `KhqrVerifier` (Bakong polling). Used by `Payment`. |
| **Withdrawal** | `src/withdrawal/` | Seller `WithdrawalRequest`, available-balance calculation, hold creation, admin approve/reject. |
| **Notification** | `src/notification/` | Outbox-driven event dispatch. In-app timeline + Telegram adapter + admin-queue adapter. |
| **Audit** | `src/audit/` | Append-only `AuditLogEntry` writer. Used inside the same DB transaction as the originating action. |

### Deal Status state machine

The state machine is the canonical enum from `AGENTS.md`. The diagram below shows every transition referenced by Requirements 2–17.

```mermaid
stateDiagram-v2
  direction LR
  [*] --> DRAFT
  DRAFT --> AWAITING_COUNTERPARTY: create (R2.6, R3.4)
  AWAITING_COUNTERPARTY --> AWAITING_BOTH_APPROVAL: counterparty joins (R5.6)
  AWAITING_BOTH_APPROVAL --> READY_FOR_PAYMENT: both approve & no missing fields (R6.4, R8.3)
  READY_FOR_PAYMENT --> AWAITING_BOTH_APPROVAL: required field cleared (R6.5) or material edit (R7.3)

  READY_FOR_PAYMENT --> PAID_ESCROWED: wallet payment success (R9.2)
  PAID_ESCROWED --> SELLER_PREPARING: same tx as wallet payment (R9.7) / verify (R11.8)

  READY_FOR_PAYMENT --> PAYMENT_PENDING_VERIFICATION: KHQR receipt submitted (R10.4)
  PAYMENT_PENDING_VERIFICATION --> PAID_ESCROWED: KHQR auto-verify match (R11.2) or admin verify (R11.4)
  PAYMENT_PENDING_VERIFICATION --> READY_FOR_PAYMENT: admin reject (R11.5)

  SELLER_PREPARING --> SHIPPED: seller submits shipping proof (R12.2)
  SHIPPED --> RELEASE_PENDING: buyer confirms received (R13.2)
  RELEASE_PENDING --> RELEASED: atomic auto-release (R13.3)

  PAYMENT_PENDING_VERIFICATION --> DISPUTED: dispute opened (R17.5)
  PAID_ESCROWED --> DISPUTED: dispute opened (R17.5)
  SELLER_PREPARING --> DISPUTED: dispute opened (R17.5)
  SHIPPED --> DISPUTED: dispute opened (R17.5)

  DISPUTED --> RELEASED: admin resolves with release (R17.7)
  DISPUTED --> REFUNDED: admin resolves with refund (R17.8)

  AWAITING_COUNTERPARTY --> EXPIRED: invite expiry
  AWAITING_COUNTERPARTY --> CANCELLED: creator cancels
  AWAITING_BOTH_APPROVAL --> CANCELLED: either cancels (pre-payment)

  RELEASED --> [*]
  REFUNDED --> [*]
  CANCELLED --> [*]
  EXPIRED --> [*]
```

`BUYER_CONFIRMED` exists in the canonical enum but is not used as a stable state — buyer confirmation moves directly through `RELEASE_PENDING` to `RELEASED` in the same transaction. It is kept in the enum for backward compatibility and as a pause point should auto-release fail and require admin retry.

### Withdrawal request lifecycle

Independent from `Deal_Status`:

```mermaid
stateDiagram-v2
  [*] --> pending_admin_review: seller submits (R15.8)
  pending_admin_review --> paid: admin approves + Payout_Reference (R16.2)
  pending_admin_review --> rejected: admin rejects + reason (R16.3)
  paid --> [*]
  rejected --> [*]
```

### Sequence — Buyer KHQR payment + auto-release happy path

```mermaid
sequenceDiagram
  autonumber
  actor Buyer
  participant FE as Frontend (Next.js)
  participant API as Backend (NestJS)
  participant KQ as KhqrGenerator
  participant BK as Bakong API
  participant W as WalletService
  participant N as NotificationOutbox

  Buyer->>FE: open Deal Room, choose KHQR
  FE->>API: POST /v1/deals/:publicId/payment/khqr
  API->>KQ: generate(amount, currency, reference_note)
  KQ-->>API: {khqrString, pngUrl, referenceNote}
  API-->>FE: KHQR payload (R10.2 within 3s)
  Buyer->>BK: pay via banking app

  Note over API,BK: Verifier loop (R11.1, ≤60s, ≤3 retries)
  API->>BK: GET credits matching referenceNote+amount
  BK-->>API: match
  API->>W: settleEscrow(deal, ESCROW_RECEIVED)
  Note over W: single tx — see "Atomic operations" below
  W->>W: insert ledger ESCROW_RECEIVED (escrow wallet credit)
  W->>W: status PAYMENT_PENDING_VERIFICATION → PAID_ESCROWED → SELLER_PREPARING (R11.2, R11.8)
  W->>W: insert AuditLogEntry (R20.1)
  W->>N: insert outbox row (PAYMENT_VERIFIED + SELLER_SHOULD_SHIP)
  W-->>API: ok

  API-->>FE: updated deal
  N->>N: drainer dispatches in-app + Telegram (R19.3 ≤5s)
```

### Sequence — Seller withdrawal: hold → admin review → payout

```mermaid
sequenceDiagram
  autonumber
  actor Seller
  participant FE as Frontend
  participant API as Backend
  participant W as WalletService
  participant N as NotificationOutbox
  actor Admin
  participant ADM as AdminPanel

  Seller->>FE: submit withdrawal (amount, destination)
  FE->>API: POST /v1/withdrawals
  API->>W: createWithdrawal(...)
  Note over W: single tx
  W->>W: assert available_balance >= amount (R15.6)
  W->>W: insert WithdrawalRequest (status=pending_admin_review)
  W->>W: insert WalletLedgerEntry SELLER_PAYOUT_PENDING (R15.8)
  W->>W: insert AuditLogEntry (R20.2)
  W->>N: insert outbox row (admin queue + seller in-app, R15.9 / R19.9)
  W-->>API: ok
  API-->>FE: WithdrawalRequest

  Admin->>ADM: review queue
  ADM->>API: POST /v1/admin/withdrawals/:id/approve {payoutReference}
  API->>W: approveWithdrawal(...)
  Note over W: single tx
  W->>W: assert status == pending_admin_review (R16.4)
  W->>W: insert WalletLedgerEntry SELLER_PAYOUT_SENT (R16.2)
  W->>W: WithdrawalRequest.status = paid
  W->>W: insert AuditLogEntry (R20.3)
  W->>N: insert outbox row (seller notification)
  W-->>API: ok
  API-->>ADM: updated request
```


---

## Components and Interfaces

This section describes each module's public service surface in TypeScript-flavoured pseudocode. Implementations follow NestJS conventions: a controller delegates to a service; the service uses `PrismaService` and emits events through `NotificationOutboxService`.

### AuthService (`src/auth/`)

```ts
class AuthService {
  // R1.1, R1.4–R1.6
  signupEmail(email: string, password: string): Promise<Session>
  loginEmail(email: string, password: string): Promise<Session>

  // R1.1, R1.3
  loginTelegram(initData: TelegramInitData): Promise<Session>
  loginGoogle(idToken: string): Promise<Session>

  // R1.2 (24h)
  issueSession(userId: string, ttl = 24h): Promise<{ rawSessionToken: string; session: Session }>

  // R1.7 — bucketed by identity (email or external_identity)
  isRateLimited(identityKey: string): Promise<boolean>

  // R1.8 — used by AuthGuard
  resolveCurrentUser(req): Promise<User | null>

  logout(sessionId: string): Promise<void>
}
```

Password hashing: `argon2id` (memory ≥ 64 MB, time cost ≥ 3, parallelism ≥ 1). Sessions are server-side rows; the cookie holds a SHA-256-hashed lookup token (`Set-Cookie: bs_session=<raw>; HttpOnly; Secure; SameSite=Lax; Path=/`).

### DealService (`src/deal/`)

```ts
class DealService {
  create(actor: User, dto: CreateDealDto): Promise<DealRoomResponse>            // R2, R3
  getByPublicId(publicId: string, viewer: AuthContext): Promise<DealRoomResponse>
  invitePreview(publicId: string, inviteToken: string): Promise<InvitePreview>  // R4
  join(publicId: string, inviteToken: string, dto: JoinDto, actor: User): Promise<DealRoomResponse> // R5
  patchProduct(publicId: string, dto: ProductPatchDto, actor: User): Promise<DealRoomResponse>     // R7
  patchParticipant(publicId: string, dto: ParticipantPatchDto, actor: User): Promise<DealRoomResponse>
  approve(publicId: string, actor: User): Promise<DealRoomResponse>             // R8
  computeMissingFields(deal: DealRoom): MissingField[]                          // R6
  computeAllowedActions(deal: DealRoom, viewer: AuthContext): AllowedAction[]   // shared
  computeTermsHash(deal: DealRoom): string                                       // R8.1
  transition(deal: DealRoom, to: DealStatus, actor: User, tx: Tx): Promise<void> // single transition engine
}
```

The `transition` function is the only place `Deal_Status` is mutated. Every transition writes an `AuditLogEntry` in the same transaction (R20.1).

### WalletService (`src/wallet/`)

```ts
class WalletService {
  getOrCreate(userId: string, currency: Currency): Promise<Wallet>              // R14.6
  getBalance(walletId: string, tx?: Tx): Promise<Decimal>                       // R14.3
  getAvailableBalance(walletId: string, tx?: Tx): Promise<Decimal>              // = balance - sum(holds), R15.6

  payDealFromWallet(deal: DealRoom, buyer: User): Promise<DealRoomResponse>     // R9
  settleEscrowFromKhqr(deal: DealRoom, externalRef: string, tx: Tx): Promise<void> // R11.2, R11.4
  autoReleaseToSeller(deal: DealRoom): Promise<DealRoomResponse>                // R13.3

  // Withdrawal hooks
  placeWithdrawalHold(req: WithdrawalRequest, tx: Tx): Promise<void>            // R15.8
  recordWithdrawalPayout(req: WithdrawalRequest, payoutRef: string, tx: Tx): Promise<void> // R16.2
  releaseWithdrawalHold(req: WithdrawalRequest, reason: string, tx: Tx): Promise<void>     // R16.3
}
```

All methods that mutate balances open a transaction and acquire row-level locks (`SELECT ... FOR UPDATE`) on the affected wallet rows in a deterministic order (`wallet_id ASC`) to prevent deadlocks.

### KhqrGenerator / KhqrVerifier (`src/khqr/`)

```ts
class KhqrGenerator {
  // R10.1
  generate(input: { amount: Decimal; currency: Currency; receiver: BothSafeReceiver }):
    Promise<{ khqrString: string; pngBuffer: Buffer; referenceNote: string }>
}

class KhqrVerifier {
  // R11.1 — tries up to 3 times within 60s
  verifyByReferenceNote(deal: DealRoom): Promise<KhqrMatch | null>
}
```

`referenceNote` is generated as a 16-char base32 token (Crockford alphabet, no I/L/O/U) backed by a `UNIQUE` index on `deal_room.reference_note`. Two deals can never share a note.

### WithdrawalService (`src/withdrawal/`)

```ts
class WithdrawalService {
  create(seller: User, dto: CreateWithdrawalDto): Promise<WithdrawalRequest>    // R15
  list(filter: { status?: WithdrawalStatus }, page: PageCursor): Promise<Paginated<WithdrawalRequest>>
  get(id: string): Promise<WithdrawalRequest>
  approve(id: string, admin: User, dto: ApproveDto): Promise<WithdrawalRequest> // R16.2
  reject(id: string, admin: User, dto: RejectDto): Promise<WithdrawalRequest>   // R16.3
}
```

### NotificationService (`src/notification/`)

```ts
class NotificationOutboxService {
  // Called inside the originating DB transaction so dispatch and business
  // change land or fail together. R19.11 holds because dispatch happens
  // *after* commit.
  enqueue(event: NotificationEvent, recipients: Recipient[], tx: Tx): Promise<void>
}

class NotificationDispatcher {
  // Long-running drainer. Reads pending outbox rows, fans out to adapters.
  drain(): Promise<void>
}

interface NotificationAdapter {
  send(event: NotificationEvent, recipient: Recipient): Promise<void>
}
// Adapters: InAppAdapter (writes timeline row), TelegramAdapter, AdminQueueAdapter.
```

Outbox rows transition `pending → sent | failed` and carry a `last_error` column. Failed rows are retried with exponential backoff up to a cap; after the cap they remain in `failed` state and surface on a `/v1/admin/notifications/dead-letter` admin page (out of scope for this design beyond the data model).

### AuditService (`src/audit/`)

```ts
class AuditService {
  // R20.1–R20.3 — must be called inside the same tx as the originating action
  record(entry: NewAuditLogEntry, tx: Tx): Promise<void>
}
```

### StorageService (`src/storage/`)

Unchanged from `AGENTS.md` interface but the implementation now targets the local MinIO container. Generates short-lived (≤15 min) pre-signed `PUT` URLs for client uploads and pre-signed `GET` URLs for downloads. MIME and size limits (R10.6, R10.7, R12.4) are enforced server-side after upload completion using object metadata.

### Telegram Bot module (`src/bot/`)

Conversation state is kept in a Postgres-backed key-value table (`bot_conversation`) keyed by `telegram_chat_id`. The bot's handlers call `DealService.create(...)` directly (in-process); they do not perform HTTP calls to the API. See "Telegram bot design" section.

---

## Data Models

This section enumerates each persisted entity, its key fields, indexes, and constraints. All fields are PostgreSQL types; all primary keys are `cuid` strings stored as `TEXT` (we use cuid v2 for both PK and tokens — they sort lexicographically by creation time, which is helpful for paginated listings).

Notation: `T?` = nullable; `T!` = NOT NULL. Money columns use `NUMERIC(18,2)`. Timestamps use `TIMESTAMPTZ`.

### Postgres-level types and enums

```sql
-- Native Postgres ENUMs (mapped to Prisma enums one-to-one)
CREATE TYPE deal_status AS ENUM (
  'DRAFT','AWAITING_COUNTERPARTY','AWAITING_BOTH_APPROVAL','READY_FOR_PAYMENT',
  'PAYMENT_PENDING_VERIFICATION','PAID_ESCROWED','SELLER_PREPARING','SHIPPED',
  'BUYER_CONFIRMED','DISPUTED','RELEASE_PENDING','RELEASED','REFUNDED',
  'CANCELLED','EXPIRED'
);
CREATE TYPE currency AS ENUM ('USD','KHR');
CREATE TYPE participant_role AS ENUM ('buyer','seller','admin');
CREATE TYPE creator_source AS ENUM ('web','telegram');
CREATE TYPE preferred_lang AS ENUM ('km','en','zh');
CREATE TYPE withdrawal_status AS ENUM ('pending_admin_review','paid','rejected');
CREATE TYPE withdrawal_destination AS ENUM ('khqr','bank');
CREATE TYPE dispute_reason AS ENUM (
  'ITEM_NOT_RECEIVED','WRONG_ITEM','DAMAGED_ITEM','FAKE_ITEM','PAYMENT_PROBLEM','OTHER'
);
CREATE TYPE ledger_entry_type AS ENUM (
  'ESCROW_RECEIVED','PLATFORM_FEE_RESERVED','SELLER_PAYOUT_PENDING','SELLER_PAYOUT_SENT',
  'BUYER_REFUND_PENDING','BUYER_REFUND_SENT','ADJUSTMENT'
);
CREATE TYPE ledger_direction AS ENUM ('credit','debit');
CREATE TYPE notification_event AS ENUM (
  'COUNTERPARTY_JOINED','DEAL_UPDATED','BOTH_APPROVED','PAYMENT_PROOF_UPLOADED',
  'PAYMENT_VERIFIED','PAYMENT_REJECTED','SELLER_SHOULD_SHIP','SHIPPING_UPLOADED',
  'BUYER_CONFIRMED','DISPUTE_OPENED','PAYOUT_RELEASED','REFUND_COMPLETED',
  'WITHDRAWAL_REQUESTED','WITHDRAWAL_PAID','WITHDRAWAL_REJECTED','ADMIN_RELEASE_FAILED'
);
CREATE TYPE outbox_status AS ENUM ('pending','sent','failed');
```

### `User` and authentication

```
User
  id              TEXT PK (cuid v2)
  email           TEXT? UNIQUE      -- nullable: Telegram-only / Google-only users may not have email yet
  password_hash   TEXT?             -- argon2id; null when no email/password identity
  display_name    TEXT?
  preferred_lang  preferred_lang!  default 'en'
  is_admin        BOOLEAN!         default false
  created_at      TIMESTAMPTZ!     default now()
  updated_at      TIMESTAMPTZ!     default now()

ExternalIdentity
  id           TEXT PK
  user_id      TEXT! FK User.id
  provider     TEXT!             -- 'telegram' | 'google'
  external_id  TEXT!             -- telegram chat_id (numeric string) | google sub
  created_at   TIMESTAMPTZ!      default now()
  UNIQUE (provider, external_id)            -- R1.3 dedup
  INDEX (user_id)

Session
  id                TEXT PK
  user_id           TEXT! FK User.id
  token_hash        TEXT! UNIQUE        -- SHA-256 of cookie value
  expires_at        TIMESTAMPTZ!        -- now() + 24h (R1.2)
  revoked_at        TIMESTAMPTZ?
  created_at        TIMESTAMPTZ!  default now()
  user_agent        TEXT?
  ip_inet           INET?
  INDEX (user_id, expires_at)

AuthAttempt                              -- R1.7 sliding window
  id              BIGSERIAL PK
  identity_key    TEXT!             -- email or "tg:<id>" or "google:<sub>"
  ip_inet         INET?
  succeeded       BOOLEAN!
  attempted_at    TIMESTAMPTZ! default now()
  INDEX (identity_key, attempted_at)
```

### Deal Room and participants

```
DealRoom
  id                     TEXT PK
  public_id              TEXT! UNIQUE                -- the URL slug
  creator_user_id        TEXT! FK User.id
  creator_role           participant_role!           -- 'buyer' | 'seller'
  creator_source         creator_source!  default 'web'
  status                 deal_status!     default 'DRAFT'

  -- Product section (R7.1)
  product_title          TEXT?
  product_type           TEXT?
  product_description    TEXT?
  quantity               INTEGER?
  condition              TEXT?                       -- 'new' | 'used'
  deal_amount            NUMERIC(18,2)?
  currency               currency?

  -- Participant section (denormalised for terms hash; R8.1)
  buyer_name             TEXT?
  seller_name            TEXT?

  -- KHQR / payment
  reference_note         TEXT? UNIQUE                -- R10.1, generated when KHQR is requested
  khqr_payload_meta      JSONB?                      -- raw generator output for audit/replay

  -- Hash of canonical (product+participant) sections, kept in sync on every edit
  terms_hash             TEXT?

  -- Lifecycle
  created_at             TIMESTAMPTZ! default now()
  updated_at             TIMESTAMPTZ! default now()
  expires_at             TIMESTAMPTZ?                -- AWAITING_COUNTERPARTY → EXPIRED clock

  INDEX (status)
  INDEX (creator_user_id, created_at DESC)

DealParticipant
  id              TEXT PK
  deal_id         TEXT! FK DealRoom.id
  user_id         TEXT! FK User.id
  role            participant_role!                  -- 'buyer' | 'seller'
  joined_at       TIMESTAMPTZ! default now()
  phone           TEXT?
  preferred_lang  preferred_lang?
  telegram_chat_id TEXT?
  wechat_id        TEXT?
  messenger_name   TEXT?
  UNIQUE (deal_id, role)                             -- exactly one buyer + one seller
  UNIQUE (deal_id, user_id)
```

### Tokens

```
InviteToken
  id            TEXT PK
  deal_id       TEXT! FK DealRoom.id
  token_hash    TEXT! UNIQUE
  expires_at    TIMESTAMPTZ!
  invalidated_at TIMESTAMPTZ?
  created_at    TIMESTAMPTZ! default now()
  INDEX (deal_id)

CreatorAccessToken
  id            TEXT PK
  deal_id       TEXT! FK DealRoom.id UNIQUE
  user_id       TEXT! FK User.id
  token_hash    TEXT! UNIQUE
  created_at    TIMESTAMPTZ! default now()

ParticipantAccessToken
  id            TEXT PK
  deal_id       TEXT! FK DealRoom.id
  user_id       TEXT! FK User.id
  token_hash    TEXT! UNIQUE
  created_at    TIMESTAMPTZ! default now()
  UNIQUE (deal_id, user_id)
```

Raw token values are returned exactly once on creation/join (R2.9, R5.8). Storage of hashes only; no SQL function exists that returns a raw token.

### Approvals, proofs, dispute

```
Approval
  id           TEXT PK
  deal_id      TEXT! FK DealRoom.id
  user_id      TEXT! FK User.id
  role         participant_role!          -- 'buyer' | 'seller'
  terms_hash   TEXT!                      -- snapshot of deal.terms_hash at approval time (R8.1)
  invalidated_at TIMESTAMPTZ?             -- set on material edit (R7.3, R8.4)
  created_at   TIMESTAMPTZ! default now()
  INDEX (deal_id)
  -- Active approvals = invalidated_at IS NULL AND terms_hash = current deal.terms_hash

PaymentProof
  id              TEXT PK
  deal_id         TEXT! FK DealRoom.id
  buyer_user_id   TEXT! FK User.id
  paid_amount     NUMERIC(18,2)?
  buyer_note      TEXT?
  attachment_key  TEXT?                    -- MinIO object key
  attachment_mime TEXT?
  source          TEXT! default 'khqr_receipt'
  created_at      TIMESTAMPTZ! default now()
  INDEX (deal_id)

ShippingProof
  id              TEXT PK
  deal_id         TEXT! FK DealRoom.id
  seller_user_id  TEXT! FK User.id
  delivery_company TEXT?
  tracking_number  TEXT?
  package_photo_key TEXT?
  delivery_receipt_key TEXT?
  seller_note      TEXT?
  created_at       TIMESTAMPTZ! default now()
  INDEX (deal_id)

Confirmation
  id              TEXT PK
  deal_id         TEXT! FK DealRoom.id UNIQUE      -- one buyer-confirm per deal (R13.2)
  buyer_user_id   TEXT! FK User.id
  idempotency_key TEXT!                            -- see "Idempotency" below
  created_at      TIMESTAMPTZ! default now()
  UNIQUE (deal_id, idempotency_key)

Dispute
  id            TEXT PK
  deal_id       TEXT! FK DealRoom.id
  opener_user_id TEXT! FK User.id
  reason        dispute_reason!
  message       TEXT!
  status        TEXT! default 'open'              -- 'open' | 'resolved'
  resolution    TEXT?                              -- 'release' | 'refund'
  resolved_by   TEXT? FK User.id
  resolution_note TEXT?
  payout_reference TEXT?
  refund_reference TEXT?
  created_at    TIMESTAMPTZ! default now()
  resolved_at   TIMESTAMPTZ?
  INDEX (deal_id)
  -- Partial unique: at most one OPEN dispute per deal (R17.6)
  -- Implemented as: CREATE UNIQUE INDEX ON Dispute (deal_id) WHERE status='open';

DisputeEvidence
  id              TEXT PK
  dispute_id      TEXT! FK Dispute.id
  uploader_user_id TEXT! FK User.id
  attachment_key  TEXT!
  attachment_mime TEXT!
  created_at      TIMESTAMPTZ! default now()
```

### Wallet and ledger

```
Wallet
  id          TEXT PK
  user_id     TEXT! FK User.id
  currency    currency!
  created_at  TIMESTAMPTZ! default now()
  UNIQUE (user_id, currency)                       -- R14.6
  INDEX (user_id)

-- A single canonical platform-owned escrow wallet per currency.
-- It is a Wallet row owned by a designated "platform" User with is_admin=true.
-- We additionally mark it via WalletRole below for clarity.
WalletRole
  wallet_id   TEXT PK FK Wallet.id
  role        TEXT!                                 -- 'user' | 'escrow' | 'platform_fee'

WalletLedgerEntry
  id              BIGSERIAL PK
  wallet_id       TEXT! FK Wallet.id
  amount          NUMERIC(18,2)! CHECK (amount > 0)  -- R14.1: amount is unsigned, direction encodes sign
  currency        currency!
  direction       ledger_direction!
  entry_type      ledger_entry_type!
  related_deal_id TEXT? FK DealRoom.id              -- R14.1
  related_withdrawal_id TEXT? FK WithdrawalRequest.id
  external_ref    TEXT?                              -- Bakong transaction id, payout reference, etc.
  created_at      TIMESTAMPTZ(3)! default now()      -- millisecond precision (R14.1)
  INDEX (wallet_id, created_at DESC)                 -- hot path: ledger listing
  INDEX (related_deal_id)
  INDEX (related_withdrawal_id)
  -- APPEND-ONLY: enforced at DB level (see "Append-only enforcement" below)
```

### Withdrawal

```
WithdrawalRequest
  id                 TEXT PK
  seller_user_id     TEXT! FK User.id
  wallet_id          TEXT! FK Wallet.id
  amount             NUMERIC(18,2)!
  currency           currency!
  destination_type   withdrawal_destination!
  -- when destination = 'khqr'
  khqr_string        TEXT?
  khqr_image_key     TEXT?
  -- when destination = 'bank'
  bank_name          TEXT?
  bank_account_name  TEXT?
  bank_account_number TEXT?

  status             withdrawal_status! default 'pending_admin_review'
  payout_reference   TEXT?
  rejection_reason   TEXT?
  admin_note         TEXT?
  reviewed_by        TEXT? FK User.id
  reviewed_at        TIMESTAMPTZ?
  created_at         TIMESTAMPTZ! default now()
  INDEX (seller_user_id, created_at DESC)
  INDEX (status, created_at DESC)                    -- admin queue listing (R16.1)
```

### Audit log and notifications

```
AuditLogEntry
  id            BIGSERIAL PK
  action_type   TEXT!                                -- 'DEAL_STATUS_TRANSITION', 'WALLET_PAYMENT',
                                                    -- 'WITHDRAWAL_HOLD', 'WITHDRAWAL_PAYOUT',
                                                    -- 'WITHDRAWAL_RELEASE', 'ADMIN_PAYMENT_VERIFY', ...
  actor_user_id TEXT? FK User.id
  actor_role    participant_role?
  deal_id       TEXT? FK DealRoom.id
  withdrawal_id TEXT? FK WithdrawalRequest.id
  amount        NUMERIC(18,2)?
  currency      currency?
  prev_status   deal_status?
  new_status    deal_status?
  metadata      JSONB?
  created_at    TIMESTAMPTZ(3)! default now()        -- millisecond precision (R20.1–R20.3)
  INDEX (deal_id, created_at DESC)
  INDEX (actor_user_id, created_at DESC)
  INDEX (action_type, created_at DESC)
  -- APPEND-ONLY: enforced at DB level

NotificationOutboxEntry
  id             BIGSERIAL PK
  event          notification_event!
  recipient_kind TEXT!                                -- 'user' | 'admin_queue' | 'telegram_chat'
  recipient_id   TEXT?
  payload        JSONB!
  status         outbox_status! default 'pending'
  attempts       INTEGER! default 0
  last_error     TEXT?
  created_at     TIMESTAMPTZ! default now()
  sent_at        TIMESTAMPTZ?
  INDEX (status, created_at)                          -- drainer hot path
```

### Idempotency key dedup

```
IdempotencyKey
  key             TEXT PK                              -- client-supplied or derived
  scope           TEXT!                                -- 'confirm_received' | 'approve_withdrawal' | 'tg_create' | 'khqr_receipt'
  user_id         TEXT! FK User.id
  result_ref      TEXT?                                -- id of the entity created on first call
  created_at      TIMESTAMPTZ! default now()
  UNIQUE (scope, key, user_id)
```

### Append-only enforcement (R14.2, R20.5)

We use **DB-level enforcement** rather than relying solely on application code, because the requirements explicitly call out immutability of the wallet ledger and audit log.

Two layers:

1. **Privilege revocation.** The `app` role used by the NestJS connection has `INSERT, SELECT` only on `WalletLedgerEntry` and `AuditLogEntry`:
   ```sql
   REVOKE UPDATE, DELETE, TRUNCATE ON wallet_ledger_entry, audit_log_entry FROM app;
   GRANT INSERT, SELECT ON wallet_ledger_entry, audit_log_entry TO app;
   ```
2. **Trigger fallback** (defence in depth, also catches a misconfigured role):
   ```sql
   CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
   BEGIN RAISE EXCEPTION 'append-only: % rejected on %', TG_OP, TG_TABLE_NAME; END;
   $$ LANGUAGE plpgsql;
   CREATE TRIGGER walletledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
     ON wallet_ledger_entry FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
   CREATE TRIGGER auditlog_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
     ON audit_log_entry FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
   ```

Migration scripts run as a more privileged role (`migrator`) so Prisma can still apply schema changes. Application code therefore cannot UPDATE or DELETE these tables, satisfying R14.2 and R20.5 even if a service-layer bug attempts it.

### Available-balance derivation

R15.6 defines `available_balance = total_balance − sum(amount of WithdrawalRequests in pending_admin_review for this wallet)`. We implement this as a **service-layer function inside `WalletService`**, not a Postgres VIEW.

```ts
// src/wallet/wallet.service.ts
async getAvailableBalance(walletId: string, tx: Tx = this.prisma): Promise<Decimal> {
  // Lock the wallet row so concurrent withdrawal requests serialise on it.
  const wallet = await tx.$queryRaw<Wallet[]>`
    SELECT * FROM wallet WHERE id = ${walletId} FOR UPDATE
  `;
  if (!wallet[0]) throw new NotFoundException('wallet.not_found');

  const balance = await this.computeBalance(walletId, tx);          // sum of signed ledger entries
  const holds   = await this.sumPendingWithdrawals(walletId, tx);   // sum(amount) WHERE status='pending_admin_review'
  return balance.minus(holds);
}
```

**Why a service-layer function rather than a VIEW.** Three reasons:

1. **Unit-testability.** The withdrawal-hold rule is one of the most critical invariants in the system; we want to hammer it with property-based tests over generated ledger histories and pending-request sets without spinning up Postgres. A pure TypeScript function backed by repository interfaces is trivial to fuzz; a SQL VIEW is not.
2. **Composability with the row lock.** We always need to read the available balance under `SELECT ... FOR UPDATE` on the owning `Wallet` row to serialise concurrent withdrawal submissions. Wrapping the lock-then-compute pattern in a service method makes the contract explicit; a VIEW invites callers to read it without the lock.
3. **Single source of truth at the application boundary.** All withdrawal validation, balance display, and admin reconciliation already go through `WalletService`. Adding a SQL VIEW creates a second implementation that can drift; consolidating in the service avoids drift.

Two short SQL helpers back the function:

```sql
-- computeBalance(walletId)
SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END), 0)
FROM wallet_ledger_entry
WHERE wallet_id = $1;

-- sumPendingWithdrawals(walletId)
SELECT COALESCE(SUM(amount), 0)
FROM withdrawal_request
WHERE wallet_id = $1 AND status = 'pending_admin_review';
```

Both are constant-time given the existing `(wallet_id, created_at DESC)` and `(status, created_at DESC)` indexes for the ledger and withdrawal tables respectively.

---

## Key Algorithms and Decisions

### Deal terms hash (R8.1)

The deal terms hash is the canonical fingerprint of the material content that both parties approve. Two participants approve a deal when both their approvals reference the same `terms_hash` as the current deal row.

**Inputs.** Two named sections:

```ts
type ProductSection = {
  Product_Title:       string | null;
  Product_Type:        string | null;
  Product_Description: string | null;
  Quantity:            number | null;
  Condition:           'new' | 'used' | null;
  Deal_Amount:         string;          // Decimal as fixed-point string, "1234.50"
  Currency:            'USD' | 'KHR' | null;
};
type ParticipantSection = {
  Buyer_Name:  string | null;
  Seller_Name: string | null;
};
```

**Canonicalisation rules.**
1. Strings are trimmed; runs of internal whitespace are collapsed to a single space.
2. `Deal_Amount` is normalised to two-decimal fixed-point string (e.g. `"100.00"`, never `"100"` or `"100.0"`).
3. Each section is serialised as JSON with **sorted keys** and no whitespace.
4. The two sections are concatenated as `{"product":<P>,"participant":<Q>}` (sorted top-level keys).
5. SHA-256 over UTF-8 bytes; encode as lowercase hex.

```ts
const canonicalJson = (o: object) =>
  JSON.stringify(o, Object.keys(o).sort());

const computeTermsHash = (deal: DealRoom): string => {
  const product: ProductSection = sortKeys(normaliseProduct(deal));
  const participant: ParticipantSection = sortKeys(normaliseParticipants(deal));
  const canonical = `{"product":${canonicalJson(product)},"participant":${canonicalJson(participant)}}`;
  return sha256Hex(Buffer.from(canonical, 'utf8'));
};
```

The hash is stored on `DealRoom.terms_hash` and recomputed every time any field in either section is patched. Material edits (R7.3) — any change to `Product_Title`, `Product_Description`, `Deal_Amount`, or `Currency` — also call `Approval.invalidate_all_for(deal_id)` in the same transaction, so the active-approval predicate (`invalidated_at IS NULL AND terms_hash = deal.terms_hash`) flips to `false` for all stale approvals automatically.

### Atomic auto-release (R13.3, R20.2)

```ts
async autoReleaseToSeller(dealId: string): Promise<void> {
  await this.prisma.$transaction(async (tx) => {
    // 1. Re-load and lock both wallets in deterministic id order to avoid deadlocks.
    const deal = await tx.dealRoom.findUniqueOrThrow({ where: { id: dealId } });
    if (deal.status !== 'RELEASE_PENDING') throw new ConflictException('deal.invalid_state');

    const escrow  = await this.lockWallet(tx, this.escrowWalletIdFor(deal.currency));
    const seller  = await this.lockWallet(tx, await this.sellerWalletIdFor(deal));

    // 2. Append ledger debit on escrow + credit on seller (R14.1, R14.4)
    await tx.walletLedgerEntry.create({ data: {
      wallet_id: escrow.id, amount: deal.deal_amount, currency: deal.currency,
      direction: 'debit',  entry_type: 'SELLER_PAYOUT_PENDING', related_deal_id: deal.id,
    }});
    await tx.walletLedgerEntry.create({ data: {
      wallet_id: seller.id, amount: deal.deal_amount, currency: deal.currency,
      direction: 'credit', entry_type: 'SELLER_PAYOUT_SENT',    related_deal_id: deal.id,
    }});

    // 3. Status transition (R13.3) via the single transition engine
    await this.dealService.transition(deal, 'RELEASED', { kind: 'system', reason: 'auto_release' }, tx);

    // 4. Audit (R20.2)
    await this.audit.record({
      action_type: 'AUTO_RELEASE',
      actor_user_id: deal.buyer_user_id,
      deal_id: deal.id, amount: deal.deal_amount, currency: deal.currency,
      prev_status: 'RELEASE_PENDING', new_status: 'RELEASED',
    }, tx);

    // 5. Outbox (R19.6) — same tx; drainer dispatches after commit
    await this.outbox.enqueue('PAYOUT_RELEASED', recipientsFor(deal), tx);
  });
}
```

Failure modes:

- If any step throws inside the `$transaction`, Postgres rolls back the entire transaction. `Deal_Status` stays at `RELEASE_PENDING`, no ledger row is written, and no outbox row is enqueued.
- A separate background job re-checks deals stuck in `RELEASE_PENDING` for >5 minutes and emits an `ADMIN_RELEASE_FAILED` outbox event with the deal id and the last error from the audit metadata (R13.6).

### Wallet payment (R9.2)

Same shape as auto-release. The transaction holds row-level locks on the buyer wallet and the escrow wallet (in `wallet.id ASC` order), inserts two ledger entries (`debit` on buyer with `entry_type='ESCROW_RECEIVED'` flagged with `direction='debit'`; `credit` on escrow with same `entry_type='ESCROW_RECEIVED'`, `direction='credit'`), transitions `READY_FOR_PAYMENT → PAID_ESCROWED → SELLER_PREPARING` in the same transaction (R9.7), and writes a single `WALLET_PAYMENT` audit row.

### Withdrawal hold (R15.8)

```ts
async createWithdrawal(seller: User, dto: CreateWithdrawalDto): Promise<WithdrawalRequest> {
  return this.prisma.$transaction(async (tx) => {
    const wallet    = await this.getOrCreate(seller.id, dto.currency, tx);
    const available = await this.getAvailableBalance(wallet.id, tx);   // FOR UPDATE inside

    if (available.lt(dto.amount)) {
      throw new BadRequestException({ code: 'wallet.insufficient_balance', available, required: dto.amount });
    }

    const wr = await tx.withdrawalRequest.create({ data: { ...dto, wallet_id: wallet.id, status: 'pending_admin_review' }});

    await tx.walletLedgerEntry.create({ data: {
      wallet_id: wallet.id, amount: dto.amount, currency: dto.currency,
      direction: 'debit', entry_type: 'SELLER_PAYOUT_PENDING',
      related_withdrawal_id: wr.id,
    }});

    await this.audit.record({ action_type: 'WITHDRAWAL_HOLD', actor_user_id: seller.id, withdrawal_id: wr.id,
                              amount: dto.amount, currency: dto.currency }, tx);

    await this.outbox.enqueue('WITHDRAWAL_REQUESTED',
      [{ kind: 'admin_queue' }, { kind: 'user', recipient_id: seller.id }], tx);

    return wr;
  });
}
```

Important property: the `SELLER_PAYOUT_PENDING` ledger row is the formal hold record and contributes to the wallet's signed balance. We do **not** subtract holds twice — `available_balance = balance − sum(pending_amounts)` only because the hold ledger entry of a `pending_admin_review` request has the same amount as its `WithdrawalRequest.amount`. On approval (R16.2) we add a compensating `SELLER_PAYOUT_SENT` debit-then-payout pair (the hold debit stays); on rejection (R16.3) we add a compensating `ADJUSTMENT` credit that exactly cancels the hold. This keeps the ledger purely append-only while letting the balance tell the truth.

### KHQR `Reference_Note` strategy

- Format: 16-char Crockford base32 (alphabet `0-9 A-H J K M N P-T V-Z`, no `I L O U`) — case-insensitive, hard to mis-read.
- Persisted on `DealRoom.reference_note` with a `UNIQUE` index, so a collision raises a unique-violation rather than corrupt verification (R10.1, R11.1).
- Reused for the lifetime of the deal: if the buyer reloads the KHQR view, the same note is returned. Generating a new note would let two concurrent payments hit the same deal but be matched against only one of them.
- The `KhqrVerifier` polls the Bakong API every 10 s for up to 60 s with up to 3 retries on transient errors (R11.1). A match requires `Reference_Note` and `amount` and `currency` agreement.

### Outbox pattern for notifications (R19.11)

Every business write that needs to notify someone calls `NotificationOutboxService.enqueue(...)` inside the originating database transaction. The outbox row is therefore committed atomically with the business state.

```mermaid
flowchart LR
  A[Business write tx] -->|insert outbox row| OB[(NotificationOutbox)]
  OB --> D[Dispatcher worker]
  D -->|in-app| TL[(Timeline)]
  D -->|telegram| TG[Telegram API]
  D -->|admin queue| AQ[Admin notif queue]
  D -->|on success| OB
  D -->|on transient fail<br/>backoff retry| OB
```

- Successful sends mark the row `sent` and stamp `sent_at`.
- Transient failures increment `attempts` and schedule retry with exponential backoff (1m → 2m → 4m → 8m → 15m, capped at 5 retries).
- Permanent failure leaves the row `failed` with `last_error`. The outgoing change is **not** rolled back, satisfying R19.11.
- Because rows are inserted inside the originating transaction, we never have a "notification with no business effect" or vice-versa.

### Idempotency

Sensitive POST endpoints accept an `Idempotency-Key` header (UUID string). The middleware:

1. Looks up `(scope, key, user_id)` in `IdempotencyKey`.
2. **Cache hit (existing row)**: return the stored `result_ref` rendered as the standard response — the second call is a no-op. This protects R13.2 (`confirm_received` ignored on subsequent submissions), R16.2 (admin double-click on Approve), R18.11 (Telegram retries up to 3 times after Deal_Service failure).
3. **Cache miss**: insert the row in the same transaction as the business write. The unique `(scope, key, user_id)` constraint guarantees that two concurrent requests with the same key collapse to one.

Scopes used:

| Scope | Triggered by |
|---|---|
| `confirm_received` | `POST /v1/deals/:publicId/confirm-received` |
| `approve_withdrawal` | `POST /v1/admin/withdrawals/:id/approve` |
| `reject_withdrawal` | `POST /v1/admin/withdrawals/:id/reject` |
| `khqr_receipt` | `POST /v1/deals/:publicId/payment/khqr/receipt` |
| `tg_create` | Telegram bot deal creation (key = `<chat_id>:<conversation_id>`) |

### Token strategy

| Token | Storage | Issuance | Expiry / lifecycle |
|---|---|---|---|
| `Session.token_hash` | SHA-256 of cookie value | On login | 24 h (R1.2); revoked on logout |
| `CreatorAccessToken.token_hash` | SHA-256 of cuid v2 | On deal creation | Never expires; tied to deal lifetime |
| `ParticipantAccessToken.token_hash` | SHA-256 of cuid v2 | On counterparty join | Never expires; tied to deal lifetime |
| `InviteToken.token_hash` | SHA-256 of cuid v2 | On deal creation | `expires_at` (default 7 d), `invalidated_at` set on consume (R5.6); both checked on every read (R4.3, R5.7) |

Raw token values are returned exactly once in the API response that creates them. No endpoint ever returns a raw token a second time. Every comparison computes the hash of the candidate raw token and uses an indexed lookup against `token_hash`.

### Password hashing

`argon2id` via `argon2` npm package:

```
memoryCost   = 65536    (64 MiB)
timeCost     = 3
parallelism  = 4
hashLength   = 32 bytes
```

Hash format is the standard `$argon2id$v=19$m=...$t=3$p=4$<salt>$<hash>` string stored verbatim in `User.password_hash`. The stored salt is per-user; no global pepper.

### Rate limiting

Two layers of defence:

1. **NestJS `@nestjs/throttler`** at controller-level decorators (`@Throttle({ default: { limit: 30, ttl: 60_000 } })`):
   - `POST /v1/auth/email/login`, `POST /v1/auth/email/signup`, `POST /v1/auth/telegram`, `POST /v1/auth/google` — 5/min per IP, plus per-`identity_key` limit of 5/15 min via `AuthAttempt` table (R1.7).
   - `GET /v1/deals/:publicId/invite-preview` — 30/min per IP (R4.5).
2. **Nginx `limit_req_zone`** at the reverse proxy: 60/min per IP for `/v1/auth/*` and `/v1/deals/.+/invite-preview`, returning 429 to upstream blast.

Both layers are tuned so the Nginx ceiling is twice the application ceiling — the application limit is the authoritative one; Nginx is a safety net against application-bypass amplification.

---

## API Surface (`/v1` prefix)

All routes live under the `/v1` prefix. Existing `AGENTS.md` endpoints remain; the table below lists changes (auth requirements, body changes) and additions.

### Authentication

| Method | Path | Auth | Body | Response | Implements |
|---|---|---|---|---|---|
| POST | `/v1/auth/email/signup` | none | `{ email, password }` | `{ user, sessionExpiresAt }` + `Set-Cookie: bs_session` | R1.1, R1.4, R1.5, R1.9 |
| POST | `/v1/auth/email/login` | none | `{ email, password }` | `{ user, sessionExpiresAt }` + cookie | R1.1, R1.2, R1.6, R1.7 |
| POST | `/v1/auth/telegram` | none | `{ telegramInitData }` (signed by Telegram) | `{ user, sessionExpiresAt }` + cookie | R1.1, R1.3 |
| POST | `/v1/auth/google` | none | `{ idToken }` | `{ user, sessionExpiresAt }` + cookie | R1.1, R1.3 |
| POST | `/v1/auth/logout` | session | — | `204` | — |
| GET  | `/v1/auth/me` | session | — | `{ user }` | — |

### Wallet (new)

| Method | Path | Auth | Response | Implements |
|---|---|---|---|---|
| GET | `/v1/wallet/me` | session | `{ wallets: [{ id, currency, balance, available }] }` | R14.3, R15.6 |
| GET | `/v1/wallet/me/ledger?currency=&cursor=&limit=` | session | `{ entries: [...], nextCursor }` (cursor on `(created_at, id)`, default 50, max 200) | R14.1 |

### Deals (existing endpoints with auth changes)

All deal endpoints below now require an authenticated session **except** `GET /v1/deals/:publicId/invite-preview` which remains public (R4.4).

| Method | Path | Auth | Body | Response | Implements |
|---|---|---|---|---|---|
| POST | `/v1/deals` | session | `CreateDealDto` (role, names, product, amount, currency, optional fields) | `{ deal, creator_link, invite_link, raw_creator_token, raw_invite_token }` | R2, R3 |
| GET | `/v1/deals/:publicId/invite-preview?invite=...` | none, rate-limited | — | `{ product_title, deal_amount, currency }` or `{ error: 'invite.invalid' }` | R4 |
| GET | `/v1/deals/:publicId` | session OR creator/participant access token via cookie | — | `DealRoomResponse` (with `missing_fields` and `allowed_actions`, R6.2) | R5–R20 |
| POST | `/v1/deals/:publicId/join` | session, requires `?invite=` | `{ buyer_name? \| seller_name?, phone? }` | `{ deal, raw_participant_token }` | R5 |
| PATCH | `/v1/deals/:publicId/sections/product` | session, participant role | partial `ProductPatchDto` | `DealRoomResponse` | R7 |
| PATCH | `/v1/deals/:publicId/sections/participant` | session, owns target participant | partial participant fields | `DealRoomResponse` | R7.2, R7.6 |
| PATCH | `/v1/deals/:publicId/sections/delivery` | session, participant role | delivery fields | `DealRoomResponse` | R7 |
| PATCH | `/v1/deals/:publicId/sections/payout` | session, seller role | payout fields | `DealRoomResponse` | R7 |
| POST | `/v1/deals/:publicId/approval` | session, participant role | — | `DealRoomResponse` (`BOTH_APPROVED` event if applicable) | R8 |
| POST | `/v1/deals/:publicId/payment-proofs` | session, buyer role | multipart payment proof | `DealRoomResponse` | (legacy MVP path, kept) |
| POST | `/v1/deals/:publicId/shipping-proofs` | session, seller role | multipart shipping proof | `DealRoomResponse` | R12 |
| POST | `/v1/deals/:publicId/confirm-received` | session, buyer role; `Idempotency-Key` recommended | — | `DealRoomResponse` | R13 |
| POST | `/v1/deals/:publicId/disputes` | session, participant role | `{ reason, message, evidence_keys[] }` | `DealRoomResponse` | R17 |

### Payment (new — Wallet and KHQR options)

| Method | Path | Auth | Body | Response | Implements |
|---|---|---|---|---|---|
| POST | `/v1/deals/:publicId/payment/wallet` | session, buyer role | — | `DealRoomResponse` (`PAID_ESCROWED → SELLER_PREPARING`) | R9 |
| POST | `/v1/deals/:publicId/payment/khqr` | session, buyer role | — | `{ khqr_string, khqr_image_url, reference_note, amount_due, currency, receiver_name, bakong_account_id }` | R10.1, R10.2, R10.3 |
| POST | `/v1/deals/:publicId/payment/khqr/receipt` | session, buyer role; `Idempotency-Key` recommended | `{ paid_amount?, buyer_note?, attachment_key? }` | `DealRoomResponse` (`READY_FOR_PAYMENT → PAYMENT_PENDING_VERIFICATION`) | R10.4–R10.7 |
| POST | `/v1/storage/uploads/sign` | session | `{ kind: 'payment_receipt' \| 'shipping' \| 'dispute' \| 'withdrawal_khqr', mime, size }` | `{ object_key, put_url, expires_at }` | R10.6, R10.7, R12.4 |

### Withdrawal (new)

| Method | Path | Auth | Body | Response | Implements |
|---|---|---|---|---|---|
| POST | `/v1/withdrawals` | session, seller-eligible | `{ currency, amount, destination_type, ...destination_fields }` | `WithdrawalRequest` | R15 |
| GET  | `/v1/withdrawals/me?status=&cursor=&limit=` | session | `{ entries, nextCursor }` | R15 |
| GET  | `/v1/withdrawals/:id` | session, owner only | `WithdrawalRequest` | R15 |

### Admin

| Method | Path | Auth | Body | Response | Implements |
|---|---|---|---|---|---|
| GET  | `/v1/admin/withdrawals?status=&cursor=&limit=` | admin session | — | paginated list (max 50/page) | R16.1 |
| GET  | `/v1/admin/withdrawals/:id` | admin session | — | `WithdrawalRequest` | R16.1 |
| POST | `/v1/admin/withdrawals/:id/approve` | admin session; `Idempotency-Key` | `{ payout_reference, admin_note? }` | `WithdrawalRequest` | R16.2, R20.3 |
| POST | `/v1/admin/withdrawals/:id/reject` | admin session; `Idempotency-Key` | `{ rejection_reason, admin_note? }` | `WithdrawalRequest` | R16.3, R20.3 |
| GET  | `/v1/admin/deals` | admin session | paginated list, filter by status | (existing) |
| POST | `/v1/admin/payment-proofs/:id/verify` | admin session | — | `DealRoomResponse` | R11.4, R11.8 |
| POST | `/v1/admin/payment-proofs/:id/reject` | admin session | `{ rejection_reason }` | `DealRoomResponse` | R11.5, R11.7 |
| POST | `/v1/admin/deals/:id/release` | admin session | `{ payout_reference, admin_note? }` | `DealRoomResponse` | R17.7 |
| POST | `/v1/admin/deals/:id/refund` | admin session | `{ refund_reference, admin_note? }` | `DealRoomResponse` | R17.8 |

### Standard `DealRoomResponse` shape

Every endpoint that returns a deal includes:

```ts
type DealRoomResponse = {
  deal: { public_id, status, product, participants, currency, deal_amount, ...},
  missing_fields: MissingField[],          // R6.2 — empty array when complete
  allowed_actions: AllowedAction[],        // viewer-scoped (R6.3, R9.1, R12.1, R13.1, R17.1)
  message_key?: string,                    // i18n key for any banner/toast (AGENTS.md rule)
};
type AllowedAction =
  | 'edit_product' | 'edit_participant' | 'approve'
  | 'pay_from_wallet' | 'pay_khqr' | 'submit_khqr_receipt'
  | 'submit_shipping_proof' | 'confirm_received' | 'open_dispute';
```

---

## Frontend Design

Stack: Next.js (App Router, TypeScript), Tailwind CSS, `next-intl` (`km`, `en`, `zh`).

### Route map

| Route | Auth | Purpose |
|---|---|---|
| `/` | public | Landing page |
| `/auth/login` | public | Email/Telegram/Google login (renders provider-specific buttons) |
| `/auth/signup` | public | Email signup |
| `/wallet` | session | Wallet balance per currency + ledger list |
| `/wallet/withdraw` | session | Submit withdrawal request (KHQR or bank toggle) |
| `/deals/new` | session | Create Deal Room (role buyer or seller) |
| `/d/[publicId]` | session OR access token cookie | Deal Room — shared URL |
| `/d/[publicId]?invite=...` | public preview, then session prompt | Counterparty join |
| `/admin/login` | public | Admin login |
| `/admin/withdrawals` | admin session | Withdrawal review queue |
| `/admin/withdrawals/[id]` | admin session | Withdrawal detail + approve/reject |
| `/admin/deals` | admin session | Existing admin deal table |
| `/admin/deals/[dealId]` | admin session | Existing admin deal detail |

### Component inventory

Existing (from `AGENTS.md`):

```
LanguageSwitcher  StatusBadge  DealStatusCard  ProductCard  ParticipantCard
PriceSummaryCard  EscrowExplanationCard  MissingFieldsChecklist  Timeline
PrimaryActionBar  CopyLinkButton  ImageUploader  ReceiptUploader  ConfirmDialog
DisputeForm
AdminDealTable  AdminDealFilters  PaymentProofViewer  ShippingProofViewer
DisputeEvidenceViewer  AdminActionPanel  AdminNoteBox
```

Added by this spec:

| Component | Purpose | Used on |
|---|---|---|
| `WalletBalanceCard` | Show balance + available per currency | `/wallet`, `/d/[publicId]` (buyer side) |
| `WalletLedgerList` | Cursor-paginated ledger view | `/wallet` |
| `WithdrawalForm` | Toggle KHQR-or-bank; field validation | `/wallet/withdraw` |
| `KhqrPaymentPanel` | KHQR image, Reference_Note copy, amount, `Open Bakong App` deeplink button | `/d/[publicId]` (buyer side, `READY_FOR_PAYMENT`) |
| `KhqrVerificationStatus` | Polling status banner during the 60 s window | same |
| `AdminWithdrawalTable` | Admin list with status filter, paginated | `/admin/withdrawals` |
| `AdminWithdrawalDetail` | Detail view with approve/reject inline forms | `/admin/withdrawals/[id]` |

### State strategy

- **Server components** for all reads (`/d/[publicId]`, `/wallet`, `/admin/*`). The page fetches via the backend's REST API on the server, attaching the `bs_session` cookie. No client-side fetching for the initial render.
- **Server actions** for mutations (`approve`, `pay_from_wallet`, `submit_khqr_receipt`, `confirm_received`, `submit_shipping_proof`, dispute, withdrawal). Actions reuse the same DTOs as the REST endpoints so types are shared.
- **Client components** only for stateful UI (uploaders, KHQR polling, language switch).
- **Auth.** Session is an `httpOnly`, `Secure`, `SameSite=Lax` cookie. The frontend never reads the session token in JS. Protected pages check for `getCurrentUser()` (which reads the cookie server-side) and redirect to `/auth/login?next=...` when absent (R1.8).

### Mobile-first / accessibility rules

- Sticky bottom action bar (`PrimaryActionBar`) on every Deal Room view.
- All actionable controls have a minimum 44×44 px tap target.
- Buyer view never renders the seller payout KHQR (`AGENTS.md` Frontend Coding Rules; enforced both server-side via `allowed_actions` filtering and client-side via separate components).
- Raw access tokens never appear in `console.log`, error toasts, or breadcrumbs. The frontend only handles them once: when shown to the creator after deal creation, accompanied by `bot.link.private_warning` copy.

### KHQR display flow

1. Buyer in `READY_FOR_PAYMENT` clicks `Pay with KHQR`.
2. Server action calls `POST /v1/deals/:publicId/payment/khqr` → renders `KhqrPaymentPanel`.
3. Panel shows the PNG (≥ 256×256 px), the `Reference_Note`, the amount, and a deeplink button (`bakong://pay?...` on Android, `bakongkhqr://` on iOS, falling back to a copy-to-clipboard).
4. After the buyer reports paying, they fill the optional receipt form and submit `POST /v1/deals/:publicId/payment/khqr/receipt`.
5. The page polls `GET /v1/deals/:publicId` every 5 s for up to 70 s (covers the 60 s verification window plus margin) to render the new status. The polling is implemented via a small client component, not SWR, to keep dependencies minimal.

---

## Telegram Bot Design

The bot module lives at `src/bot/` inside the NestJS process. It uses `node-telegram-bot-api` (or `telegraf`) configured for long-poll in development and webhook in production (via Nginx → backend `/v1/telegram/webhook`).

### Conversation state machine for `/newdeal` (R18)

```mermaid
stateDiagram-v2
  [*] --> ASK_ROLE: /newdeal or "Create deal" pressed
  ASK_ROLE --> ASK_TITLE: role chosen (R18.2)
  ASK_TITLE --> ASK_AMOUNT: valid Product_Title (R18.3)
  ASK_TITLE --> ASK_TITLE: invalid (R18.12)
  ASK_AMOUNT --> ASK_TYPE_SELLER: valid amount AND role=seller (R18.5)
  ASK_AMOUNT --> ASK_DESC_BUYER: valid amount AND role=buyer (R18.6)
  ASK_AMOUNT --> ASK_AMOUNT: invalid (R18.12)
  ASK_TYPE_SELLER --> ASK_DESC_SELLER: provided OR /skip
  ASK_DESC_SELLER --> CREATE: provided OR /skip
  ASK_DESC_BUYER --> CREATE: provided OR /skip
  CREATE --> SUCCESS: Deal_Service.create OK (R18.7)
  CREATE --> RETRY_PROMPT: Deal_Service failed (R18.11)
  RETRY_PROMPT --> CREATE: user retries (≤3)
  RETRY_PROMPT --> [*]: 3 retries exhausted, abort
  SUCCESS --> [*]
  ASK_ROLE --> [*]: /cancel (R18.13)
  ASK_TITLE --> [*]: /cancel
  ASK_AMOUNT --> [*]: /cancel
  ASK_TYPE_SELLER --> [*]: /cancel
  ASK_DESC_SELLER --> [*]: /cancel
  ASK_DESC_BUYER --> [*]: /cancel
```

Conversation state is persisted in a `bot_conversation` table keyed by `telegram_chat_id`:

```
BotConversation
  telegram_chat_id  TEXT PK
  state             TEXT          -- 'ASK_ROLE' | 'ASK_TITLE' | ...
  partial_payload   JSONB         -- fields collected so far
  retries           INTEGER default 0
  updated_at        TIMESTAMPTZ default now()
```

This survives container restarts and lets the bot run with multiple replicas if needed.

### Direct service call (no HTTP)

```ts
@Injectable()
export class BotDealCreator {
  constructor(private readonly dealService: DealService, private readonly users: UserService) {}

  async createFromConversation(chatId: string, payload: BotDealPayload): Promise<DealRoomResponse> {
    const user = await this.users.upsertFromTelegram(chatId);
    const idempotencyKey = `${chatId}:${payload.conversation_id}`;
    return this.dealService.create(user, mapBotPayloadToDto(payload), { idempotencyKey, scope: 'tg_create' });
  }
}
```

The same DTO contract used by `POST /v1/deals` is reused — there is no bot-specific `DealService` method.

### Failure handling and retry (R18.11)

- On `DealService.create` failure, the bot keeps `partial_payload` intact and asks the user to retry by tapping a `Retry` inline button.
- After 3 retries, the bot sends `bot.error.deal_create_failed` and resets the conversation; the partial data is discarded.

### `/cancel` handling (R18.13)

`/cancel` is recognised in any non-terminal state. The handler deletes the `BotConversation` row for the chat id and replies with `bot.menu.create_deal` to put the user back at the main menu.

### Notifications via Telegram

The Telegram adapter inside `NotificationDispatcher` reads outbox rows where `recipient_kind='user'` whose user has a Telegram external identity, and sends a message that includes:

- A short event-specific localised body.
- An inline keyboard with a single `Open Deal Room` button linking to `https://bothsafe.app/d/{publicId}`.

The bot token is read from `BOT_TELEGRAM_TOKEN` env. It is never logged, never echoed back to a user, and never appears in any audit row.

---

## Cross-Cutting Concerns

### Security

- **Token hashing.** All access tokens (creator, participant, invite, session) stored as SHA-256. Raw tokens returned exactly once.
- **Password hashing.** `argon2id` (parameters above). No plaintext password ever logged or stored.
- **Append-only ledger and audit.** DB-level: revoked UPDATE/DELETE on `wallet_ledger_entry` and `audit_log_entry` for the app role, plus mutation-rejecting triggers as defence in depth.
- **CORS.** NestJS `enableCors({ origin: process.env.FRONTEND_ORIGIN, credentials: true })`. Wildcard origins are forbidden in production.
- **Rate limiting.** Two layers — NestJS `@Throttle` and Nginx `limit_req_zone`.
- **Secrets.** Provided via `.env` mounted into the backend container. `.env` is in `.gitignore`. Bot token, Postgres password, MinIO root password, JWT signing key for admin sessions all live there.
- **Logging.** Structured JSON via `pino`. A redaction list strips `password`, `password_hash`, `token`, `raw_*_token`, `Authorization`, `Cookie`, `BOT_TELEGRAM_TOKEN`, and any field matching `*_secret`.

### Observability

- **Correlation id.** Nginx adds `X-Request-Id`; the backend's logging middleware attaches the value to every log line and propagates it to outgoing Telegram and Bakong calls.
- **Audit log.** The `AuditLogEntry` table is the canonical record for compliance review. Admin UI exposes a per-deal and per-withdrawal audit timeline.
- **Container logs.** Captured by `docker compose logs`; in production, redirected to a host-side `journald` to avoid container-local rotation.
- **Healthchecks.** `/v1/health` returns `{ db: ok, minio: ok }`. Used by Docker Compose and Nginx upstream health probe.

### Performance budgets

| Requirement | Budget | How met |
|---|---|---|
| R4.1 — invite preview | 2 s | Single indexed lookup on `invite_token.token_hash` + a single `SELECT` from `deal_room`; no joins. |
| R10.2 — KHQR display | 3 s | KHQR string + PNG generated locally in `KhqrGenerator` (no external call); cached on `DealRoom.khqr_payload_meta` after first generation. |
| R9.2 / R13.3 — wallet ops | 5 s | Single `$transaction` with two row locks and ≤4 INSERTs; well under typical Postgres latency budget on a single VPS. |
| R11.1 — KHQR verify | 60 s window, ≤3 retries | Polling job with 10 s interval; gives up after 3 failures or 60 s, whichever first. |
| R19.1–R19.9 — notifications | 5 s | Outbox drainer runs every 1 s with batch size 50; in-app and admin-queue dispatch is in-process. Telegram adapter has a 4 s timeout per call. |

### Property-based testing hooks

The implementation surface is shaped to make these properties easy to fuzz:

- **Pure `WalletService.computeBalance`** (signed sum over a list of ledger entries). Property-tested directly without DB.
- **Pure `Approval.areBothApproved(approvals, currentTermsHash)`**. Property-tested.
- **Pure `DealService.computeMissingFields(deal)`**. Property-tested.
- **Pure `DealService.allowedTransitions(currentStatus)`**. Property-tested.
- **Pure `computeTermsHash(deal)`**. Property-tested for canonicalisation.
- **`IdempotencyMiddleware` over a key, business handler, and a chaos-failure injector**. Property-tested.

For atomicity properties (no orphan ledger rows after rollback) we use Postgres testcontainers in CI.

---

## Deployment Topology

### `docker-compose.yml` outline

```yaml
services:
  nginx:
    image: nginx:1.27-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/conf.d:/etc/nginx/conf.d:ro
      - letsencrypt:/etc/letsencrypt
    depends_on: [frontend, backend, minio]
    restart: unless-stopped

  frontend:
    build: ./frontend
    environment:
      - NEXT_PUBLIC_API_BASE=https://bothsafe.app/v1
      - NODE_ENV=production
    expose: ["3000"]
    depends_on: [backend]
    restart: unless-stopped

  backend:
    build: ./backend
    environment:
      - DATABASE_URL=postgres://app:${POSTGRES_PASSWORD}@postgres:5432/bothsafe
      - MINIO_ENDPOINT=http://minio:9000
      - MINIO_ACCESS_KEY=${MINIO_ROOT_USER}
      - MINIO_SECRET_KEY=${MINIO_ROOT_PASSWORD}
      - MINIO_BUCKET=bothsafe
      - FRONTEND_ORIGIN=https://bothsafe.app
      - BOT_TELEGRAM_TOKEN=${BOT_TELEGRAM_TOKEN}
      - GOOGLE_OAUTH_CLIENT_ID=${GOOGLE_OAUTH_CLIENT_ID}
      - SESSION_SECRET=${SESSION_SECRET}
      - BAKONG_API_BASE=${BAKONG_API_BASE}
      - BAKONG_API_TOKEN=${BAKONG_API_TOKEN}
    expose: ["3001"]
    depends_on:
      postgres: { condition: service_healthy }
      minio:    { condition: service_healthy }
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3001/v1/health"]
      interval: 10s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_DB=bothsafe
      - POSTGRES_USER=app
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./ops/backups:/backups
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d bothsafe"]
      interval: 10s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      - MINIO_ROOT_USER=${MINIO_ROOT_USER}
      - MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}
    volumes:
      - minio-data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/ready"]
      interval: 10s
      timeout: 3s
      retries: 5
    restart: unless-stopped

volumes:
  postgres-data:
  minio-data:
  letsencrypt:
```

Notes:

- Only `nginx` exposes host ports (`80`, `443`). All other services use `expose:` so they are reachable only on the internal Docker network.
- Backend depends on healthy `postgres` and `minio` so it does not start until both are accepting connections.
- A separate `migrator` one-shot service can be added for `prisma migrate deploy` runs.

### Nginx config sketch

```
http {
  limit_req_zone $binary_remote_addr zone=auth:10m rate=60r/m;
  limit_req_zone $binary_remote_addr zone=invite:10m rate=120r/m;

  upstream frontend_up { server frontend:3000; }
  upstream backend_up  { server backend:3001;  }
  upstream minio_up    { server minio:9000;    }

  server {
    listen 80;
    server_name bothsafe.app s3.bothsafe.app;
    return 301 https://$host$request_uri;
  }

  server {
    listen 443 ssl http2;
    server_name bothsafe.app;
    ssl_certificate     /etc/letsencrypt/live/bothsafe.app/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bothsafe.app/privkey.pem;

    client_max_body_size 12m;     # covers 10 MB attachments + headroom

    location /v1/auth/ {
      limit_req zone=auth burst=20 nodelay;
      proxy_pass http://backend_up;
      proxy_set_header X-Request-Id $request_id;
    }
    location ~ ^/v1/deals/[^/]+/invite-preview$ {
      limit_req zone=invite burst=40 nodelay;
      proxy_pass http://backend_up;
    }
    location /v1/ {
      proxy_pass http://backend_up;
      proxy_set_header X-Request-Id $request_id;
    }
    location / {
      proxy_pass http://frontend_up;
    }
  }

  server {
    listen 443 ssl http2;
    server_name s3.bothsafe.app;
    ssl_certificate     /etc/letsencrypt/live/bothsafe.app/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bothsafe.app/privkey.pem;
    location / {
      proxy_pass http://minio_up;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
    }
  }
}
```

### Backups

- **Postgres.** Cron job on the host runs `pg_dump -Fc` nightly into `/var/bothsafe/backups/postgres/$(date +%F).dump`. Files retained 14 days. (The `./ops/backups` mount in the compose file points to the same host directory.) Periodic restore tests run quarterly.
- **MinIO.** Lifecycle policy: keep all current versions; objects flagged stale by the cleanup job are moved to a `cold/` bucket prefix and retained 90 days before expiry.
- Both backups live on the same VPS for the MVP. Off-site replication is a follow-up.

### TLS

- Certificates issued by Let's Encrypt via `certbot certonly --webroot` with the webroot mounted into Nginx.
- Renewal is a host cron (`0 3 * * *`) that runs `certbot renew --deploy-hook "docker compose exec nginx nginx -s reload"`.

