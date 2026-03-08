-- DropForeignKey
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_channel_account_id_fkey";

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "file_name" TEXT,
ADD COLUMN     "media_url" TEXT;

-- AlterTable
ALTER TABLE "tenants" ALTER COLUMN "status" SET DEFAULT 'PENDING_ADMIN_SETUP';

-- AlterTable
ALTER TABLE "waitlist_entries" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_account_id_fkey" FOREIGN KEY ("channel_account_id") REFERENCES "channel_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chatbot_flows" ADD CONSTRAINT "chatbot_flows_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
