-- AlterTable
ALTER TABLE "users" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'member';

-- CreateTable
CREATE TABLE "support_sessions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "admin_identity_id" TEXT NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "user_session_id" TEXT NOT NULL,
    "support_user_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "ended_reason" TEXT,

    CONSTRAINT "support_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_sessions_user_session_id_idx" ON "support_sessions"("user_session_id");

-- CreateIndex
CREATE INDEX "support_sessions_tenant_id_started_at_idx" ON "support_sessions"("tenant_id", "started_at");

-- AddForeignKey
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

