-- GOTCHA Shopify Chat App installation records.
--
-- Additive only. Nothing here touches `tenant_integrations`, which belongs
-- to the GOTCHA Core Shopify Integration.

CREATE TYPE "ShopifyChatInstallStatus" AS ENUM ('PENDING', 'ACTIVE', 'UNINSTALLED');

CREATE TABLE "shopify_chat_installations" (
    "id" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "status" "ShopifyChatInstallStatus" NOT NULL DEFAULT 'PENDING',
    "app_identity" TEXT NOT NULL DEFAULT 'gotcha-chat',
    "access_token" TEXT,
    "token_scopes" TEXT,
    "tenant_id" TEXT,
    "channel_account_id" TEXT,
    "verified_domains" JSONB NOT NULL DEFAULT '[]',
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalled_at" TIMESTAMP(3),
    "bound_at" TIMESTAMP(3),
    "last_verified_at" TIMESTAMP(3),
    "last_heartbeat_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_chat_installations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shopify_chat_installations_shop_domain_idx" ON "shopify_chat_installations"("shop_domain");
CREATE INDEX "shopify_chat_installations_tenant_id_idx" ON "shopify_chat_installations"("tenant_id");
CREATE INDEX "shopify_chat_installations_status_idx" ON "shopify_chat_installations"("status");

-- One LIVE installation per shop, enforced by the database rather than by
-- application care: a reinstall race would otherwise leave two rows for the
-- same storefront pointing at two different organizations. Uninstalled rows
-- are exempt so history survives.
CREATE UNIQUE INDEX "shopify_chat_installations_active_shop_key"
    ON "shopify_chat_installations"("shop_domain")
    WHERE "status" <> 'UNINSTALLED';

ALTER TABLE "shopify_chat_installations"
    ADD CONSTRAINT "shopify_chat_installations_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "shopify_chat_installations"
    ADD CONSTRAINT "shopify_chat_installations_channel_account_id_fkey"
    FOREIGN KEY ("channel_account_id") REFERENCES "channel_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
