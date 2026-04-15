-- Add verified flags to contacts
ALTER TABLE "contacts" ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "contacts" ADD COLUMN "phone_verified" BOOLEAN NOT NULL DEFAULT false;

-- Enums
CREATE TYPE "IdentityLinkStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'APPLIED');
CREATE TYPE "IdentityLinkIdentifierType" AS ENUM ('EMAIL', 'PHONE');

-- Suggestion table
CREATE TABLE "identity_link_suggestions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_contact_id" TEXT NOT NULL,
    "target_contact_id" TEXT NOT NULL,
    "identifier_type" "IdentityLinkIdentifierType" NOT NULL,
    "identifier_value" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "IdentityLinkStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "decided_by" TEXT,

    CONSTRAINT "identity_link_suggestions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "identity_link_unique" ON "identity_link_suggestions"("tenant_id", "source_contact_id", "target_contact_id", "identifier_type", "identifier_value");
CREATE INDEX "identity_link_suggestions_tenant_id_status_idx" ON "identity_link_suggestions"("tenant_id", "status");
CREATE INDEX "identity_link_suggestions_tenant_id_target_contact_id_idx" ON "identity_link_suggestions"("tenant_id", "target_contact_id");
