-- CreateTable
CREATE TABLE "recommendations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'discovery',
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT,
    "action" TEXT,
    "target_slug" TEXT,
    "confidence" TEXT NOT NULL DEFAULT 'likely',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "dedupe_key" TEXT NOT NULL,
    "payload" JSONB,
    "completed_at" TIMESTAMP(3),
    "dismissed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recommendations_tenant_id_status_priority_idx" ON "recommendations"("tenant_id", "status", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "recommendations_tenant_id_dedupe_key_key" ON "recommendations"("tenant_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
