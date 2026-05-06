-- Action Contracts (deterministic tool-chain enforcement)

CREATE TABLE "action_contracts" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "required_tools" JSONB NOT NULL,
  "execution_mode" TEXT NOT NULL,
  "order" JSONB,
  "blocking" BOOLEAN NOT NULL DEFAULT true,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "action_contracts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "action_contracts_tenant_id_trigger_key" ON "action_contracts"("tenant_id", "trigger");
CREATE INDEX "action_contracts_tenant_id_is_active_idx" ON "action_contracts"("tenant_id", "is_active");

CREATE TABLE "action_contract_progress" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "contract_id" TEXT NOT NULL,
  "completed_tools" JSONB NOT NULL DEFAULT '[]',
  "next_step_index" INTEGER NOT NULL DEFAULT 0,
  "paused_reason" TEXT,
  "fulfilled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "action_contract_progress_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "action_contract_progress_conversation_id_contract_id_key" ON "action_contract_progress"("conversation_id", "contract_id");
CREATE INDEX "action_contract_progress_tenant_id_conversation_id_idx" ON "action_contract_progress"("tenant_id", "conversation_id");
