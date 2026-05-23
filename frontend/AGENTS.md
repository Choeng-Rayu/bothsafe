# Frontend — Agent Guide

This guide is scoped to `/frontend`. For the cross-layer architecture contract (Deal Status enum, API endpoints, token URL formats, message keys, allowed-actions contract), read **`../AGENTS.md`** first. For requirement IDs and acceptance criteria, see **`../.kiro/specs/bothsafe-deal-flow/{requirements,design,tasks}.md`**.

> **This is NOT the Next.js you know.** This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

---

## Stack

- **Next.js (App Router, TypeScript)** — bootstrapped via `create-next-app`
- **Tailwind CSS v4** — `@import "tailwindcss"` in `app/globals.css`, theme via `@theme inline` and CSS custom properties (`--background`, `--foreground`, `--font-geist-sans`, `--font-geist-mono`)
- **`next/font/google`** — Geist Sans + Geist Mono are wired in `app/layout.tsx` as CSS variables
- **i18n**: `next-intl` (or equivalent) per `../AGENTS.md`. Locales: `km` (Khmer), `en`, `zh`. Khmer is the default audience.
- **ESLint flat config**: `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript`

## Current state

Bootstrapped only. **`package.json` is not committed yet** — `node_modules/` exists but the manifest doesn't, so `npm install` won't reproduce the env. When you start real work, the first move is to commit a `package.json` (and lock file) that matches what the deal-flow spec needs.

```
app/
  layout.tsx        ← Geist fonts, antialiased html, flex-col body
  page.tsx          ← default create-next-app placeholder
  globals.css       ← Tailwind v4 import + theme tokens + dark-mode media query
  favicon.ico
eslint.config.mjs
next.config.ts      ← empty config object
next-env.d.ts
```

No routes for `/deals/new`, `/d/[publicId]`, `/admin/*` exist yet. No i18n setup, no shared components, no API client. Build them as `tasks.md` reaches the frontend phase.

## Common commands (once `package.json` exists)

Standard `create-next-app` script set:

```bash
npm install
npm run dev            # next dev, port 3000
npm run build          # next build
npm run start          # next start (after build)
npm run lint           # next lint, uses eslint.config.mjs
```

The dev server's port (3000) collides with whatever the backend runs on if `PORT` isn't set there. `.env` in `/backend` sets `PORT=3003`; `../AGENTS.md` documents 3001. Either way, point the frontend at the right backend via `NEXT_PUBLIC_API_BASE` (or whatever env var the API client expects) — don't hardcode `localhost:3001`.

## Routes to build (from `../AGENTS.md`)

| Route | Purpose |
|---|---|
| `/` | Public landing |
| `/deals/new` | Create Deal Room (buyer or seller) |
| `/d/[publicId]` | Deal Room — main shared URL. Default state: invite preview / counterparty join. |
| `/d/[publicId]?invite=xxx` | Counterparty join state |
| `/d/[publicId]?access=xxx` | Creator state (private link) |
| `/admin` | Admin login |
| `/admin/deals` | Admin deal table |
| `/admin/deals/[dealId]` | Admin deal detail |

Page-to-API mapping (full list in `../AGENTS.md`): create deal, load Deal Room, join, edit four section types (product, participant, delivery, payout), approve, upload payment proof, upload shipping proof, confirm received, open dispute, plus admin verify/reject/release/refund.

All API routes are versioned with `/v1` prefix. The backend's global `ValidationPipe` strips unknown fields from request bodies — don't bother sending extras.

## Hard rules for this layer

These come from `../AGENTS.md` "Frontend Coding Rules". Test for them:

