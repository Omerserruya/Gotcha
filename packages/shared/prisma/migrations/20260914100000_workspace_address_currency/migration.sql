-- The two workspace facts that had nowhere to live.
--
-- Both nullable with no default: a business that has not told us its address
-- has no address, and inventing one - or defaulting the currency to the
-- billing currency - would put a fact into an AI employee's mouth that nobody
-- ever said. Absent is the honest state and the screen renders it as absent.
ALTER TABLE "business_profiles" ADD COLUMN "address" TEXT;
ALTER TABLE "business_profiles" ADD COLUMN "currency" TEXT;
