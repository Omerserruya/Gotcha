-- AlterTable
ALTER TABLE "user_notification_preferences" ADD COLUMN     "whatsapp_opted_in_at" TIMESTAMP(3),
ADD COLUMN     "whatsapp_phone" TEXT;
