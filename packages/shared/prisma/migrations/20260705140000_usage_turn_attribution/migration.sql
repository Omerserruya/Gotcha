-- P1-6: per-turn attribution on AI usage rows. turn_id groups every micro-call
-- of one customer turn; duration_ms is that call's wall time; ai_agent_id
-- denormalizes the employee for per-employee cost/latency rollups.
ALTER TABLE "usage_logs" ADD COLUMN "turn_id" TEXT;
ALTER TABLE "usage_logs" ADD COLUMN "duration_ms" INTEGER;
ALTER TABLE "usage_logs" ADD COLUMN "ai_agent_id" TEXT;
CREATE INDEX "usage_logs_tenant_id_ai_agent_id_idx" ON "usage_logs"("tenant_id", "ai_agent_id");
CREATE INDEX "usage_logs_tenant_id_turn_id_idx" ON "usage_logs"("tenant_id", "turn_id");
