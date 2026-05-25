-- CreateEnum
CREATE TYPE "deal_status" AS ENUM ('DRAFT', 'AWAITING_COUNTERPARTY', 'AWAITING_BOTH_APPROVAL', 'READY_FOR_PAYMENT', 'PAYMENT_PENDING_VERIFICATION', 'PAID_ESCROWED', 'SELLER_PREPARING', 'SHIPPED', 'BUYER_CONFIRMED', 'DISPUTED', 'RELEASE_PENDING', 'RELEASED', 'REFUNDED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "currency" AS ENUM ('USD', 'KHR');

-- CreateEnum
CREATE TYPE "participant_role" AS ENUM ('buyer', 'seller', 'admin');

-- CreateEnum
CREATE TYPE "creator_source" AS ENUM ('web', 'telegram');

-- CreateEnum
CREATE TYPE "preferred_lang" AS ENUM ('km', 'en', 'zh');

-- CreateEnum
CREATE TYPE "withdrawal_status" AS ENUM ('pending_admin_review', 'paid', 'rejected');

-- CreateEnum
CREATE TYPE "withdrawal_destination" AS ENUM ('khqr', 'bank');

-- CreateEnum
CREATE TYPE "dispute_reason" AS ENUM ('ITEM_NOT_RECEIVED', 'WRONG_ITEM', 'DAMAGED_ITEM', 'FAKE_ITEM', 'PAYMENT_PROBLEM', 'OTHER');

-- CreateEnum
CREATE TYPE "ledger_entry_type" AS ENUM ('ESCROW_RECEIVED', 'PLATFORM_FEE_RESERVED', 'SELLER_PAYOUT_PENDING', 'SELLER_PAYOUT_SENT', 'BUYER_REFUND_PENDING', 'BUYER_REFUND_SENT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ledger_direction" AS ENUM ('credit', 'debit');

-- CreateEnum
CREATE TYPE "notification_event" AS ENUM ('COUNTERPARTY_JOINED', 'DEAL_UPDATED', 'BOTH_APPROVED', 'PAYMENT_PROOF_UPLOADED', 'PAYMENT_VERIFIED', 'PAYMENT_REJECTED', 'SELLER_SHOULD_SHIP', 'SHIPPING_UPLOADED', 'BUYER_CONFIRMED', 'DISPUTE_OPENED', 'PAYOUT_RELEASED', 'REFUND_COMPLETED', 'WITHDRAWAL_REQUESTED', 'WITHDRAWAL_PAID', 'WITHDRAWAL_REJECTED', 'ADMIN_RELEASE_FAILED');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('pending', 'sent', 'failed');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "password_hash" TEXT,
    "display_name" TEXT,
    "preferred_lang" "preferred_lang" NOT NULL DEFAULT 'en',
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_identity" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" TEXT,
    "ip_inet" INET,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_attempt" (
    "id" TEXT NOT NULL,
    "identity_key" TEXT NOT NULL,
    "attempted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL,

    CONSTRAINT "auth_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_room" (
    "id" TEXT NOT NULL,
    "public_id" TEXT NOT NULL,
    "creator_user_id" TEXT NOT NULL,
    "creator_role" "participant_role" NOT NULL,
    "creator_source" "creator_source" NOT NULL DEFAULT 'web',
    "status" "deal_status" NOT NULL DEFAULT 'DRAFT',
    "product_title" TEXT,
    "product_type" TEXT,
    "product_description" TEXT,
    "quantity" INTEGER,
    "condition" TEXT,
    "deal_amount" DECIMAL(18,2),
    "currency" "currency",
    "buyer_name" TEXT,
    "seller_name" TEXT,
    "reference_note" TEXT,
    "khqr_payload_meta" JSONB,
    "terms_hash" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "expires_at" TIMESTAMPTZ,

    CONSTRAINT "deal_room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_participant" (
    "id" TEXT NOT NULL,
    "deal_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "participant_role" NOT NULL,
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "phone" TEXT,
    "preferred_lang" "preferred_lang",
    "telegram_chat_id" TEXT,
    "wechat_id" TEXT,
    "messenger_name" TEXT,

    CONSTRAINT "deal_participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_token" (
    "id" TEXT NOT NULL,
    "deal_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "invalidated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_access_token" (
    "id" TEXT NOT NULL,
    "deal_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_access_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participant_access_token" (
    "id" TEXT NOT NULL,
    "deal_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "participant_access_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval" (
    "id" TEXT NOT NULL,
    "deal_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "participant_role" NOT NULL,
    "terms_hash" TEXT NOT NULL,
    "invalidated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_proof" (
    "id" TEXT NOT NULL,
    "deal_id" TEXT NOT NULL,
    "buyer_user_id" TEXT NOT NULL,
    "paid_amount" DECIMAL(18,2),
    "buyer_note" TEXT,
    "attachment_key" TEXT,
    "attachment_mime" TEXT,
    "source" TEXT NOT NULL DEFAULT 'khqr_receipt',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_proof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_proof" (
    "id" TEXT NOT NULL,
    "deal_id" TEXT NOT NULL,
    "seller_user_id" TEXT NOT NULL,
    "delivery_company" TEXT,
    "tracking_number" TEXT,
    "package_photo_key" TEXT,
    "delivery_receipt_key" TEXT,
    "seller_note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipping_proof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "confirmation" (
    "id" TEXT NOT NULL,
    "deal_id" TEXT NOT NULL,
    "buyer_user_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "confirmation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute" (
    "id" TEXT NOT NULL,
    "deal_id" TEXT NOT NULL,
    "opener_user_id" TEXT NOT NULL,
    "reason" "dispute_reason" NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolved_by" TEXT,
    "resolution_note" TEXT,
    "payout_reference" TEXT,
    "refund_reference" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_evidence" (
    "id" TEXT NOT NULL,
    "dispute_id" TEXT NOT NULL,
    "uploader_user_id" TEXT NOT NULL,
    "attachment_key" TEXT NOT NULL,
    "attachment_mime" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "currency" "currency" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_role" (
    "wallet_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,

    CONSTRAINT "wallet_role_pkey" PRIMARY KEY ("wallet_id")
);

-- CreateTable
CREATE TABLE "wallet_ledger_entry" (
    "id" BIGSERIAL NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" "currency" NOT NULL,
    "direction" "ledger_direction" NOT NULL,
    "entry_type" "ledger_entry_type" NOT NULL,
    "related_deal_id" TEXT,
    "related_withdrawal_id" TEXT,
    "external_ref" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_request" (
    "id" TEXT NOT NULL,
    "seller_user_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" "currency" NOT NULL,
    "destination_type" "withdrawal_destination" NOT NULL,
    "khqr_string" TEXT,
    "khqr_image_key" TEXT,
    "bank_name" TEXT,
    "bank_account_name" TEXT,
    "bank_account_number" TEXT,
    "status" "withdrawal_status" NOT NULL DEFAULT 'pending_admin_review',
    "payout_reference" TEXT,
    "rejection_reason" TEXT,
    "admin_note" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log_entry" (
    "id" BIGSERIAL NOT NULL,
    "action_type" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor_role" "participant_role",
    "deal_id" TEXT,
    "withdrawal_id" TEXT,
    "amount" DECIMAL(18,2),
    "currency" "currency",
    "prev_status" "deal_status",
    "new_status" "deal_status",
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_outbox_entry" (
    "id" BIGSERIAL NOT NULL,
    "event" "notification_event" NOT NULL,
    "recipient_kind" TEXT NOT NULL,
    "recipient_id" TEXT,
    "payload" JSONB NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ,

    CONSTRAINT "notification_outbox_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "result_ref" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("scope","key","user_id")
);

-- CreateTable
CREATE TABLE "bot_conversation" (
    "telegram_chat_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "partial_payload" JSONB NOT NULL,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bot_conversation_pkey" PRIMARY KEY ("telegram_chat_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "external_identity_user_id_idx" ON "external_identity"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_identity_provider_external_id_key" ON "external_identity"("provider", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_hash_key" ON "session"("token_hash");

-- CreateIndex
CREATE INDEX "session_user_id_expires_at_idx" ON "session"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "auth_attempt_identity_key_attempted_at_idx" ON "auth_attempt"("identity_key", "attempted_at");

-- CreateIndex
CREATE UNIQUE INDEX "deal_room_public_id_key" ON "deal_room"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "deal_room_reference_note_key" ON "deal_room"("reference_note");

-- CreateIndex
CREATE INDEX "deal_room_status_idx" ON "deal_room"("status");

-- CreateIndex
CREATE INDEX "deal_room_creator_user_id_created_at_idx" ON "deal_room"("creator_user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "deal_participant_deal_id_role_key" ON "deal_participant"("deal_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "deal_participant_deal_id_user_id_key" ON "deal_participant"("deal_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invite_token_token_hash_key" ON "invite_token"("token_hash");

-- CreateIndex
CREATE INDEX "invite_token_deal_id_idx" ON "invite_token"("deal_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_access_token_deal_id_key" ON "creator_access_token"("deal_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_access_token_token_hash_key" ON "creator_access_token"("token_hash");

-- CreateIndex
CREATE INDEX "creator_access_token_user_id_idx" ON "creator_access_token"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "participant_access_token_token_hash_key" ON "participant_access_token"("token_hash");

-- CreateIndex
CREATE INDEX "participant_access_token_user_id_idx" ON "participant_access_token"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "participant_access_token_deal_id_user_id_key" ON "participant_access_token"("deal_id", "user_id");

-- CreateIndex
CREATE INDEX "approval_deal_id_idx" ON "approval"("deal_id");

-- CreateIndex
CREATE INDEX "payment_proof_deal_id_idx" ON "payment_proof"("deal_id");

-- CreateIndex
CREATE INDEX "shipping_proof_deal_id_idx" ON "shipping_proof"("deal_id");

-- CreateIndex
CREATE UNIQUE INDEX "confirmation_deal_id_key" ON "confirmation"("deal_id");

-- CreateIndex
CREATE UNIQUE INDEX "confirmation_deal_id_idempotency_key_key" ON "confirmation"("deal_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "dispute_deal_id_status_idx" ON "dispute"("deal_id", "status");

-- CreateIndex
CREATE INDEX "dispute_evidence_dispute_id_idx" ON "dispute_evidence"("dispute_id");

-- CreateIndex
CREATE INDEX "wallet_user_id_idx" ON "wallet"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_user_id_currency_key" ON "wallet"("user_id", "currency");

-- CreateIndex
CREATE INDEX "wallet_ledger_entry_wallet_id_created_at_idx" ON "wallet_ledger_entry"("wallet_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "wallet_ledger_entry_related_deal_id_idx" ON "wallet_ledger_entry"("related_deal_id");

-- CreateIndex
CREATE INDEX "wallet_ledger_entry_related_withdrawal_id_idx" ON "wallet_ledger_entry"("related_withdrawal_id");

-- CreateIndex
CREATE INDEX "withdrawal_request_seller_user_id_created_at_idx" ON "withdrawal_request"("seller_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "withdrawal_request_status_created_at_idx" ON "withdrawal_request"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_entry_deal_id_created_at_idx" ON "audit_log_entry"("deal_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_entry_actor_user_id_created_at_idx" ON "audit_log_entry"("actor_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_entry_action_type_created_at_idx" ON "audit_log_entry"("action_type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notification_outbox_entry_status_created_at_idx" ON "notification_outbox_entry"("status", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_key_user_id_created_at_idx" ON "idempotency_key"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "external_identity" ADD CONSTRAINT "external_identity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_room" ADD CONSTRAINT "deal_room_creator_user_id_fkey" FOREIGN KEY ("creator_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_participant" ADD CONSTRAINT "deal_participant_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_participant" ADD CONSTRAINT "deal_participant_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_token" ADD CONSTRAINT "invite_token_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_access_token" ADD CONSTRAINT "creator_access_token_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_access_token" ADD CONSTRAINT "creator_access_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participant_access_token" ADD CONSTRAINT "participant_access_token_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participant_access_token" ADD CONSTRAINT "participant_access_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_proof" ADD CONSTRAINT "payment_proof_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_proof" ADD CONSTRAINT "payment_proof_buyer_user_id_fkey" FOREIGN KEY ("buyer_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_proof" ADD CONSTRAINT "shipping_proof_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_proof" ADD CONSTRAINT "shipping_proof_seller_user_id_fkey" FOREIGN KEY ("seller_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "confirmation" ADD CONSTRAINT "confirmation_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "confirmation" ADD CONSTRAINT "confirmation_buyer_user_id_fkey" FOREIGN KEY ("buyer_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_opener_user_id_fkey" FOREIGN KEY ("opener_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "dispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_uploader_user_id_fkey" FOREIGN KEY ("uploader_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet" ADD CONSTRAINT "wallet_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_role" ADD CONSTRAINT "wallet_role_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_ledger_entry" ADD CONSTRAINT "wallet_ledger_entry_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_ledger_entry" ADD CONSTRAINT "wallet_ledger_entry_related_deal_id_fkey" FOREIGN KEY ("related_deal_id") REFERENCES "deal_room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_ledger_entry" ADD CONSTRAINT "wallet_ledger_entry_related_withdrawal_id_fkey" FOREIGN KEY ("related_withdrawal_id") REFERENCES "withdrawal_request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_request" ADD CONSTRAINT "withdrawal_request_seller_user_id_fkey" FOREIGN KEY ("seller_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_request" ADD CONSTRAINT "withdrawal_request_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_request" ADD CONSTRAINT "withdrawal_request_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log_entry" ADD CONSTRAINT "audit_log_entry_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log_entry" ADD CONSTRAINT "audit_log_entry_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log_entry" ADD CONSTRAINT "audit_log_entry_withdrawal_id_fkey" FOREIGN KEY ("withdrawal_id") REFERENCES "withdrawal_request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
