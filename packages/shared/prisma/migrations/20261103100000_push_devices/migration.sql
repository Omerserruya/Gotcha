-- ─── Master switch for mobile push ───────────────────────────
ALTER TABLE "user_notification_preferences" ADD COLUMN "push" BOOLEAN NOT NULL DEFAULT true;

-- ─── Push devices (FCM registration tokens) ──────────────────
CREATE TABLE "push_devices" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "push_devices_token_key" ON "push_devices"("token");
CREATE INDEX "push_devices_tenant_id_user_id_idx" ON "push_devices"("tenant_id", "user_id");
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
