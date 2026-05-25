# Frontend translation files

This folder holds the message catalogues consumed by `next-intl` (wired
in task 13.12). Three locales are supported — see
[AGENTS.md → "Shared Conventions → Preferred_Language"](../../AGENTS.md):

| Locale | File         | Notes                                                                 |
|--------|--------------|-----------------------------------------------------------------------|
| `km`   | `km.json`    | Khmer — primary user language for Cambodia.                           |
| `en`   | `en.json`    | Source of truth for all keys. New keys land here first.               |
| `zh`   | `zh.json`    | Simplified Chinese — used for the WeChat/Chinese-speaking audience.   |

`next-intl` is **not** installed yet — task 13.12 brings it in. Until
then, these files only describe the key tree the app will eventually
load.

## How keys are organised

The catalogue is dot-namespaced. Every top-level namespace serves a
distinct purpose:

| Namespace        | Source           | Purpose                                                     |
|------------------|------------------|-------------------------------------------------------------|
| `common.*`       | Frontend-only    | Generic UI verbs and adjectives (`next`, `cancel`, `loading`). |
| `auth.*`         | Frontend-only    | Sign-in / sign-up screen copy.                              |
| `deal.*`         | Frontend-only    | Deal Room labels, statuses, role pickers, field captions.   |
| `invite.*`       | Frontend-only    | Invite-link landing copy.                                   |
| `wallet.*`       | Frontend-only    | Wallet page labels.                                         |
| `payment.*`      | Frontend-only    | Buyer payment flow (KHQR / wallet / Binance).               |
| `shipping.*`     | Frontend-only    | Seller shipping form labels.                                |
| `confirmation.*` | Frontend-only    | Buyer confirm-received UI.                                  |
| `dispute.*`      | Frontend-only    | Dispute reason picker + form.                               |
| `withdrawal.*`   | Frontend-only    | Seller withdrawal request UI.                               |
| `admin.*`        | Frontend-only    | Admin dashboard verbs (`verify`, `release`, `refund`).      |
| `bot.*`          | Both             | Telegram bot copy (rendered server-side by the bot module). |
| `errors.*`       | **Backend**      | Mirror of `backend/src/i18n/keys.ts → ERROR_KEYS`.          |
| `messages.*`     | **Backend**      | Mirror of `backend/src/i18n/keys.ts → MESSAGE_KEYS`.        |
| `notifications.*`| **Backend**      | Mirror of `backend/src/i18n/keys.ts → NOTIFICATION_KEYS`.   |

## Keep these in sync with the backend

The backend never returns hardcoded user-facing strings. Every error,
banner, and notification carries a `message_key` that the frontend
resolves against these JSON files. The full list of backend-emitted
keys lives in [`backend/src/i18n/keys.ts`](../../backend/src/i18n/keys.ts);
the convention is documented in
[`backend/src/i18n/README.md`](../../backend/src/i18n/README.md).

Rules:

1. Every key listed in `backend/src/i18n/keys.ts` MUST exist in all
   three locale files (`en.json`, `km.json`, `zh.json`).
2. Adding a backend key without adding the matching translation is a
   bug — task 14 (cross-cutting test pass) will eventually wire a test
   that asserts coverage; until then, treat it as a code-review
   blocker.
3. Removing a backend key requires deleting it from all three locale
   files in the same change.
4. Keys are dot-namespaced and trailing segments are `snake_case`,
   never `camelCase` (`payment.proof_uploaded`, never
   `payment.proofUploaded`).

## Conventions

- **English is the source of truth.** When you add a key, add it to
  `en.json` first with the canonical copy, then mirror the same key
  shape into `km.json` and `zh.json`.
- **Placeholder translations are OK.** If you don't have a translation
  yet, copy the English string into `km.json` / `zh.json` so the key is
  present. Never leave a key absent — `next-intl` will throw at render
  time.
- **No HTML in values.** Embed `next-intl` rich-text placeholders only
  if the component is set up to handle them; otherwise keep values as
  plain strings so a future bot adapter can reuse them verbatim.
- **No raw access tokens, IDs, or amounts in copy.** Use ICU
  placeholders (`{amount}`, `{role}`, etc.) and pass values from the
  component.
- **Don't compose keys at runtime.** Keys are static literals known at
  code-review time. If you need per-field copy, render a single key and
  pass the field name in `details`.

## Adding or changing keys

1. **Backend-emitted key** (`errors.*`, `messages.*`,
   `notifications.*`)
   - Add the key to the matching array in
     `backend/src/i18n/keys.ts`.
   - Add the same key with the English copy to `en.json`.
   - Mirror into `km.json` and `zh.json`.
   - Run `npm run build` in `backend/` to confirm the registry typing
     still resolves.

2. **Frontend-only key** (`common.*`, `deal.*`, `bot.*`, etc.)
   - Add the key with English copy to `en.json`.
   - Mirror into `km.json` and `zh.json`.
   - Use the key from a component via `useTranslations(<namespace>)`
     once `next-intl` is wired (task 13.12).

## Locale-specific notes

- **Khmer (`km`)** — Khmer text uses the Khmer script (`ភាសាខ្មែរ`).
  Keep status labels short; the Deal Room status badge has a tight
  width budget on mobile. Avoid Latin punctuation around currency
  symbols.
- **Chinese (`zh`)** — Use Simplified Chinese (`简体`). For monetary
  amounts, prefer the international currency code over the local
  symbol (`USD 25.00`, not `$25.00`) — BothSafe operates in Cambodia
  and our buyers may not associate `$` with USD.

## Where translations are loaded

Once `next-intl` is wired (task 13.12), the loader will pick the file
matching the user's `preferred_lang` (per
[`User.preferred_lang`](../../backend/prisma/schema.prisma)), falling
back to `en.json` if a key is missing. Until then, no runtime code
reads these files.
