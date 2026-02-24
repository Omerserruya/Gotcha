-- AlterEnum: Add AI_CONFIG to OnboardingStep
ALTER TYPE "OnboardingStep" ADD VALUE 'AI_CONFIG';

-- AlterTable: Add firstTakeCareEnabled to tenants
ALTER TABLE "tenants" ADD COLUMN "first_take_care_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: Add structured AI personality blocks to copilot_configs
ALTER TABLE "copilot_configs" ADD COLUMN "identity" JSONB;
ALTER TABLE "copilot_configs" ADD COLUMN "goals" JSONB;
ALTER TABLE "copilot_configs" ADD COLUMN "tone" JSONB;
ALTER TABLE "copilot_configs" ADD COLUMN "behavioral" JSONB;

-- AlterTable: Add structured AI personality blocks to department_copilot_configs
ALTER TABLE "department_copilot_configs" ADD COLUMN "identity" JSONB;
ALTER TABLE "department_copilot_configs" ADD COLUMN "goals" JSONB;
ALTER TABLE "department_copilot_configs" ADD COLUMN "tone" JSONB;
ALTER TABLE "department_copilot_configs" ADD COLUMN "behavioral" JSONB;

-- CreateTable: FirstTakeCareConfig
CREATE TABLE "first_take_care_configs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "system_prompt" TEXT NOT NULL DEFAULT '',
    "rules" JSONB NOT NULL DEFAULT '[]',
    "tools" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT NOT NULL DEFAULT 'gpt-4o-mini',
    "provider" TEXT NOT NULL DEFAULT 'openai',
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "max_tokens" INTEGER NOT NULL DEFAULT 1024,
    "identity" JSONB,
    "goals" JSONB,
    "tone" JSONB,
    "behavioral" JSONB,
    "max_autonomous_messages" INTEGER NOT NULL DEFAULT 10,
    "max_autonomous_minutes" INTEGER NOT NULL DEFAULT 15,
    "confidence_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
    "escalation_message" TEXT NOT NULL DEFAULT 'Let me connect you with a team member who can help further.',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "first_take_care_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "first_take_care_configs_tenant_id_key" ON "first_take_care_configs"("tenant_id");

-- AddForeignKey
ALTER TABLE "first_take_care_configs" ADD CONSTRAINT "first_take_care_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
