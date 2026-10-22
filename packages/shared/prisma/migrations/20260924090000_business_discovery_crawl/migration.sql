-- What the crawl could SEE, separate from what the model concluded.
--
-- Nullable with no default and no backfill, deliberately: a scan that ran before
-- this column existed has no crawl reach, and inventing one - an empty object, or
-- zeros - would claim a measurement that never happened. NULL means "we did not
-- record this for that scan", which is true and is a different fact from
-- "the crawl read nothing".
--
-- Additive and nullable, so it is safe to apply while services are running.
ALTER TABLE "business_discoveries" ADD COLUMN "crawl" JSONB;
