# BothSafe — Agent Guide


## Project Overview

BothSafe is an escrow-based payment protection platform for Cambodia's social commerce ecosystem. Buyers and sellers transact through chat apps (Telegram, Messenger, WeChat, Facebook). BothSafe holds payment in escrow until delivery is confirmed.

Core product: **Deal Room Link** — a shareable URL that both parties use to complete a protected transaction.

---

## Repository Structure

```
/both-safe
  /backend          ← NestJS API + Telegram bot module
  /frontend         ← Next.js web app
  /tasks            ← Detailed per-layer task breakdowns
    backend_task.md
    frontend_task.md
    bot_task.md
  README.md         ← Full product spec
  AGENTS.md         ← This file
```
 ** NOTE: When udpate the frontend also update the telegram to make the frontend and the telgram both flow is the same.
---

## Infrastructure

### Database

MySQL runs in a **local Docker container**.

- Do not add another relational database service to the project.
- Use the MySQL service from the project Docker setup.
- Connect using environment variables from `.env` in `/backend`.
- Use **Prisma** as the ORM with the MySQL provider.
- Run `npx prisma migrate dev` for schema changes locally.
- Run `npx prisma db seed` to seed test data.

### File Storage

MinIO runs in the same local Docker setup as MySQL and is the MVP object storage provider.

- Do not use external object storage providers for the MVP.
- Configure MinIO endpoint, bucket, access key, and secret key via environment variables from `.env` in `/backend`.
- Use MinIO for payment proofs, product images, shipping proofs, and dispute evidence.

---

## Backend — `/backend`

**Framework:** NestJS (TypeScript)  
**ORM:** Prisma  
**DB:** MySQL (local Docker)  
**API prefix:** `/v1`

### Current state

Bootstrapped NestJS project. No modules implemented yet.

### Module Map

| Module | Path | Responsibility |
|---|---|---|
| Auth | `src/auth/` | Anonymous participant tokens, admin login, JWT guards |
| Deal | `src/deal/` | Deal Room lifecycle, status engine, missing field calculator |
| Invite | `src/invite/` | Secure token generation, invite URL, creator URL |
| Payment | `src/payment/` | Payment proof upload, admin verify/reject, ledger creation |
| Ledger | `src/ledger/` | Append-only financial records |
| Shipping | `src/shipping/` | Seller shipping proof upload |
| Confirmation | `src/confirmation/` | Buyer confirm received, release pending trigger |
| Dispute | `src/dispute/` | Open dispute, evidence upload, admin resolve |
| Admin | `src/admin/` | Admin-only endpoints: deal list, payment verify, release/refund |
| Notification | `src/notification/` | Event-based notifications: in-app timeline + Telegram adapter |
| Storage | `src/storage/` | File upload validation, signed URLs, object storage integration |
| Telegram Bot | `src/bot/` | Bot commands, conversation state, notification adapter |
| Prisma | `src/prisma/` | Prisma service, shared DB client |

### Deal Status Enum

All three layers (backend, frontend, bot) must use this exact enum. Never add intermediate statuses.

```
DRAFT
AWAITING_COUNTERPARTY
AWAITING_BOTH_APPROVAL
READY_FOR_PAYMENT
PAYMENT_PENDING_VERIFICATION
PAID_ESCROWED
SELLER_PREPARING
SHIPPED
BUYER_CONFIRMED
DISPUTED
RELEASE_PENDING
RELEASED
REFUNDED
CANCELLED
EXPIRED
```

### API Contract

All routes use `/v1` prefix.

| Method | Path | Who calls it |
|---|---|---|
| POST | `/v1/deals` | Frontend, Bot |
| GET | `/v1/deals/:publicId` | Frontend, Bot |
| POST | `/v1/deals/:publicId/join` | Frontend |
| PATCH | `/v1/deals/:publicId/sections/product` | Frontend |
| PATCH | `/v1/deals/:publicId/sections/participant` | Frontend |
| PATCH | `/v1/deals/:publicId/sections/delivery` | Frontend |
| PATCH | `/v1/deals/:publicId/sections/payout` | Frontend |
| POST | `/v1/deals/:publicId/approval` | Frontend |
| POST | `/v1/deals/:publicId/payment-proofs` | Frontend |
| POST | `/v1/deals/:publicId/shipping-proofs` | Frontend |
| POST | `/v1/deals/:publicId/confirm-received` | Frontend |
| POST | `/v1/deals/:publicId/disputes` | Frontend |
| GET | `/v1/admin/deals` | Admin dashboard |
| POST | `/v1/admin/payment-proofs/:id/verify` | Admin dashboard |
| POST | `/v1/admin/payment-proofs/:id/reject` | Admin dashboard |
| POST | `/v1/admin/deals/:id/release` | Admin dashboard |
| POST | `/v1/admin/deals/:id/refund` | Admin dashboard |

