-- CreateTable
CREATE TABLE "scheduled_nudges" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "channel" TEXT NOT NULL DEFAULT 'email',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_nudges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_nudges_status_scheduled_for_idx" ON "scheduled_nudges"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "scheduled_nudges_tenant_id_status_idx" ON "scheduled_nudges"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_nudges_tenant_id_dedupe_key_key" ON "scheduled_nudges"("tenant_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "scheduled_nudges" ADD CONSTRAINT "scheduled_nudges_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
