-- Reverses 20261023120000_business_discovery_job. Drops only the job column;
-- the scan results it pointed at live in their own columns and in the knowledge base.
ALTER TABLE "business_discoveries" DROP COLUMN IF EXISTS "job";