### Core Domain Rules

1. **Buyer pays BothSafe, not seller.** Seller KHQR is payout-only.
2. **Either side can create the Deal Room.** `creator_role` is stored.
3. **Both sides must exist and approve before payment.** No skipping.
4. **Lock price, product, payout info after payment.** Admin override only.
5. **Admin manually verifies payments and releases money.** No automatic movement in MVP.
6. **Every important action must be audited.** Write to audit log.

### Token Strategy

- Anonymous participants get a hashed access token.
- Creator gets a separate `creator_access_token`.
- Counterparty gets `participant_access_token` after joining.
- Tokens are hashed in DB. Raw token only returned once.
- Admin uses separate JWT login.

### Notification Events

Backend emits these events; the Notification Module dispatches them:

```
COUNTERPARTY_JOINED
DEAL_UPDATED
BOTH_APPROVED
PAYMENT_PROOF_UPLOADED
PAYMENT_VERIFIED
PAYMENT_REJECTED
SELLER_SHOULD_SHIP
SHIPPING_UPLOADED
BUYER_CONFIRMED
DISPUTE_OPENED
PAYOUT_RELEASED
REFUND_COMPLETED
```

### Ledger Entry Types

```
ESCROW_RECEIVED
PLATFORM_FEE_RESERVED
SELLER_PAYOUT_PENDING
SELLER_PAYOUT_SENT
BUYER_REFUND_PENDING
BUYER_REFUND_SENT
ADJUSTMENT
```

Ledger is append-only. Never delete or silently update entries.

### Backend Coding Rules

- Use `class-validator` DTOs on all inputs.
- All module services use the shared `PrismaService`.
- Never perform status transitions outside the Deal service's transition engine.
- Return `missing_fields` and `allowed_actions` on every deal response.
- Return `message_key` (not hardcoded text) for all user-facing messages.
- Rate-limit public endpoints (throttler).
- Store token hashes, never raw tokens.
- CORS: allow only the configured frontend domain.

---

## Frontend — `/frontend`

**Framework:** Next.js (TypeScript, App Router)  
**Styling:** Tailwind CSS  
**i18n:** `next-intl` or equivalent, supports `km`, `en`, `zh`

### Current state

Bootstrapped Next.js project. Only default `app/page.tsx` and `app/layout.tsx` exist.

### Route Map

| Route | Purpose |
|---|---|
| `/` | Public landing page |
| `/deals/new` | Create Deal Room (buyer or seller) |
| `/d/[publicId]` | Deal Room page — main shared URL |
| `/d/[publicId]?invite=xxx` | Counterparty join state |
| `/admin` | Admin login |
| `/admin/deals` | Admin deal table |
| `/admin/deals/[dealId]` | Admin deal detail |

### Page-to-API Mapping

| Page / Action | API |
|---|---|
| Create deal | `POST /v1/deals` |
| Load Deal Room | `GET /v1/deals/{publicId}` |
| Join deal | `POST /v1/deals/{publicId}/join` |
| Edit product | `PATCH /v1/deals/{publicId}/sections/product` |
| Edit participant | `PATCH /v1/deals/{publicId}/sections/participant` |
| Edit delivery | `PATCH /v1/deals/{publicId}/sections/delivery` |
| Edit payout | `PATCH /v1/deals/{publicId}/sections/payout` |
| Approve | `POST /v1/deals/{publicId}/approval` |
| Upload payment proof | `POST /v1/deals/{publicId}/payment-proofs` |
| Upload shipping proof | `POST /v1/deals/{publicId}/shipping-proofs` |
| Confirm received | `POST /v1/deals/{publicId}/confirm-received` |
| Open dispute | `POST /v1/deals/{publicId}/disputes` |
| Admin verify payment | `POST /v1/admin/payment-proofs/{id}/verify` |
| Admin reject payment | `POST /v1/admin/payment-proofs/{id}/reject` |
| Admin release | `POST /v1/admin/deals/{id}/release` |
| Admin refund | `POST /v1/admin/deals/{id}/refund` |

