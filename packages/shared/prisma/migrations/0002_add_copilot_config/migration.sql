-- CreateTable
CREATE TABLE "copilot_configs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "system_prompt" TEXT NOT NULL DEFAULT '',
    "rules" JSONB NOT NULL DEFAULT '[]',
    "tools" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT NOT NULL DEFAULT 'gpt-4o-mini',
    "provider" TEXT NOT NULL DEFAULT 'openai',
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "max_tokens" INTEGER NOT NULL DEFAULT 1024,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "copilot_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "copilot_configs_tenant_id_key" ON "copilot_configs"("tenant_id");

-- AddForeignKey
ALTER TABLE "copilot_configs" ADD CONSTRAINT "copilot_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
