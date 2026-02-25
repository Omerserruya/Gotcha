-- CreateTable
CREATE TABLE "token_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_tokens" INTEGER NOT NULL,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL,
    "conversation_id" TEXT,
    "document_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "token_logs_tenant_id_idx" ON "token_logs"("tenant_id");

-- CreateIndex
CREATE INDEX "token_logs_tenant_id_type_idx" ON "token_logs"("tenant_id", "type");

-- CreateIndex
CREATE INDEX "token_logs_tenant_id_created_at_idx" ON "token_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "token_logs_conversation_id_idx" ON "token_logs"("conversation_id");
