-- Webhook trigger: drop the workflow_id → chatbot_flows foreign key.
--
-- In "connected" target mode the webhook trigger does not run a separate flow —
-- the `workflow_id` is only an auto-anchor: the trigger node's own canvas id on
-- the Main Playbook (FlowCanvas), which is NOT a chatbot_flows row. Forcing the
-- FK meant connected mode had to borrow a real (bogus) flow id, which is exactly
-- the "must pick a flow" friction this card removes. After this, connected-mode
-- triggers anchor to the node id with no flow pick.
--
-- "flow" mode still references a real ChatbotFlow, but its existence is now
-- validated in application code (services/webhook trigger-admin.ts) rather than
-- by the DB constraint. Tradeoff: flow deletion no longer ON DELETE CASCADE-s
-- its flow-mode trigger row (the trigger is left harmless — an inbound POST to a
-- deleted flow no-ops). Go-forward only; existing rows are untouched.
--
-- Idempotent (IF EXISTS) so it is safe to re-run on environments seeded
-- out-of-band via `prisma db push`. The workflow_id column + its index remain.

ALTER TABLE "webhook_triggers" DROP CONSTRAINT IF EXISTS "webhook_triggers_workflow_id_fkey";
