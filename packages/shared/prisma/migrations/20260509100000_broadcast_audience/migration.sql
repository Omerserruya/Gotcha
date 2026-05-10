-- Add audience definition column to broadcasts. Stores the combined
-- manual chips + filter rules + everyone-flag the wizard builds. The
-- send worker resolves this to BroadcastRecipient rows at fan-out time.
ALTER TABLE "broadcasts" ADD COLUMN "audience" JSONB;
