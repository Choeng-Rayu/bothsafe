# Backend i18n key conventions

The backend never returns hardcoded user-facing strings. Every error,
success envelope, and notification payload carries a `message_key` (and
optional `details` object) that the frontend resolves against
`frontend/messages/{km,en,zh}.json` via `next-intl`.

## Why

- Same API serves the web app and the Telegram bot in three languages
  (`km`, `en`, `zh`).
- Translators only edit JSON files in `frontend/messages/`.
- Adding a key on the backend is visible at code-review time as a
  diff in `keys.ts`.

## Where keys live

- `src/i18n/keys.ts` — the canonical registry. Every key the backend may
  emit is listed here. Adding a key without adding it to this file is a
  bug.
- `frontend/messages/{km,en,zh}.json` — translations. Every key in
  `keys.ts` MUST have a translation in every locale file.

## Key shape

```
errors.<domain>.<state_or_action>      // backend-emitted errors
messages.<domain>.<state_or_action>    // backend-emitted success banners
notifications.<event_name>             // outbox notification events
```

Rules:

- DOT-namespaced.
- `snake_case` in trailing segments, never `camelCase`.
- `<domain>` matches a NestJS module name from `AGENTS.md` (`auth`,
  `deal`, `wallet`, `payment`, `shipping`, `confirmation`, `dispute`,
  `withdrawal`, `invite`, `storage`) plus a few cross-cutting buckets
  (`rate`, `idempotency`, `binance`, `validation`).
- Keys without one of the three backend prefixes (`errors.`,
  `messages.`, `notifications.`) belong to the frontend (`common.*`,
  `auth.login_title`, `deal.create.title`, `bot.*`, etc.) and are NOT
  emitted by the backend.

### Error keys (full list in `keys.ts → ERROR_KEYS`)

```
errors.auth.required
errors.auth.invalid_credentials
errors.deal.not_found
errors.deal.missing_required_fields
errors.wallet.insufficient_balance
errors.payment.khqr_unavailable
errors.storage.invalid_file
errors.rate.exceeded
errors.idempotency.mismatch
errors.validation.invalid_field
```

### Success keys (full list in `keys.ts → MESSAGE_KEYS`)

```
messages.deal.created
messages.payment.proof_uploaded
messages.confirmation.received
messages.withdrawal.requested
```

### Notification-event keys (full list in `keys.ts → NOTIFICATION_KEYS`)

```
notifications.counterparty_joined
notifications.payment_verified
notifications.payout_released
notifications.withdrawal_paid
```

## Response envelope

All error responses use the shape produced by the global exception
filter (task 3.6):

```jsonc
{
  "error": {
    "code": "wallet.insufficient_balance",            // bare code (errors. prefix stripped)
    "message_key": "errors.wallet.insufficient_balance", // full i18n key
    "details": { "available": "12.34", "required": "25.00" }
  }
}
```

Use `errorCodeFromKey(...)` from `src/i18n/keys.ts` to produce the
bare `error.code` from a registered `ErrorKey`.

Successful responses that need to surface a banner add an optional
top-level `message_key` (see design.md §"Cross-Cutting Concerns →
Response shape" / `DealRoomResponse`).

## Adding a new key

1. Add the literal string to the appropriate array in
   `src/i18n/keys.ts` (`ERROR_KEYS`, `MESSAGE_KEYS`, or
   `NOTIFICATION_KEYS`).
2. Add the same key with English copy to `frontend/messages/en.json`.
3. Mirror the key into `frontend/messages/km.json` and
   `frontend/messages/zh.json`. Use the English string as a placeholder
   if the translation is not yet ready, but never leave the key
   absent.
4. Run `npx tsc --noEmit -p backend/tsconfig.json` to confirm
   `BackendMessageKey` typing still resolves.

## What NOT to do

- Don't return literal English strings from a controller or service.
  Throw a `BadRequestException({ message_key: '...' })` or set
  `response.message_key`.
- Don't compose keys at runtime (`'errors.' + field + '.invalid'`).
  Generators defeat the registry; if you need a per-field message,
  pass the field name in `details` and render a single key like
  `errors.deal.invalid_field`.
- Don't change the casing or namespace of an existing key without
  updating every locale file in the same change.
