-- WhatsApp manager approvals: explicit recipients + honest delivery state.
--
-- Recipients are OPT-IN and EXPLICIT. There is deliberately no "fall back to
-- the tenant owner or first admin" path: silently routing a refund approval to
-- whoever happens to be an admin is how the wrong person authorises money
-- movement. Absent a configured, enabled, authorised recipient with a valid
-- number, the approval stays in the in-app inbox and records WHY it was not
-- sent, so the UI can show an actionable setup state instead of nothing.

CREATE TABLE "approval_recipients" (
  "id"             TEXT NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "user_id"        TEXT NOT NULL,
  "channel"        TEXT NOT NULL DEFAULT 'whatsapp',
  "phone_e164"     TEXT NOT NULL,
  "enabled"        BOOLEAN NOT NULL DEFAULT false,
  -- Cap what may be decided from a phone; HIGH-risk actions can be forced to
  -- the web UI ("Open in GOTCHA") instead of one-tap approval.
  "max_risk_level" TEXT NOT NULL DEFAULT 'medium',
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "approval_recipients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "approval_recipients_tenant_id_user_id_channel_key"
  ON "approval_recipients" ("tenant_id", "user_id", "channel");
CREATE INDEX "approval_recipients_tenant_id_enabled_idx"
  ON "approval_recipients" ("tenant_id", "enabled");

ALTER TABLE "approval_recipients"
  ADD CONSTRAINT "approval_recipients_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "approval_recipients_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Out-of-band notification state, so "we never sent it" is visible rather than
-- indistinguishable from "sent and ignored".
ALTER TABLE "approval_requests"
  ADD COLUMN "manager_notify_state"  TEXT,
  ADD COLUMN "manager_notify_reason" TEXT,
  ADD COLUMN "manager_notified_at"   TIMESTAMP(3);
