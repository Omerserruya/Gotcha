-- Home's remaining backend gaps: handover history, per-user notification
-- preferences, insight dismissals, and the two quiet-day sources.
--
-- Purely ADDITIVE. No column is dropped and no existing value is rewritten
-- except the notification backfill at the end, which only FILLS columns that
-- did not exist a moment ago. `link` is left exactly as it is, so any client
-- still reading it keeps working.

-- ─── Typed notification target (3.3) ─────────────────────────
ALTER TABLE "in_app_notifications" ADD COLUMN "target_type" TEXT;
ALTER TABLE "in_app_notifications" ADD COLUMN "target_id" TEXT;

-- ─── Conversation handover history (2.7) ─────────────────────
CREATE TABLE "conversation_handovers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "from_handler" TEXT,
    "to_handler" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "reason" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_handovers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "conversation_handovers_tenant_id_at_idx" ON "conversation_handovers"("tenant_id", "at");
CREATE INDEX "conversation_handovers_conversation_id_at_idx" ON "conversation_handovers"("conversation_id", "at");
ALTER TABLE "conversation_handovers" ADD CONSTRAINT "conversation_handovers_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Per-user notification preferences (3.4) ─────────────────
CREATE TABLE "user_notification_preferences" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT true,
    "whatsapp" BOOLEAN NOT NULL DEFAULT false,
    "approvals" BOOLEAN NOT NULL DEFAULT true,
    "quiet_hours_from" TEXT,
    "quiet_hours_to" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_notification_preferences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_notification_preferences_user_id_key" ON "user_notification_preferences"("user_id");
CREATE INDEX "user_notification_preferences_tenant_id_idx" ON "user_notification_preferences"("tenant_id");
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Dismissed insights (3.2) ────────────────────────────────
CREATE TABLE "insight_dismissals" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "insight_id" TEXT NOT NULL,
    "dismissed_by" TEXT,
    "dismissed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_dismissals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "insight_dismissals_tenant_id_insight_id_key" ON "insight_dismissals"("tenant_id", "insight_id");
CREATE INDEX "insight_dismissals_tenant_id_idx" ON "insight_dismissals"("tenant_id");
ALTER TABLE "insight_dismissals" ADD CONSTRAINT "insight_dismissals_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Questions we could not answer (2.8) ─────────────────────
CREATE TABLE "unanswered_questions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "cluster_key" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ask_count" INTEGER NOT NULL DEFAULT 1,
    "asked_by" INTEGER NOT NULL DEFAULT 1,
    "first_asked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_asked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "unanswered_questions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unanswered_questions_tenant_id_cluster_key_key" ON "unanswered_questions"("tenant_id", "cluster_key");
CREATE INDEX "unanswered_questions_tenant_id_last_asked_at_idx" ON "unanswered_questions"("tenant_id", "last_asked_at");
CREATE INDEX "unanswered_questions_tenant_id_resolved_at_idx" ON "unanswered_questions"("tenant_id", "resolved_at");
ALTER TABLE "unanswered_questions" ADD CONSTRAINT "unanswered_questions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Demand for things not stocked (2.10) ────────────────────
CREATE TABLE "product_demand_terms" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "week_key" TEXT NOT NULL,
    "ask_count" INTEGER NOT NULL DEFAULT 1,
    "asked_by" INTEGER NOT NULL DEFAULT 1,
    "in_catalogue" BOOLEAN NOT NULL DEFAULT false,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_demand_terms_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_demand_terms_tenant_id_term_week_key_key" ON "product_demand_terms"("tenant_id", "term", "week_key");
CREATE INDEX "product_demand_terms_tenant_id_week_key_idx" ON "product_demand_terms"("tenant_id", "week_key");
ALTER TABLE "product_demand_terms" ADD CONSTRAINT "product_demand_terms_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Backfill: type the notifications already in the bell ────
--
-- Without this the frontend branches on eventType and every historical row
-- falls through to the default, so the bell renders a wall of untyped entries
-- for exactly as long as they take to age out.
--
-- Only rows we can classify HONESTLY are given a code. `event_type` is left
-- untouched where the producing event has no counterpart in the six the
-- interface knows - inventing one would be worse than an untyped row, because
-- an untyped row is visibly unclassified and a wrong one is not.
UPDATE "in_app_notifications"
   SET "target_type" = 'conversation',
       "target_id"   = substring("link" from '/conversations?/([A-Za-z0-9_-]+)')
 WHERE "link" ~ '/conversations?/[A-Za-z0-9_-]+';

UPDATE "in_app_notifications"
   SET "target_type" = 'approval',
       "target_id"   = substring("link" from '/approvals?/([A-Za-z0-9_-]+)')
 WHERE "link" ~ '/approvals?/[A-Za-z0-9_-]+';

UPDATE "in_app_notifications"
   SET "target_type" = 'campaign',
       "target_id"   = substring("link" from '/(?:broadcasts|campaigns)/([A-Za-z0-9_-]+)')
 WHERE "link" ~ '/(broadcasts|campaigns)/[A-Za-z0-9_-]+';

-- A row whose link points nowhere resolvable is explicitly "none", which the
-- interface renders as a notification with no affordance. That is a decision,
-- and it should look like one rather than like a NULL nobody got to.
UPDATE "in_app_notifications"
   SET "target_type" = 'none'
 WHERE "target_type" IS NULL;

-- The approval event is the one existing type that maps cleanly onto the six.
UPDATE "in_app_notifications"
   SET "event_type" = 'APPROVAL_REQUIRED'
 WHERE "event_type" IN ('tool.approval_required', 'approval_required');

UPDATE "in_app_notifications"
   SET "event_type" = 'ACTION_FAILED'
 WHERE "event_type" IN ('payment.failed', 'system.error.critical', 'credit.auto_purchase_failed');
