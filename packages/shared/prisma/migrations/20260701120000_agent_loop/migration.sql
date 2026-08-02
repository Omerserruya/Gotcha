-- CreateTable: Agent Loop run (one row per autonomous reasoning loop)
CREATE TABLE "agent_loop_runs" (
    "id" TEXT NOT NULL,
    "loop_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "turn_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "goal" TEXT,
    "termination_reason" TEXT NOT NULL,
    "iteration_count" INTEGER NOT NULL,
    "spent_units" INTEGER NOT NULL,
    "wall_ms" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "final_decision" JSONB NOT NULL,
    "final_reply_intent" JSONB NOT NULL,
    "reply" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    CONSTRAINT "agent_loop_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Agent Loop iteration (one row per reason→execute cycle)
CREATE TABLE "agent_loop_iterations" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "loop_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL,
    "goal" TEXT,
    "oracle_facts_snapshot" JSONB NOT NULL,
    "reasoning_summary" TEXT NOT NULL,
    "decision_type" TEXT NOT NULL,
    "proposed_operation" TEXT,
    "proposed_params" JSONB,
    "runtime_result" TEXT,
    "observation" JSONB,
    "facts_signature" TEXT,
    "progressed" BOOLEAN,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "latency_ms" INTEGER,
    CONSTRAINT "agent_loop_iterations_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "agent_loop_runs_loop_id_key" ON "agent_loop_runs"("loop_id");
CREATE INDEX "agent_loop_runs_tenant_id_created_at_idx" ON "agent_loop_runs"("tenant_id", "created_at");
CREATE INDEX "agent_loop_runs_conversation_id_idx" ON "agent_loop_runs"("conversation_id");
CREATE INDEX "agent_loop_runs_termination_reason_idx" ON "agent_loop_runs"("termination_reason");
CREATE INDEX "agent_loop_runs_goal_idx" ON "agent_loop_runs"("goal");

CREATE UNIQUE INDEX "agent_loop_iterations_loop_id_iteration_key" ON "agent_loop_iterations"("loop_id", "iteration");
CREATE INDEX "agent_loop_iterations_tenant_id_created_at_idx" ON "agent_loop_iterations"("tenant_id", "created_at");
CREATE INDEX "agent_loop_iterations_conversation_id_idx" ON "agent_loop_iterations"("conversation_id");

-- FK: iterations → run (by loop_id)
ALTER TABLE "agent_loop_iterations" ADD CONSTRAINT "agent_loop_iterations_loop_id_fkey"
    FOREIGN KEY ("loop_id") REFERENCES "agent_loop_runs"("loop_id") ON DELETE CASCADE ON UPDATE CASCADE;
