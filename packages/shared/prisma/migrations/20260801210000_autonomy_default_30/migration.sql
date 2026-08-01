-- Raise the autonomy budget default for NEWLY created AI employees.
--
-- Ten AI replies is a short conversation. A product question, a size check, an
-- order lookup and a cancellation is already most of it, and the dev agent hit
-- the ceiling mid-test on an ordinary support flow - the customer experiences
-- that as being abandoned, which is the opposite of what the rail is for.
--
-- DEFAULT only. Existing rows keep whatever their tenant chose; nothing here
-- touches configured values.
ALTER TABLE "ai_agents" ALTER COLUMN "max_autonomous_messages" SET DEFAULT 30;
