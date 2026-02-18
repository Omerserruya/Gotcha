-- CreateEnum
CREATE TYPE "DepartmentRole" AS ENUM ('AGENT', 'MANAGER');

-- CreateEnum
CREATE TYPE "DepartmentQueueMode" AS ENUM ('CLAIM', 'ROUND_ROBIN');

-- CreateEnum
CREATE TYPE "CopilotMode" AS ENUM ('READY_MESSAGE', 'CONTEXT_ONLY');

-- AlterTable: Add copilot_mode to copilot_configs
ALTER TABLE "copilot_configs" ADD COLUMN "copilot_mode" "CopilotMode" NOT NULL DEFAULT 'READY_MESSAGE';

-- AlterTable: Add department_id to conversations
ALTER TABLE "conversations" ADD COLUMN "department_id" TEXT;

-- CreateTable: departments
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "queue_mode" "DepartmentQueueMode" NOT NULL DEFAULT 'CLAIM',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable: department_members
CREATE TABLE "department_members" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "department_role" "DepartmentRole" NOT NULL DEFAULT 'AGENT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "department_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable: department_copilot_configs
CREATE TABLE "department_copilot_configs" (
    "id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "copilot_mode" "CopilotMode" NOT NULL DEFAULT 'READY_MESSAGE',
    "system_prompt" TEXT NOT NULL DEFAULT '',
    "rules" JSONB NOT NULL DEFAULT '[]',
    "tools" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT NOT NULL DEFAULT 'gpt-4o-mini',
    "provider" TEXT NOT NULL DEFAULT 'openai',
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "max_tokens" INTEGER NOT NULL DEFAULT 1024,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "department_copilot_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "departments_tenant_id_idx" ON "departments"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenant_id_name_key" ON "departments"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "department_members_user_id_key" ON "department_members"("user_id");

-- CreateIndex
CREATE INDEX "department_members_department_id_idx" ON "department_members"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "department_members_user_id_department_id_key" ON "department_members"("user_id", "department_id");

-- CreateIndex
CREATE UNIQUE INDEX "department_copilot_configs_department_id_key" ON "department_copilot_configs"("department_id");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_department_id_idx" ON "conversations"("tenant_id", "department_id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_copilot_configs" ADD CONSTRAINT "department_copilot_configs_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
