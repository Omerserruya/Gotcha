-- CreateTable
CREATE TABLE "business_policies" (
    "tenant_id" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_policies_pkey" PRIMARY KEY ("tenant_id")
);
