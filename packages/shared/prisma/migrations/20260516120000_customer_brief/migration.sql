-- CreateTable
CREATE TABLE "customer_briefs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "identity_key" TEXT NOT NULL,
    "person_id" TEXT,
    "crm_contact_id" TEXT,
    "crm_object_kind" TEXT,
    "contact_id" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "brief" TEXT NOT NULL,
    "signals" JSONB NOT NULL DEFAULT '[]',
    "tone" TEXT,
    "mood" TEXT,
    "recommended_behaviors" JSONB NOT NULL DEFAULT '[]',
    "channels" JSONB NOT NULL DEFAULT '[]',
    "conversation_count" INTEGER NOT NULL DEFAULT 0,
    "last_source_channel" TEXT,
    "last_source_conv_id" TEXT,
    "last_source_event" TEXT,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_briefs_tenant_id_identity_key_locale_key" ON "customer_briefs"("tenant_id", "identity_key", "locale");

-- CreateIndex
CREATE INDEX "customer_briefs_tenant_id_idx" ON "customer_briefs"("tenant_id");

-- CreateIndex
CREATE INDEX "customer_briefs_tenant_id_person_id_idx" ON "customer_briefs"("tenant_id", "person_id");

-- CreateIndex
CREATE INDEX "customer_briefs_tenant_id_crm_contact_id_idx" ON "customer_briefs"("tenant_id", "crm_contact_id");

-- CreateIndex
CREATE INDEX "customer_briefs_tenant_id_contact_id_idx" ON "customer_briefs"("tenant_id", "contact_id");
