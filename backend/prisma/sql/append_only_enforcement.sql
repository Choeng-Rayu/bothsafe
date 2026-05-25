-- BothSafe — append-only enforcement and deferred constraints
--
-- Source of truth:
--   • .kiro/specs/bothsafe-deal-flow/design.md, section
--     "Append-only enforcement (R14.2, R20.5)"
--   • .kiro/specs/bothsafe-deal-flow/tasks.md, task 2.10
--
-- This script is applied AFTER the initial Prisma migration (task 2.11)
-- and is idempotent — it can be re-run safely on every deploy. It performs
-- four separate jobs that Prisma cannot express in `schema.prisma`:
--
--   1. Provision the `migrator` and `app` Postgres roles and grant the
--      privileges required by the role split documented in
--      backend/prisma/README.md.
--   2. REVOKE `UPDATE, DELETE, TRUNCATE` on the append-only tables
--      `wallet_ledger_entry` and `audit_log_entry` from `app` (and from
--      `PUBLIC`), then re-GRANT only `INSERT, SELECT` so the runtime
--      connection cannot mutate either table (R14.2, R20.5).
--   3. Add CHECK constraints and partial UNIQUE indexes that Prisma cannot
--      represent natively — `wallet_ledger_entry.amount > 0` (R14.1), the
--      branched `withdrawal_request` destination CHECK (R15.3, R15.4),
--      and the `dispute (deal_id) WHERE status='open'` partial UNIQUE
--      (R17.6).
--   4. Install the `reject_mutation()` trigger as defence in depth so a
--      misconfigured role still cannot mutate the append-only tables.
--
-- ─── Execution model ─────────────────────────────────────────────────────
--
-- Apply with **psql** (this script uses psql meta-commands and backtick
-- shell substitution to read role passwords from the environment). It is
-- NOT compatible with `prisma db execute`, which does not process
-- meta-commands. The recommended invocation is:
--
--     MIGRATOR_PASSWORD=… APP_PASSWORD=… \
--     psql "$DATABASE_URL" \
--          -v ON_ERROR_STOP=1 \
--          -f backend/prisma/sql/append_only_enforcement.sql
--
-- The connection user must be allowed to:
--   • CREATE ROLE     (superuser, or a role with `CREATEROLE`)
--   • own / GRANT on the `public` schema and all BothSafe tables.
--
-- In dev, the `bothsafe` user provisioned by `docker-compose.yml` is a
-- superuser, so this just works. In prod, either run as the `bothsafe`
-- superuser once during bootstrap, or have the DBA pre-create the
-- `migrator` / `app` roles and re-run this script to apply (2)–(4).
--
-- ─── Passwords ────────────────────────────────────────────────────────────
--
-- Role passwords are pulled from `MIGRATOR_PASSWORD` and `APP_PASSWORD`
-- (shell environment) if set; otherwise both default to the placeholder
-- `'changeme'`. Production deployments MUST override both env vars to
-- secret values before running this script — passwords for these roles
-- belong in the deployment secret manager, not the codebase.
--
-- The CREATE ROLE statements only run when the role does not already
-- exist (checked against `pg_roles`), so re-running the script with a
-- different password env var will NOT rotate the password. To rotate,
-- run `ALTER ROLE migrator PASSWORD '...';` separately and then re-run
-- this script.

-- ─── Read role passwords from the shell env ──────────────────────────────
\set migrator_password `echo "${MIGRATOR_PASSWORD:-changeme}"`
\set app_password      `echo "${APP_PASSWORD:-changeme}"`

-- Stash them on session-level GUCs so the dollar-quoted DO blocks below
-- can read them (psql variable substitution doesn't happen inside
-- dollar-quoted bodies). The third argument `false` makes the GUC a
-- regular SET (cleared at session end), not a SET LOCAL.
SELECT set_config('bothsafe.migrator_password', :'migrator_password', false);
SELECT set_config('bothsafe.app_password',      :'app_password',      false);

-- ─── (1) Provision roles ─────────────────────────────────────────────────
--
-- `migrator` owns DDL (Prisma migrations); `app` runs DML at runtime.
-- Both LOGIN-able, NOINHERIT so they don't pick up unintended group
-- membership through any future role hierarchy.

DO $$
DECLARE
  pw text := current_setting('bothsafe.migrator_password');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrator') THEN
    EXECUTE format('CREATE ROLE migrator LOGIN NOINHERIT PASSWORD %L', pw);
  END IF;
END $$;

DO $$
DECLARE
  pw text := current_setting('bothsafe.app_password');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    EXECUTE format('CREATE ROLE app LOGIN NOINHERIT PASSWORD %L', pw);
  END IF;
END $$;

-- Drop the password GUCs so they don't leak into `pg_stat_activity`
-- snapshots beyond what's strictly necessary.
SELECT set_config('bothsafe.migrator_password', '', false);
SELECT set_config('bothsafe.app_password',      '', false);

