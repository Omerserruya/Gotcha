-- Private contacts per WhatsApp number: the same contact can be excluded on
-- one number and not on another. Hand-written; the first two statements are
-- exactly Prisma's schema-to-schema diff.

DROP INDEX "inbound_exclusions_tenant_id_channel_customer_external_id_key";

CREATE UNIQUE INDEX "inbound_exclusions_tenant_id_channel_channel_account_id_cus_key" ON "inbound_exclusions"("tenant_id", "channel", "channel_account_id", "customer_external_id");

-- Legacy rules have no number ("every number"). Postgres treats NULLs as
-- distinct, so the key above would let the same contact be excluded on every
-- number twice. This partial index keeps those unique, as the old key did.
-- Prisma's schema cannot express it: a later generated diff may propose
-- dropping it; that statement must be removed (see dev-environment-hazards).
CREATE UNIQUE INDEX "inbound_exclusions_all_numbers_key" ON "inbound_exclusions"("tenant_id", "channel", "customer_external_id") WHERE "channel_account_id" IS NULL;
