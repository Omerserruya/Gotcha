-- Business skills (AI Studio, design 6): tenant-defined playbooks attached to
-- AI employees, their per-employee assignment, and the per-conversation run.
-- Additive only. See docs/product/ai-studio-skills-automations.md §3.1.

ALTER TABLE "ai_agents" ADD COLUMN "no_skill_policy" TEXT NOT NULL DEFAULT 'answer_from_knowledge';

CREATE TABLE "business_skills" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "situation" TEXT,
    "category" TEXT NOT NULL DEFAULT 'other',
    "when_to_use" TEXT,
    "examples" JSONB NOT NULL DEFAULT '[]',
    "exclusions" JSONB NOT NULL DEFAULT '[]',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "rules" JSONB NOT NULL DEFAULT '[]',
    "required_info" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),
    CONSTRAINT "business_skills_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_skills" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "ai_agent_id" TEXT NOT NULL,
    "skill_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'watch',
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_skills_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "skill_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "ai_agent_id" TEXT NOT NULL,
    "skill_id" TEXT NOT NULL,
    "skill_version" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "current_step_id" TEXT,
    "gathered_keys" JSONB NOT NULL DEFAULT '[]',
    "stop_reason" TEXT,
    "trace" JSONB NOT NULL DEFAULT '[]',
    "missed_turns" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "skill_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "business_skills_tenant_id_status_idx" ON "business_skills"("tenant_id", "status");
CREATE UNIQUE INDEX "agent_skills_ai_agent_id_skill_id_key" ON "agent_skills"("ai_agent_id", "skill_id");
CREATE INDEX "agent_skills_tenant_id_skill_id_idx" ON "agent_skills"("tenant_id", "skill_id");
CREATE INDEX "skill_runs_tenant_id_conversation_id_status_idx" ON "skill_runs"("tenant_id", "conversation_id", "status");
CREATE INDEX "skill_runs_tenant_id_skill_id_started_at_idx" ON "skill_runs"("tenant_id", "skill_id", "started_at");
CREATE INDEX "skill_runs_tenant_id_ai_agent_id_started_at_idx" ON "skill_runs"("tenant_id", "ai_agent_id", "started_at");

ALTER TABLE "business_skills" ADD CONSTRAINT "business_skills_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_ai_agent_id_fkey" FOREIGN KEY ("ai_agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "business_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "business_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
