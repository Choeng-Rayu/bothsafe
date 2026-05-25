-- AlterTable
ALTER TABLE "deal_room" ADD COLUMN     "delivery_address" TEXT,
ADD COLUMN     "delivery_method" TEXT,
ADD COLUMN     "delivery_note" TEXT,
ADD COLUMN     "payout_account_name" TEXT,
ADD COLUMN     "payout_account_number" TEXT,
ADD COLUMN     "payout_bank_name" TEXT,
ADD COLUMN     "payout_khqr" TEXT;
