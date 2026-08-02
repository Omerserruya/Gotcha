-- CreateTable
CREATE TABLE "billing_webhook_events" (
    "id" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL DEFAULT 'ICOUNT',
    "provider_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "tenant_id" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "billing_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_webhook_events_provider_event_id_key" ON "billing_webhook_events"("provider_event_id");

-- CreateIndex
CREATE INDEX "billing_webhook_events_provider_event_type_idx" ON "billing_webhook_events"("provider", "event_type");

-- CreateIndex
CREATE INDEX "billing_webhook_events_tenant_id_idx" ON "billing_webhook_events"("tenant_id");

-- CreateIndex
CREATE INDEX "billing_webhook_events_received_at_idx" ON "billing_webhook_events"("received_at");
