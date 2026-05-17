-- CreateTable
CREATE TABLE "post_conversation_configs" (
    "tenant_id" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_conversation_configs_pkey" PRIMARY KEY ("tenant_id")
);
