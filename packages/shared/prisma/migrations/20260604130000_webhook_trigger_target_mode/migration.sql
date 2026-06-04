-- Webhook trigger dual target mode.
--
-- Adds `target_mode` to webhook_triggers so an inbound POST can either run the
-- associated ChatbotFlow ("flow", the original behavior) or walk the nodes
-- wired to the webhook trigger node on the Main Playbook canvas ("connected").
--
-- Purely additive (new nullable-with-default column); existing rows keep the
-- original behavior because the default is "flow". Idempotent so it is safe to
-- re-run on environments seeded via `prisma db push`.

ALTER TABLE "webhook_triggers"
  ADD COLUMN IF NOT EXISTS "target_mode" TEXT NOT NULL DEFAULT 'flow';