### Shared Components

```
LanguageSwitcher
StatusBadge
DealStatusCard
ProductCard
ParticipantCard
PriceSummaryCard
EscrowExplanationCard
MissingFieldsChecklist
Timeline
PrimaryActionBar
CopyLinkButton
ImageUploader
ReceiptUploader
ConfirmDialog
DisputeForm
```

### Admin Components

```
AdminDealTable
AdminDealFilters
PaymentProofViewer
ShippingProofViewer
DisputeEvidenceViewer
AdminActionPanel
AdminNoteBox
```

### i18n Key Structure

All user-visible text must use translation keys. No hardcoded strings in components.

```
common.next
common.back
common.cancel
deal.create.title
deal.role.buyer
deal.role.seller
deal.status.draft
deal.status.ready_for_payment
payment.upload_proof
shipping.upload_proof
dispute.reason.wrong_item
admin.payment.verify
```

### Frontend Coding Rules

- Never invent deal statuses. Use the exact backend enum.
- Render allowed actions from `allowed_actions` in the API response — do not hardcode permission logic.
- Store participant access token in secure `httpOnly` cookie or `localStorage` with `keep this link safe` warning.
- Mobile-first. Minimum tap targets 44px. Sticky bottom action bar on deal pages.
- Client-side validate file type and size before upload.
- Admin routes require server-side session check.
- Never expose raw access tokens in console logs.
- Do not show seller payout KHQR to buyer.

---

## Telegram Bot — `/backend/src/bot/`

The bot runs **inside the NestJS backend** as a module. It is not a separate service.

### What the bot does

- `/start` — welcome, show menu, store Telegram chat id
- `/newdeal` — guided deal creation (buyer or seller role)
- `/mydeals` — show latest deals for this Telegram chat id
- `/help` — explain escrow in simple language
- Receive notification events and push messages to users
- Send website links with inline keyboard buttons

### What the bot does NOT do in MVP

- Upload payment proof inside Telegram
- Collect seller payout KHQR inside chat
- Admin money release via bot
- Automatic payment verification

### Bot Rules

- Bot calls `DealService` directly (same NestJS process), not HTTP.
- The request/response shape must still match the public API contract.
- No bot-only deal logic. All business rules live in Deal and Payment services.
- Notification failure must not roll back a deal status update.
- Rate-limit deal creation per `telegram_chat_id`.
- Never log the bot token.
- Never send the creator access token to the counterparty.
- Always include an `Open Deal Room` inline button in notifications.

### Bot Localization Keys

```
bot.start.title
bot.menu.create_deal
bot.role.ask
bot.role.seller
bot.role.buyer
bot.deal.created
bot.link.private_warning
bot.link.share_this
bot.status.ready_for_payment
bot.error.invalid_amount
bot.help.escrow_explain
```

---

## Shared Conventions

### Participant Roles

```
buyer
seller
admin
```

### Creator Source

```
web
telegram
```

### Preferred Language

```
km
en
zh
```

### Dispute Reasons

```
ITEM_NOT_RECEIVED
WRONG_ITEM
DAMAGED_ITEM
FAKE_ITEM
PAYMENT_PROBLEM
OTHER
```

### URL Format

```
Deal Room:       https://bothsafe.app/d/{publicId}
Invite link:     https://bothsafe.app/d/{publicId}?invite={inviteToken}
Creator link:    https://bothsafe.app/d/{publicId}?access={creatorAccessToken}
```

---

## Task Reference Files

For full acceptance criteria, field-level details, and subtask lists, read:

- `tasks/backend_task.md` — Backend modules B-01 through B-15
- `tasks/frontend_task.md` — Frontend tasks F-01 through F-13
- `tasks/bot_task.md` — Bot tasks T-01 through T-10

---

