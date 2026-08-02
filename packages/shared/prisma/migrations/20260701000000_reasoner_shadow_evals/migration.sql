-- CreateTable: permanent provider-neutral evaluation corpus
CREATE TABLE "reasoner_shadow_evals" (
    "id" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "turn_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "reasoner_input" JSONB NOT NULL,
    "planner_decision" JSONB NOT NULL,
    "reasoner_decision" JSONB NOT NULL,
    "agree" BOOLEAN NOT NULL,
    "move_type_match" BOOLEAN NOT NULL,
    "detail_match" BOOLEAN NOT NULL,
    "divergence_axis" TEXT NOT NULL,
    "executed_operation" TEXT,
    "runtime_result" TEXT,
    "final_business_outcome" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "latency_ms" INTEGER,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "reasoning_trace" TEXT,
    "metadata" JSONB,
    CONSTRAINT "reasoner_shadow_evals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "reasoner_shadow_evals_tenant_id_created_at_idx" ON "reasoner_shadow_evals"("tenant_id", "created_at");
CREATE INDEX "reasoner_shadow_evals_conversation_id_idx" ON "reasoner_shadow_evals"("conversation_id");
CREATE INDEX "reasoner_shadow_evals_divergence_axis_idx" ON "reasoner_shadow_evals"("divergence_axis");
CREATE INDEX "reasoner_shadow_evals_agree_idx" ON "reasoner_shadow_evals"("agree");
CREATE INDEX "reasoner_shadow_evals_provider_model_prompt_version_idx" ON "reasoner_shadow_evals"("provider", "model", "prompt_version");
