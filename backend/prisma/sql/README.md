# BothSafe Prisma — post-migration SQL

This directory holds raw Postgres SQL that runs **after** the regular
Prisma migrations. It exists for things Prisma cannot express in
`schema.prisma`:

- Database role bootstrap (`migrator`, `app`)
- Privilege revocation for append-only tables (R14.2, R20.5)
- `BEFORE UPDATE OR DELETE OR TRUNCATE` triggers as defence in depth
- `CHECK` constraints (e.g. `wallet_ledger_entry.amount > 0`, the
  branched `withdrawal_request` destination CHECK)
- Partial UNIQUE indexes (e.g. `dispute (deal_id) WHERE status='open'`)

The canonical source for what this file enforces is
[`.kiro/specs/bothsafe-deal-flow/design.md`](../../../.kiro/specs/bothsafe-deal-flow/design.md),
section "Append-only enforcement (R14.2, R20.5)" and the related
data-model notes. The owning task is
[`.kiro/specs/bothsafe-deal-flow/tasks.md`](../../../.kiro/specs/bothsafe-deal-flow/tasks.md)
2.10.

## Files

| File | Purpose |
| --- | --- |
| `append_only_enforcement.sql` | Provisions roles, REVOKEs UPDATE/DELETE/TRUNCATE on `wallet_ledger_entry` and `audit_log_entry`, installs the `reject_mutation()` trigger, and adds the deferred CHECK / partial-UNIQUE constraints. Idempotent — safe to re-run on every deploy. |

## When this runs

Task **2.11** is responsible for executing this file after
`npx prisma migrate dev --name init_deal_flow`. The recommended
invocation is:

```bash
# From repo root.
MIGRATOR_PASSWORD="$(openssl rand -hex 24)" \
APP_PASSWORD="$(openssl rand -hex 24)" \
psql "$DATABASE_URL" \
     -v ON_ERROR_STOP=1 \
     -f backend/prisma/sql/append_only_enforcement.sql
```

`prisma db execute` is **not** suitable here — the SQL uses psql
meta-commands (`\set`, backtick shell substitution) to read role
passwords from the environment, and `prisma db execute` does not
process meta-commands.

In dev, the `bothsafe` superuser provisioned by `docker-compose.yml`
is the connecting user and has all the privileges needed (CREATE
ROLE, schema ownership, GRANT). In prod, run the script once during
bootstrap as a superuser, or have the DBA pre-create the `migrator`
and `app` roles and run the script as a regular role to apply only
sections (2)–(4).

## Idempotency

Every statement in `append_only_enforcement.sql` is guarded so the
script is safe to re-run:

- Role creation uses `DO $$ … pg_roles … $$` checks.
- GRANT / REVOKE / ALTER DEFAULT PRIVILEGES are inherently idempotent.
- CHECK constraints use `DROP CONSTRAINT IF EXISTS` before `ADD`.
- The partial UNIQUE index uses `CREATE UNIQUE INDEX IF NOT EXISTS`.
- The `reject_mutation()` function uses `CREATE OR REPLACE`.
- Triggers use `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`.

Re-running the script does not rotate role passwords (the role-creation
guard early-exits when the role already exists). Rotate with a separate
`ALTER ROLE … PASSWORD …;` and then re-run this script if you want to
re-apply the rest of the file.

## Verification (manual, recommended after first apply)

After running the script, verify enforcement against a live database:

```sql
-- 1. Connect as `app` and try to UPDATE the ledger; expect:
--    ERROR:  permission denied for table wallet_ledger_entry
SET ROLE app;
UPDATE wallet_ledger_entry SET amount = amount + 1 WHERE id = 1;
RESET ROLE;

-- 2. Connect as a privileged role (e.g. `bothsafe`) and try the same;
--    expect the trigger to fire:
--    ERROR:  append-only: UPDATE rejected on wallet_ledger_entry
UPDATE wallet_ledger_entry SET amount = amount + 1 WHERE id = 1;

-- 3. CHECK constraint on amount:
--    ERROR:  new row for relation "wallet_ledger_entry" violates check
--            constraint "wallet_ledger_entry_amount_positive"
INSERT INTO wallet_ledger_entry (...) VALUES (..., -1, ...);

-- 4. Partial UNIQUE on dispute:
--    Two `status='open'` rows for the same `deal_id` should fail with
--    a unique-violation; resolved rows should not collide.
```

Automated tests for the same invariants live with task 2.10's PBT /
integration tests once the test harness exists.
