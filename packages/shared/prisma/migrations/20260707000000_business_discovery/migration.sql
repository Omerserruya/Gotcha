-- CreateTable
CREATE TABLE "business_discoveries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "website_domain" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "brand" JSONB,
    "business" JSONB,
    "knowledge" JSONB,
    "communication" JSONB,
    "technology" JSONB,
    "gaps" JSONB,
    "recommendation" JSONB,
    "health" JSONB,
    "confidence" JSONB,
    "report" TEXT,
    "primary_goal" TEXT,
    "scanned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_discoveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "business_discoveries_tenant_id_key" ON "business_discoveries"("tenant_id");

-- AddForeignKey
ALTER TABLE "business_discoveries" ADD CONSTRAINT "business_discoveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
