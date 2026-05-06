-- Calendar accounts (Task 3)
CREATE TYPE "CalendarProvider" AS ENUM ('GOOGLE_CALENDAR', 'CALENDLY');
CREATE TYPE "CalendarAccountStatus" AS ENUM ('CONNECTED', 'BROKEN', 'DISCONNECTED');

CREATE TABLE "calendar_accounts" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "ai_agent_id" TEXT NOT NULL,
  "provider" "CalendarProvider" NOT NULL,
  "credentials" TEXT NOT NULL,
  "external_account_id" TEXT NOT NULL,
  "default_calendar_id" TEXT,
  "account_email" TEXT,
  "token_expires_at" TIMESTAMP(3),
  "status" "CalendarAccountStatus" NOT NULL DEFAULT 'CONNECTED',
  "last_error" TEXT,
  "last_synced_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "calendar_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "calendar_accounts_ai_agent_id_provider_key" ON "calendar_accounts"("ai_agent_id", "provider");
CREATE INDEX "calendar_accounts_tenant_id_idx" ON "calendar_accounts"("tenant_id");
CREATE INDEX "calendar_accounts_tenant_id_status_idx" ON "calendar_accounts"("tenant_id", "status");

-- Meeting types (Task 3 — scheduling policy per kind)
CREATE TABLE "meeting_types" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "duration_minutes" INTEGER NOT NULL,
  "agent_timezone" TEXT NOT NULL,
  "working_hours" JSONB NOT NULL,
  "meeting_type_windows" JSONB,
  "buffer_before_minutes" INTEGER NOT NULL DEFAULT 15,
  "buffer_after_minutes" INTEGER NOT NULL DEFAULT 15,
  "min_notice_hours" INTEGER NOT NULL DEFAULT 4,
  "max_horizon_days" INTEGER NOT NULL DEFAULT 30,
  "slot_resolution_minutes" INTEGER NOT NULL DEFAULT 30,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "meeting_types_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "meeting_types_tenant_id_slug_key" ON "meeting_types"("tenant_id", "slug");
CREATE INDEX "meeting_types_tenant_id_is_active_idx" ON "meeting_types"("tenant_id", "is_active");

-- Tenant funnels (Task 2 — configurable funnel + playbooks)
CREATE TABLE "tenant_funnels" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "funnel_id" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "stages" JSONB NOT NULL,
  "transitions" JSONB NOT NULL DEFAULT '[]',
  "strategy_overrides" JSONB,
  "playbook_overrides" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tenant_funnels_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenant_funnels_tenant_id_mode_funnel_id_key" ON "tenant_funnels"("tenant_id", "mode", "funnel_id");
CREATE INDEX "tenant_funnels_tenant_id_mode_is_active_idx" ON "tenant_funnels"("tenant_id", "mode", "is_active");
