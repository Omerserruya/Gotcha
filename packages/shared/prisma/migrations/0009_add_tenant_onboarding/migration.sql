-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('PENDING_ADMIN_SETUP', 'PENDING_ONBOARDING', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "AIMode" AS ENUM ('COPILOT', 'AUTONOMOUS', 'HYBRID');

-- CreateEnum
CREATE TYPE "BusinessPriority" AS ENUM ('MAXIMIZE_SALES', 'FAST_RESPONSE', 'PREMIUM_EXPERIENCE', 'REDUCE_WORKLOAD');

-- CreateEnum
CREATE TYPE "OnboardingStep" AS ENUM ('BUSINESS_PROFILE', 'DEPARTMENTS', 'COMPLETED');

-- AlterTable: Add status to tenants
ALTER TABLE "tenants" ADD COLUMN "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- AlterTable: Add onboarding fields to departments
ALTER TABLE "departments" ADD COLUMN "ai_mode" "AIMode" NOT NULL DEFAULT 'COPILOT';
ALTER TABLE "departments" ADD COLUMN "working_hours" JSONB;
ALTER TABLE "departments" ADD COLUMN "sla_target" INTEGER;
ALTER TABLE "departments" ADD COLUMN "escalation_policy" JSONB;
ALTER TABLE "departments" ADD COLUMN "auto_greeting_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "departments" ADD COLUMN "auto_greeting_message" TEXT;
ALTER TABLE "departments" ADD COLUMN "auto_close_minutes" INTEGER;
ALTER TABLE "departments" ADD COLUMN "escalate_on_sla_breach" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "departments" ADD COLUMN "ai_suggestions_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "departments" ADD COLUMN "auto_replies_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: BusinessProfile
CREATE TABLE "business_profiles" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "organization_name" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "business_description" TEXT NOT NULL,
    "business_priority" "BusinessPriority" NOT NULL,
    "estimated_daily_conversations" INTEGER NOT NULL,
    "number_of_agents" INTEGER NOT NULL,
    "ai_mode" "AIMode" NOT NULL DEFAULT 'COPILOT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "business_profiles_tenant_id_key" ON "business_profiles"("tenant_id");

-- AddForeignKey
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: TenantOnboarding
CREATE TABLE "tenant_onboardings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "current_step" "OnboardingStep" NOT NULL DEFAULT 'BUSINESS_PROFILE',
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_onboardings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_onboardings_tenant_id_key" ON "tenant_onboardings"("tenant_id");

-- AddForeignKey
ALTER TABLE "tenant_onboardings" ADD CONSTRAINT "tenant_onboardings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: AgentConfig
CREATE TABLE "agent_configs" (
    "id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "identity" JSONB NOT NULL,
    "goals" JSONB NOT NULL,
    "tone" JSONB NOT NULL,
    "behavioral" JSONB NOT NULL,
    "mode_constraints" JSONB NOT NULL,
    "tools" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_configs_department_id_key" ON "agent_configs"("department_id");

-- CreateIndex
CREATE INDEX "agent_configs_department_id_idx" ON "agent_configs"("department_id");

-- AddForeignKey
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: NotificationLog
CREATE TABLE "notification_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "metadata" JSONB,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_logs_tenant_id_idx" ON "notification_logs"("tenant_id");

-- CreateIndex
CREATE INDEX "notification_logs_type_status_idx" ON "notification_logs"("type", "status");
