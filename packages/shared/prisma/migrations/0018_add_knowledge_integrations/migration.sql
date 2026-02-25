-- CreateTable
CREATE TABLE "knowledge_integrations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "knowledge_base_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "credentials" JSONB NOT NULL,
    "display_name" TEXT NOT NULL,
    "config" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_integrations_tenant_id_idx" ON "knowledge_integrations"("tenant_id");

-- CreateIndex
CREATE INDEX "knowledge_integrations_knowledge_base_id_idx" ON "knowledge_integrations"("knowledge_base_id");

-- AddForeignKey
ALTER TABLE "knowledge_integrations" ADD CONSTRAINT "knowledge_integrations_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