1. **Never invent deal statuses.** Use the exact backend enum. Status comes from the API; do not derive it client-side.
2. **Render permissions from `allowed_actions[]`** in the deal response — don't hardcode role/status logic in components. The same applies to `missing_fields[]`: render the checklist from the API, don't compute it.
3. **All user-facing strings are i18n keys.** No hardcoded English/Khmer/Chinese in components. Keys follow `../AGENTS.md` conventions (`deal.create.title`, `deal.status.draft`, `payment.upload_proof`, `bot.start.title`, etc.).
4. **Never display the seller's payout KHQR to the buyer.** The API enforces this in the serializer; the UI must not try to surface it from any other field either.
5. **Tokens belong in `httpOnly` cookies** for the participant/creator session, or `localStorage` with an explicit "keep this link safe" warning if you must use the URL form. Never log raw tokens to console. Never include them in error reports or analytics events.
6. **Mobile-first.** Minimum 44px tap targets. Sticky bottom action bar on `/d/[publicId]` for the primary action (Pay / Ship / Confirm Received / Open Dispute, depending on state).
7. **Client-validate file type and size before upload.** The backend rejects oversized/wrong-type proofs, but blocking the upload locally is faster and friendlier.
8. **Admin routes require server-side session check.** Don't gate admin pages with client-only guards.
9. **When the deal flow changes, update the Telegram bot too.** Both surfaces must stay in sync — the bot lives in `../backend/src/bot/` and shares `DealService`, but its UI flow is built separately.

## i18n

Three locales: `km`, `en`, `zh`. Default audience is Khmer; default fallback is `en`. Key namespaces from `../AGENTS.md`: `common.*`, `deal.create.*`, `deal.role.*`, `deal.status.*`, `payment.*`, `shipping.*`, `dispute.reason.*`, `admin.*`, plus `bot.*` (shared with the bot). Pick `next-intl` unless there's a reason not to — `../AGENTS.md` calls it out explicitly.

## Component conventions

Component lists from `../AGENTS.md` (build these as you reach the relevant page):

**Shared:** `LanguageSwitcher`, `StatusBadge`, `DealStatusCard`, `ProductCard`, `ParticipantCard`, `PriceSummaryCard`, `EscrowExplanationCard`, `MissingFieldsChecklist`, `Timeline`, `PrimaryActionBar`, `CopyLinkButton`, `ImageUploader`, `ReceiptUploader`, `ConfirmDialog`, `DisputeForm`.

**Admin:** `AdminDealTable`, `AdminDealFilters`, `PaymentProofViewer`, `ShippingProofViewer`, `DisputeEvidenceViewer`, `AdminActionPanel`, `AdminNoteBox`.

These are guidelines for naming and decomposition, not a literal one-component-per-file mandate. Group by feature (`app/_components/deal/`, `app/_components/admin/`).

## Tailwind v4

`globals.css` uses Tailwind v4's CSS-first config — `@import "tailwindcss"` plus `@theme inline { ... }` exposes design tokens (`--color-background`, `--color-foreground`, `--font-sans`, `--font-mono`). Add new tokens there, not via `tailwind.config.js`. Dark mode is currently driven by `@media (prefers-color-scheme: dark)`; if the design system needs a manual toggle later, switch to a `[data-theme="dark"]` selector pattern instead of mixing both.

## What this folder is NOT responsible for

- The Telegram bot UI/logic — it lives in `../backend/src/bot/` (in-process NestJS module).
- API business rules, status transitions, missing-field calculation, allowed-actions calculation — all server-owned.
- Auth flows (Email/password, Telegram login, Google OAuth) — the frontend renders the screens and posts to the backend, but the credential exchange lives server-side.

## When you make non-trivial changes

1. The frontend and Telegram bot must stay in sync. If you add a new field, error, or step on a deal page, update the bot's equivalent flow too.
2. New API integrations: confirm the endpoint exists in `../AGENTS.md` "API Contract" or has been added to `../.kiro/specs/bothsafe-deal-flow/design.md`. Don't invent endpoints.
3. Run the dev server and click through the flow you changed before declaring done — the contract is enforced by the API, but UX regressions (locked sticky bar, missing translation, broken sticky-bottom on mobile) only show up in the browser.
