-- P1-5: persist the last readiness-test report on the AI agent so the owner can
-- re-view coverage without re-running the LLM-costly generator each time.
ALTER TABLE "ai_agents" ADD COLUMN "readiness_report" JSONB;
