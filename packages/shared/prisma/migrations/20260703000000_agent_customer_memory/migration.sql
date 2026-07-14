-- CreateTable: Agent Loop cross-turn memory (AgentMemory per agent × customer).
-- Advisory continuity for the cognitive kernel - Facts always override it.
CREATE TABLE "agent_customer_memory" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "customer_external_id" TEXT NOT NULL,
    "memory" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_customer_memory_pkey" PRIMARY KEY ("id")
);

-- One memory row per agent × customer (tenant-scoped).
CREATE UNIQUE INDEX "agent_customer_memory_tenant_id_agent_id_customer_external_key"
    ON "agent_customer_memory"("tenant_id", "agent_id", "customer_external_id");

CREATE INDEX "agent_customer_memory_tenant_id_updated_at_idx"
    ON "agent_customer_memory"("tenant_id", "updated_at");
