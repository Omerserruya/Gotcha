-- AlterEnum: Add INSTAGRAM to ChannelType
ALTER TYPE "ChannelType" ADD VALUE 'INSTAGRAM';

-- CreateEnum: ChannelConnectionStatus
CREATE TYPE "ChannelConnectionStatus" AS ENUM ('PENDING', 'CONNECTED', 'ERROR', 'DISCONNECTED');

-- AlterTable: Add connection lifecycle fields to channel_accounts
ALTER TABLE "channel_accounts" ADD COLUMN "connection_status" "ChannelConnectionStatus" NOT NULL DEFAULT 'CONNECTED';
ALTER TABLE "channel_accounts" ADD COLUMN "connected_at" TIMESTAMP(3);
ALTER TABLE "channel_accounts" ADD COLUMN "connected_by" TEXT;
ALTER TABLE "channel_accounts" ADD COLUMN "token_expires_at" TIMESTAMP(3);
ALTER TABLE "channel_accounts" ADD COLUMN "platform_meta" JSONB;
ALTER TABLE "channel_accounts" ADD COLUMN "last_error" TEXT;
ALTER TABLE "channel_accounts" ADD COLUMN "last_health_check" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "channel_accounts_connection_status_idx" ON "channel_accounts"("connection_status");
CREATE INDEX "channel_accounts_token_expires_at_idx" ON "channel_accounts"("token_expires_at");
