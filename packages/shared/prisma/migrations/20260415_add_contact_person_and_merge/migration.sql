-- F1 fix: cross-channel identity via personId + soft-merge via mergedIntoId.
--
-- Before this migration, Contact.merge hard-deleted the source row, causing
-- "ghost contacts" - the next inbound message on the merged-away channel
-- would create a brand-new row because nothing followed the merge history.
-- Metadata.aliases fixed the read path (timeline) but not the write path
-- (incoming webhook contact lookup). See
-- memory/bug_f1_merge_ghost_contacts.md for the full analysis.
--
-- This migration:
--   1. Adds `person_id` - shared across rows that belong to the same real
--      human. Populated by the unifier on auto-link (email/phone match) or
--      explicit capture via /api/identity/capture.
--   2. Adds `merged_into_id` - soft-merge pointer. When set, the row has
--      been merged into merged_into_id. The row is kept so incoming webhook
--      lookups by (tenant_id, channel, external_id) still resolve -
--      resolveContactByChannelId() follows the pointer to the target.
--   3. Adds supporting indexes for personId + mergedIntoId lookups.
--
-- Both columns are nullable - existing rows have no person assignment and
-- no merge state, which is the correct default for historical data.

ALTER TABLE "contacts" ADD COLUMN "person_id" TEXT;
ALTER TABLE "contacts" ADD COLUMN "merged_into_id" TEXT;

CREATE INDEX "contacts_tenant_id_person_id_idx" ON "contacts"("tenant_id", "person_id");
CREATE INDEX "contacts_merged_into_id_idx" ON "contacts"("merged_into_id");
