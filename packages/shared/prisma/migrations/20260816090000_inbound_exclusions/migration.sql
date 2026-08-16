-- Customer phone numbers that must never enter GOTCHA on a given channel.
-- Exists for WhatsApp Coexistence: a number live in both the Business app and
-- the Cloud API delivers every conversation to us, including the private ones
-- the owner keeps on their phone.

CREATE TABLE "inbound_exclusions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "channel" "ChannelType" NOT NULL DEFAULT 'WHATSAPP',
    "channel_account_id" TEXT,
    "customer_external_id" TEXT NOT NULL,
    "display_value" TEXT,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbound_exclusions_pkey" PRIMARY KEY ("id")
);

-- One rule per number per channel: a second attempt updates the note rather
-- than creating a duplicate the reader cannot tell apart.
CREATE UNIQUE INDEX "inbound_exclusions_tenant_id_channel_customer_external_id_key"
    ON "inbound_exclusions"("tenant_id", "channel", "customer_external_id");

-- The inbound hot path reads by (tenant, channel) on every message.
CREATE INDEX "inbound_exclusions_tenant_id_channel_idx"
    ON "inbound_exclusions"("tenant_id", "channel");

ALTER TABLE "inbound_exclusions" ADD CONSTRAINT "inbound_exclusions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inbound_exclusions" ADD CONSTRAINT "inbound_exclusions_channel_account_id_fkey"
    FOREIGN KEY ("channel_account_id") REFERENCES "channel_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
