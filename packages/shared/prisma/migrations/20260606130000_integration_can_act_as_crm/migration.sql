-- Add `can_act_as_crm` to the integration catalog.
--
-- Lets an integration whose native category is NOT "CRM" still be elected as a
-- tenant's CRM source of truth (via tenant_integrations.config.useAsCrm) and,
-- as a result, surface in the CRM-locked Settings → Integrations explorer.
ALTER TABLE "integration_catalog"
  ADD COLUMN "can_act_as_crm" BOOLEAN NOT NULL DEFAULT false;

-- Shopify (ECOMMERCE) is the one integration that supports the CRM-source
-- opt-in today. Backfill the flag so existing catalogs reflect this.
UPDATE "integration_catalog" SET "can_act_as_crm" = true WHERE "slug" = 'shopify';
