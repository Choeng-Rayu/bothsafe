-- AlterTable: extend `idempotency_key` with the columns the new
-- `IdempotencyMiddleware` (task 3.8) needs to fingerprint requests, cache
-- HTTP responses for replay, and time-bound rows with a 24 h TTL.
--
-- `expires_at` is NOT NULL in the final schema. We add it with a
-- transient DEFAULT (`now() + 24 hours`) so the ALTER succeeds against a
-- non-empty table — every existing row gets a 24 h TTL bound to the
-- migration timestamp — then drop the default so application inserts
-- are forced to compute and supply the value explicitly.
ALTER TABLE "idempotency_key"
    ADD COLUMN "request_hash"    TEXT,
    ADD COLUMN "route"           TEXT,
    ADD COLUMN "response_status" INTEGER,
    ADD COLUMN "response_body"   JSONB,
    ADD COLUMN "expires_at"      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours');

ALTER TABLE "idempotency_key"
    ALTER COLUMN "expires_at" DROP DEFAULT;

-- CreateIndex: background-job hot path for purging expired rows.
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key"("expires_at");
