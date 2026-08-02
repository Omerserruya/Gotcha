-- Deterministic tenant business rules for sensitive AI actions + append-only
-- decision audit. See packages/shared/src/lib/business-policy.ts.
CREATE TABLE "business_action_policies" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "action_kind" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "config" JSONB NOT NULL DEFAULT '{}',
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "business_action_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "business_action_policies_tenant_id_action_kind_version_key"
  ON "business_action_policies" ("tenant_id", "action_kind", "version");
CREATE INDEX "business_action_policies_tenant_id_action_kind_idx"
  ON "business_action_policies" ("tenant_id", "action_kind");

CREATE TABLE "policy_decisions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "policy_id" TEXT,
  "policy_version" INTEGER,
  "action_kind" TEXT NOT NULL,
  "evaluation_point" TEXT NOT NULL,
  "conversation_id" TEXT,
  "contact_id" TEXT,
  "ai_employee_id" TEXT,
  "tool" TEXT,
  "input_facts" JSONB NOT NULL DEFAULT '{}',
  "decision" TEXT NOT NULL,
  "matched_rules" JSONB NOT NULL DEFAULT '[]',
  "reason_codes" JSONB NOT NULL DEFAULT '[]',
  "max_amount" DOUBLE PRECISION,
  "correlation_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "policy_decisions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "policy_decisions_tenant_id_created_at_idx" ON "policy_decisions" ("tenant_id", "created_at");
CREATE INDEX "policy_decisions_tenant_id_action_kind_idx" ON "policy_decisions" ("tenant_id", "action_kind");
