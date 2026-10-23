-- Onboarding v2: the async learn-the-site job's state and progress events.
-- Additive and nullable: no backfill, no default, nothing reads it but the v2 scan.
ALTER TABLE "business_discoveries" ADD COLUMN "job" JSONB;
