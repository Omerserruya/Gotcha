-- GDPR data-lifecycle machinery: consent, retention, DSR tracking.

-- ConsentRecord (Art. 6/7): append-only proof-of-consent ledger.
CREATE TABLE "consent_records" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "source" TEXT,
    "evidence" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "consent_records_tenant_id_idx" ON "consent_records"("tenant_id");
CREATE INDEX "consent_records_tenant_id_subject_type_subject_id_idx" ON "consent_records"("tenant_id", "subject_type", "subject_id");
CREATE INDEX "consent_records_tenant_id_purpose_idx" ON "consent_records"("tenant_id", "purpose");
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DataRetentionPolicy (Art. 5(1)(e)): per-tenant retention windows.
CREATE TABLE "data_retention_policies" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "retention_days" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_purge_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "data_retention_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "data_retention_policies_tenant_id_category_key" ON "data_retention_policies"("tenant_id", "category");
CREATE INDEX "data_retention_policies_tenant_id_idx" ON "data_retention_policies"("tenant_id");
ALTER TABLE "data_retention_policies" ADD CONSTRAINT "data_retention_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DataSubjectRequest (Art. 15/17/20/30): DSR tracking + proof of fulfilment.
CREATE TABLE "data_subject_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "request_type" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requested_by" TEXT,
    "result" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "data_subject_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "data_subject_requests_tenant_id_idx" ON "data_subject_requests"("tenant_id");
CREATE INDEX "data_subject_requests_tenant_id_request_type_idx" ON "data_subject_requests"("tenant_id", "request_type");
CREATE INDEX "data_subject_requests_tenant_id_subject_type_subject_id_idx" ON "data_subject_requests"("tenant_id", "subject_type", "subject_id");
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
