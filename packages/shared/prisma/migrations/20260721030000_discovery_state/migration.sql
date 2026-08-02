-- Discovery State: structured conversational memory. See
-- packages/shared/src/lib/discovery-state.ts.
CREATE TYPE "DiscoveryStatus" AS ENUM ('active','ready_for_action','awaiting_customer','action_in_progress','fulfilled','abandoned','superseded');

CREATE TABLE "discovery_sessions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "ai_agent_id" TEXT,
  "goal_key" TEXT NOT NULL,
  "status" "DiscoveryStatus" NOT NULL DEFAULT 'active',
  "version" INTEGER NOT NULL DEFAULT 0,
  "schema_version" INTEGER NOT NULL DEFAULT 1,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3),
  CONSTRAINT "discovery_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "discovery_sessions_tenant_id_conversation_id_status_idx" ON "discovery_sessions" ("tenant_id","conversation_id","status");
CREATE INDEX "discovery_sessions_tenant_id_expires_at_idx" ON "discovery_sessions" ("tenant_id","expires_at");

CREATE TABLE "discovery_facts" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "normalized_key" TEXT NOT NULL,
  "value_type" TEXT NOT NULL,
  "value_json" JSONB NOT NULL,
  "normalized_value_json" JSONB,
  "source" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.9,
  "status" TEXT NOT NULL DEFAULT 'active',
  "source_message_id" TEXT,
  "explicitly_confirmed" BOOLEAN NOT NULL DEFAULT false,
  "requires_confirmation" BOOLEAN NOT NULL DEFAULT false,
  "sensitivity" TEXT NOT NULL DEFAULT 'normal',
  "supersedes_fact_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "discovery_facts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "discovery_facts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "discovery_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "discovery_facts_session_id_status_idx" ON "discovery_facts" ("session_id","status");
CREATE INDEX "discovery_facts_session_id_normalized_key_status_idx" ON "discovery_facts" ("session_id","normalized_key","status");

CREATE TABLE "discovery_questions" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "requirement_key" TEXT NOT NULL,
  "normalized_question_key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'planned',
  "asked_message_id" TEXT,
  "answered_message_id" TEXT,
  "asked_at" TIMESTAMP(3),
  "answered_at" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "discovery_questions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "discovery_questions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "discovery_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "discovery_questions_session_id_status_idx" ON "discovery_questions" ("session_id","status");
CREATE INDEX "discovery_questions_session_id_normalized_question_key_idx" ON "discovery_questions" ("session_id","normalized_question_key");

CREATE TABLE "discovery_action_attempts" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "action_key" TEXT NOT NULL,
  "criteria_json" JSONB NOT NULL,
  "tool_name" TEXT,
  "execution_id" TEXT,
  "result_status" TEXT NOT NULL,
  "result_refs" JSONB,
  "shown_resource_ids" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "discovery_action_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "discovery_action_attempts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "discovery_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "discovery_action_attempts_session_id_created_at_idx" ON "discovery_action_attempts" ("session_id","created_at");
