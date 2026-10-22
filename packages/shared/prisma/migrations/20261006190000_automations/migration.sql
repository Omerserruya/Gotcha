-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "automation_run_id" TEXT;

-- AlterTable
ALTER TABLE "chatbot_flows" ADD COLUMN     "activated_at" TIMESTAMP(3),
ADD COLUMN     "activated_by" TEXT,
ADD COLUMN     "paused_at" TIMESTAMP(3),
ADD COLUMN     "paused_by" TEXT,
ADD COLUMN     "trigger_config" JSONB,
ADD COLUMN     "trigger_type" TEXT;

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "flow_id" TEXT NOT NULL,
    "trigger_type" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "conversation_id" TEXT,
    "contact_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "answered_inbound" BOOLEAN NOT NULL DEFAULT false,
    "current_node_id" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_run_steps" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "node_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "branch" TEXT,
    "output" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_runs_tenant_id_flow_id_started_at_idx" ON "automation_runs"("tenant_id", "flow_id", "started_at");

-- CreateIndex
CREATE INDEX "automation_runs_tenant_id_conversation_id_started_at_idx" ON "automation_runs"("tenant_id", "conversation_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_flow_id_event_key_key" ON "automation_runs"("flow_id", "event_key");

-- CreateIndex
CREATE INDEX "automation_run_steps_run_id_at_idx" ON "automation_run_steps"("run_id", "at");

-- CreateIndex
CREATE INDEX "automation_run_steps_tenant_id_node_id_idx" ON "automation_run_steps"("tenant_id", "node_id");

-- CreateIndex
CREATE INDEX "chatbot_flows_tenant_id_trigger_type_is_active_idx" ON "chatbot_flows"("tenant_id", "trigger_type", "is_active");

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "chatbot_flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "automation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
