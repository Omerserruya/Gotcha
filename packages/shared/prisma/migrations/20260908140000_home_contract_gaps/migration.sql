-- Home's remaining contract gaps. Additive only.

-- ─── Test conversations, kept out of analytics (3.6) ─────────
--
-- Defaults false, so every existing conversation keeps counting exactly as it
-- did. Only conversations explicitly marked during setup are excluded.
ALTER TABLE "conversations" ADD COLUMN "is_test" BOOLEAN NOT NULL DEFAULT false;

-- Every analytics aggregate filters on this, and the queue reads it on every
-- request, so it is worth an index rather than a sequential scan per card.
CREATE INDEX "conversations_tenant_id_is_test_idx" ON "conversations"("tenant_id", "is_test");
