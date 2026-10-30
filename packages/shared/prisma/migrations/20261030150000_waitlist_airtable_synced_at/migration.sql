-- When the team's Airtable got this lead. Additive and nullable: existing
-- rows read as "not synced", and the retry only looks at leads since the
-- landing forms went live, so nothing older is re-sent.
ALTER TABLE "waitlist_entries" ADD COLUMN "airtable_synced_at" TIMESTAMP(3);
