-- Every organization must have a plan, and a POC is now one of the two ways to
-- create one. The durable provisioning request has to be able to hold a POC
-- selection, otherwise a failed cross-service call would lose the operator's
-- credit budget, expiry and feature choice - and "repair" would mean typing
-- them again from memory, which is not repair.

-- Additive and widening only. A POC has no catalog plan version, so the column
-- becomes nullable; every existing PAID_PLAN row keeps its value.
ALTER TABLE "tenant_billing_provisioning_requests"
  ALTER COLUMN "plan_version_id" DROP NOT NULL;

ALTER TABLE "tenant_billing_provisioning_requests"
  ADD COLUMN IF NOT EXISTS "poc_credits" INTEGER,
  ADD COLUMN IF NOT EXISTS "poc_expires_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "poc_feature_areas" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
