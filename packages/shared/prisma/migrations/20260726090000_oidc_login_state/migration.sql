-- OIDC login handshake state for the server-side Auth-Code + PKCE flow
-- (BFF migration §A5). Additive, inert until SESSION_COOKIE_CREATE.
CREATE TABLE "oidc_login_states" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "code_verifier" TEXT NOT NULL,
    "return_to" TEXT NOT NULL DEFAULT '/',
    "remember_me" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "oidc_login_states_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "oidc_login_states_state_key" ON "oidc_login_states"("state");
CREATE INDEX "oidc_login_states_expires_at_idx" ON "oidc_login_states"("expires_at");
