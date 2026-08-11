-- Setup links: GOTCHA-owned invitation tokens, redeemed for an Authentik
-- recovery link at click time.
--
-- Additive only. One new table, no ALTER/DROP against anything existing; the
-- only touch to `users` is an inbound foreign key declared on the NEW table.

CREATE TABLE "setup_links" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "setup_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "setup_links_token_hash_key" ON "setup_links"("token_hash");

CREATE INDEX "setup_links_user_id_idx" ON "setup_links"("user_id");

CREATE INDEX "setup_links_expires_at_idx" ON "setup_links"("expires_at");

ALTER TABLE "setup_links" ADD CONSTRAINT "setup_links_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
