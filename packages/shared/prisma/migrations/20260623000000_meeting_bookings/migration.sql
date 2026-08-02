-- Meeting bookings: source of truth for booked calendar events, keyed by
-- customer so reschedule/cancel resolve the exact event and the bot never
-- creates duplicates on a "move it" intent.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "BookingStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'COMPLETED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "meeting_bookings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "ai_agent_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "customer_external_id" TEXT,
    "customer_email" TEXT,
    "provider" "CalendarProvider" NOT NULL,
    "calendar_account_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "meeting_type_slug" TEXT,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "customer_timezone" TEXT,
    "join_url" TEXT,
    "status" "BookingStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "meeting_bookings_provider_event_id_key" ON "meeting_bookings"("provider", "event_id");
CREATE INDEX IF NOT EXISTS "meeting_bookings_tenant_id_customer_external_id_status_idx" ON "meeting_bookings"("tenant_id", "customer_external_id", "status");
CREATE INDEX IF NOT EXISTS "meeting_bookings_tenant_id_conversation_id_status_idx" ON "meeting_bookings"("tenant_id", "conversation_id", "status");
CREATE INDEX IF NOT EXISTS "meeting_bookings_tenant_id_ai_agent_id_status_idx" ON "meeting_bookings"("tenant_id", "ai_agent_id", "status");