-- ─── (1a) Grant `migrator` ownership-style privileges ────────────────────
--
-- We don't `ALTER DATABASE … OWNER TO migrator` because the connecting
-- user is typically `bothsafe` and changing ownership mid-session is
-- avoidable. Instead, give `migrator` full privileges on the schema
-- and on every existing object, plus default privileges so future
-- objects created by anyone in this schema also grant to `migrator`.

GRANT ALL PRIVILEGES ON SCHEMA public TO migrator;
GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public TO migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO migrator;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO migrator;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES    TO migrator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO migrator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON FUNCTIONS TO migrator;

-- ─── (1b) Grant `app` runtime DML privileges ─────────────────────────────
--
-- `app` connects to the database, uses the `public` schema, and runs DML
-- against existing and future tables. Sequence USAGE is required for
-- `BIGSERIAL` PKs (`wallet_ledger_entry.id`, `audit_log_entry.id`,
-- `notification_outbox_entry.id`).

-- CONNECT — granted on the current database (works regardless of name).
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app', current_database());
END $$;

GRANT USAGE ON SCHEMA public TO app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT                  ON SEQUENCES TO app;

-- ─── (2) Append-only revocations on `wallet_ledger_entry` & `audit_log_entry` ──
--
-- Per design §"Append-only enforcement (R14.2, R20.5)" the runtime role
-- must only be able to INSERT and SELECT. We revoke from `PUBLIC` first
-- (default privilege grant target) and then re-grant exactly the two
-- privileges we want to `app`.

REVOKE ALL ON wallet_ledger_entry FROM PUBLIC;
REVOKE ALL ON wallet_ledger_entry FROM app;
GRANT  SELECT, INSERT ON wallet_ledger_entry TO app;

REVOKE ALL ON audit_log_entry FROM PUBLIC;
REVOKE ALL ON audit_log_entry FROM app;
GRANT  SELECT, INSERT ON audit_log_entry TO app;

-- The append-only tables also expose sequence privileges through their
-- BIGSERIAL PKs. INSERT requires sequence USAGE; we deliberately keep
-- USAGE+SELECT on those sequences (granted via `GRANT … ON ALL SEQUENCES`
-- above). UPDATE on a sequence is not granted, so `app` cannot rewind
-- the sequence either.

-- ─── (3) Deferred constraints Prisma cannot express ──────────────────────

-- (3a) `wallet_ledger_entry.amount > 0` — R14.1.
ALTER TABLE wallet_ledger_entry
  DROP CONSTRAINT IF EXISTS wallet_ledger_entry_amount_positive;
ALTER TABLE wallet_ledger_entry
  ADD  CONSTRAINT wallet_ledger_entry_amount_positive
       CHECK (amount > 0);

-- (3b) Branched destination CHECK on `withdrawal_request` — R15.3 / R15.4.
--
-- Only the `khqr` and `bank` branches are covered here; the `binance`
-- branch is added later by task 17.1 which DROPs and re-CREATEs this
-- constraint with the third branch. The CHECK requires that exactly the
-- columns relevant to the chosen branch are populated.
ALTER TABLE withdrawal_request
  DROP CONSTRAINT IF EXISTS withdrawal_request_destination_branch_valid;
ALTER TABLE withdrawal_request
  ADD  CONSTRAINT withdrawal_request_destination_branch_valid
       CHECK (
         (destination_type = 'khqr'
            AND (khqr_string IS NOT NULL OR khqr_image_key IS NOT NULL))
         OR
         (destination_type = 'bank'
            AND bank_name           IS NOT NULL
            AND bank_account_name   IS NOT NULL
            AND bank_account_number IS NOT NULL)
       );

-- (3c) Partial UNIQUE on `dispute (deal_id) WHERE status='open'` — R17.6.
--
-- At most one open dispute per deal at any time. Resolved disputes
-- (`status='resolved'`) are excluded so a deal can later be re-disputed
-- if the resolution is appealed. Prisma cannot express partial uniques.
CREATE UNIQUE INDEX IF NOT EXISTS dispute_open_per_deal_unique
  ON dispute (deal_id) WHERE status = 'open';

-- ─── (4) `reject_mutation()` trigger — defence in depth ──────────────────
--
-- Even with the privilege revocations above, a future migration that
-- accidentally re-grants UPDATE/DELETE to `app` would silently re-open
-- the immutability hole. The trigger guarantees that any mutation
-- operation on `wallet_ledger_entry` or `audit_log_entry` raises an
-- exception, regardless of the role attempting it.
--
-- The trigger is `BEFORE UPDATE OR DELETE OR TRUNCATE … FOR EACH
-- STATEMENT` because TRUNCATE has no per-row firing model and the
-- per-statement scope is enough for our blanket reject.

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % rejected on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS walletledger_immutable ON wallet_ledger_entry;
CREATE TRIGGER walletledger_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE
  ON wallet_ledger_entry
  FOR EACH STATEMENT
  EXECUTE FUNCTION reject_mutation();

DROP TRIGGER IF EXISTS auditlog_immutable ON audit_log_entry;
CREATE TRIGGER auditlog_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE
  ON audit_log_entry
  FOR EACH STATEMENT
  EXECUTE FUNCTION reject_mutation();
