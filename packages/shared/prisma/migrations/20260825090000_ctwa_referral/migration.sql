-- Click-to-WhatsApp: where a conversation came from.
ALTER TABLE "conversations" ADD COLUMN "referral_source_type" TEXT;
ALTER TABLE "conversations" ADD COLUMN "referral_source_id" TEXT;
ALTER TABLE "conversations" ADD COLUMN "referral_source_url" TEXT;
ALTER TABLE "conversations" ADD COLUMN "referral_headline" TEXT;
ALTER TABLE "conversations" ADD COLUMN "referral_body" TEXT;
ALTER TABLE "conversations" ADD COLUMN "referral_ctwa_clid" TEXT;
ALTER TABLE "conversations" ADD COLUMN "from_ad_campaign" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "conversations" ADD COLUMN "referral_at" TIMESTAMP(3);

CREATE INDEX "conversations_tenant_id_from_ad_campaign_idx" ON "conversations"("tenant_id", "from_ad_campaign");
CREATE INDEX "conversations_tenant_id_referral_source_id_idx" ON "conversations"("tenant_id", "referral_source_id");
