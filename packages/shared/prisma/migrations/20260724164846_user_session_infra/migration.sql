-- BFF app-session infrastructure (additive, inert until cookie flags enabled).
-- See docs/security/bff-session-migration-map.md §A18 commit 1.

-- Global session generation per Identity (drives "global reauthentication").
ALTER TABLE "identities" ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;

-- Server-side application session. The browser holds only an opaque identifier;
-- only its SHA-256 hash is stored here. OIDC tokens are stored encrypted.
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "identity_id" TEXT NOT NULL,
    "session_version" INTEGER NOT NULL DEFAULT 0,
    "active_membership_id" TEXT,
    "session_token_hash" TEXT NOT NULL,
    "encrypted_access_token" TEXT NOT NULL,
    "encrypted_refresh_token" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "oidc_session_id" TEXT,
    "csrf_secret" TEXT NOT NULL,
    "remember_me" BOOLEAN NOT NULL DEFAULT false,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revocation_reason" TEXT,
    "browser" TEXT,
    "device" TEXT,
    "operating_system" TEXT,
    "user_agent_hash" TEXT,
    "ip_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- Cookie -> hash -> record lookup key.
CREATE UNIQUE INDEX "user_sessions_session_token_hash_key" ON "user_sessions"("session_token_hash");
CREATE INDEX "user_sessions_identity_id_idx" ON "user_sessions"("identity_id");
CREATE INDEX "user_sessions_identity_id_session_version_idx" ON "user_sessions"("identity_id", "session_version");
CREATE INDEX "user_sessions_active_membership_id_idx" ON "user_sessions"("active_membership_id");
CREATE INDEX "user_sessions_expires_at_idx" ON "user_sessions"("expires_at");
CREATE INDEX "user_sessions_revoked_at_idx" ON "user_sessions"("revoked_at");

-- Identity owns the session (cascade on identity delete). Active membership is a
-- soft link (SetNull on membership delete) so a revoked membership forces
-- re-selection rather than leaving a dangling tenant reference.
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_identity_id_fkey"
    FOREIGN KEY ("identity_id") REFERENCES "identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_active_membership_id_fkey"
    FOREIGN KEY ("active_membership_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