## MVP Exclusions (Do Not Build Yet)

- Automatic Bakong/KHQR payment verification
- Dynamic KHQR generation
- Automatic bank payout
- Telegram Mini App
- Merchant API / SDK
- iframe embed widget
- Delivery company API integration
- KYC / identity verification
- AI fraud detection
- Subscription or digital product escrow
- Binance or international payments
- Seller/buyer ratings

---

## Development Startup

```bash
# Backend
cd backend
cp .env.example .env   # fill MySQL and MinIO connection values from local Docker
npm install
npx prisma migrate dev
npx prisma db seed
npm run start:dev

# Frontend
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Backend runs on `http://localhost:3001` (or configured port).  
Frontend runs on `http://localhost:3000`.  
MySQL and MinIO run in local Docker for the MVP.


<claude-mem-context>
# Memory Context

# [both-safe] recent context, 2026-05-06 11:56am GMT+7

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 35 obs (13,309t read) | 142,939t work | 91% savings

### May 5, 2026
1 10:06a 🔵 OpenCode Orchestrator Architecture and Sub-Agent Dispatch Pattern
2 " 🔵 Global Skills Registry Contains 200+ Pre-Built Agent Skills
3 10:07a ✅ OpenCode Orchestrator Skill Registration Directory Created
4 " 🔵 OpenCode Orchestrator Advanced Features: Design Systems and Session Management
5 10:08a 🟣 OpenCode Orchestrator Skill Installed to Global Registry
### May 6, 2026
S2 Create a skill based on Ruflo v3.7.0-alpha.1 release for optimized CLI performance in plugin development (May 6, 11:23 AM)
S1 Create AGENTS.md architecture guide synthesizing the BothSafe MVP design from task breakdowns (frontend, backend, Telegram bot) (May 6, 11:23 AM)
7 11:28a 🔵 Ruflo v3.7.0-alpha.1: CLI performance optimization through package splitting
S3 Create a skill based on Ruflo v3.7.0-alpha.1 CLI tool for optimized performance in plugin development (May 6, 11:29 AM)
S4 Create Ruflo skill based on v3.7.0-alpha.1 release for token optimization and performance improvement in Claude Code environment (May 6, 11:30 AM)
8 11:33a 🟣 Ruflo Optimizer skill created for token and performance optimization
9 " ✅ Comprehensive Ruflo Optimizer skill usage documentation created
S5 Create Ruflo skill based on v3.7.0-alpha.1 release for token optimization and performance improvement in Claude Code environment (May 6, 11:34 AM)
10 11:50a 🔵 NestJS Backend Project Structure Baseline
11 " 🔵 Backend Infrastructure Requirements Identified
12 " ⚖️ Backend Implementation Roadmap Established
13 11:51a ✅ Backend Implementation Commenced - B-01 Task Started
14 " 🟣 Core Dependencies Installed for Backend
15 " ✅ TypeScript Type Definitions Installed
16 11:52a ✅ Prisma ORM Initialized
17 " 🔵 Prisma Schema Initialization Mismatch
18 " 🟣 Complete Prisma Database Schema Implemented
19 11:53a ✅ Environment Configuration Updated for MVP
20 " 🔵 Prisma Migration Command Error
21 " 🔵 Prisma 7.x Breaking Change: Datasource Configuration
22 " 🔴 Fixed Prisma 7.x Schema Validation Error
23 " 🟣 Prisma Database Migration Successful
24 " ✅ Backend Source Directory Structure Established
25 11:54a 🟣 Prisma Database Service Layer Implemented
26 " 🟣 Global Prisma Module Created
27 " 🟣 Centralized Constants File with Type Safety
28 " 🟣 Security and Utility Functions Implemented
29 " 🟣 Global Exception Handler and Request Logging Implemented
30 " ✅ Sanitization Function Improved for Whitespace Handling
31 11:55a 🟣 Request Actor Decorator Implemented
32 " 🟣 Authentication Service Implemented
33 " 🟣 Auth Module and Admin Guard Implemented
34 " 🟣 Deal Access Guard and Admin Login Endpoint Implemented
35 " 🟣 Deal Status State Machine Implemented
36 " 🟣 Missing Fields Detection Engine Implemented

Access 143k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>
