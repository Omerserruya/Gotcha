-- Drop the AIAgent.mode column and its enum. Autonomous-vs-copilot is
-- no longer a property of the agent itself — it is derived from the
-- route context: an agent referenced by a RouterRule of type AI_AGENT
-- runs autonomously on that route, and otherwise surfaces as a
-- co-pilot via /api/ai-assist/*.

ALTER TABLE "ai_agents" DROP COLUMN IF EXISTS "mode";
DROP TYPE IF EXISTS "AIAgentMode";
