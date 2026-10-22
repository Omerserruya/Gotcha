-- A pinned note sorts first, here and in the Inbox Copilot.
--
-- 04f names it twice, and the second is a behaviour in ANOTHER surface
-- ("pinned notes show at the top of the Inbox Copilot whenever she writes"),
-- so it is a column rather than a client-side preference. Added while the
-- table is still empty.
ALTER TABLE "customer_notes" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
