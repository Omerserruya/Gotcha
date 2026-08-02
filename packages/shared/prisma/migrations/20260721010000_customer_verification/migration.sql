-- Cross-identity verification grants: OTP to the STORED destination only.
-- See CustomerVerification in schema.prisma and customer-access-guard.ts.
CREATE TABLE "customer_verifications" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "channel_sender_id" TEXT,
  "target_customer_id" TEXT,
  "target_phone" TEXT,
  "target_email" TEXT,
  "method" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "verified_at" TIMESTAMP(3),
  "scope" TEXT NOT NULL DEFAULT 'customer_read',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_verifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "customer_verifications_tenant_id_conversation_id_idx" ON "customer_verifications" ("tenant_id", "conversation_id");
CREATE INDEX "customer_verifications_tenant_id_expires_at_idx" ON "customer_verifications" ("tenant_id", "expires_at");
