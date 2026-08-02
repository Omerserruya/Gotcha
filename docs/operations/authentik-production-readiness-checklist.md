# Authentik Migration - Production Readiness Checklist

> **Date:** 2026-07-17 · Companion to `docs/security/authentik-architecture.md`.
> Legend: **[x]** done & verified in-repo · **[~]** partial / needs a decision · **[ ]** action required before go-live (mostly infra/console, not code).
>
> **Gate:** do not flip the app's DNS to production until every **[ ]** in sections 1–8 is checked. The code is ready; the environment is not yet stood up.

---

## 1. Infrastructure (compose / images)

- [x] Authentik stack (`authentik-db`, `authentik-server`, `authentik-worker`) in `docker-compose.prod.yml` - own DB, redis DB 1, healthchecks, no host port, `:?required` secrets.
- [x] OIDC vars wired into all 8 authenticating services via the `x-oidc-env` anchor; `JWT_SECRET`/`JWT_EXPIRES_IN`/`REFRESH_TOKEN_DAYS` removed (nothing reads them).
- [x] **Billing** service added to prod (`docker-compose.prod.yml`), nginx route, and the publish build map (`scripts/docker-publish.sh`) - previously absent; frontend + ai + auth depend on it.
- [x] Prod compose parses; both nginx templates pass `nginx -t` with zero unsubstituted vars.
- [ ] Build + push every image incl. `billing` and `gateway`: `./scripts/docker-publish.sh` with `REGISTRY`/`TAG` set.
- [ ] Run the one-shot schema migration: `docker compose -f docker-compose.prod.yml --profile migrate run --rm migrate` (billing shares `whatsapp_cc`, so no separate migration).
- [ ] Confirm the EC2 box has swap + disk headroom for one more Postgres (Authentik) + billing container.

## 2. DNS + Cloudflare Tunnel

- [ ] DNS records for `auth.gotcha.co.il` (prod) and `auth-dev.gotcha.co.il` (dev).
- [ ] Cloudflare Tunnel ingress route: `auth.gotcha.co.il` → the gateway container (the gateway vhost then proxies to `authentik-server:9000`). The AWS SG has **no inbound 80/443**, so the tunnel is the only path in - the vhost is inert until this exists (`gateway/nginx.prod.conf.template` `server_name auth.gotcha.co.il`).
- [ ] Verify Cloudflare sends `X-Forwarded-Proto: https`. **This is load-bearing** - without it Authentik signs `http://` issuers and every token 401s. The `$public_proto` map + `AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS` depend on it.
- [ ] TLS/HSTS/min-version confirmed at Cloudflare (terminates there; not in-repo).

## 3. Authentik configuration (console / bootstrap)

- [ ] Run `node scripts/authentik/bootstrap.mjs` against prod to create the OIDC provider/application, recovery flow, and branding.
- [ ] Run `node scripts/authentik/link-existing-users.mjs` to bind pre-existing GOTCHA users to Authentik subjects (`sub_mode=user_uuid`).
- [ ] Confirm OIDC discovery serves the **https** issuer through the tunnel: `GET https://auth.gotcha.co.il/application/o/gotcha/.well-known/openid-configuration` → `issuer` is `https://…`.
- [~] **Known product decision - one identity = one account.** `authentikSubject` is globally unique but `User` is unique per `(tenantId, email)`; a person in two tenants can only link one. Decide: accept as policy, or make subject non-unique + add tenant selection at login (`docs/security/authentik-architecture.md` §3).

## 4. Secrets (fail-closed at boot)

- [ ] Generate and set in the prod secret store (SSM), each `openssl rand -hex 32`: `AUTHENTIK_SECRET_KEY`, `AUTHENTIK_PG_PASS`, `AUTHENTIK_API_TOKEN` (a dedicated **non-bootstrap** token), `OAUTH_STATE_SECRET`.
- [ ] `INTERNAL_SERVICE_KEY` set to a **≥32-char** random value. The new `verifyInternalServiceKey` helper (`packages/shared/src/lib/internal-key.ts`) **rejects** the historically committed 24-char default and any `<32`-char secret in production - a weak key now fails closed instead of being accepted.
- [ ] **`AUTHENTIK_SECRET_KEY` is stored WITH the backups** (see DR-1). It decrypts the signing keypair; without it a DB restore cannot authenticate anyone.
- [x] Prod compose fails to boot if any of the above is unset (`:?required`) - a missing auth secret stops the deploy rather than weakening it.
- [ ] Confirm no `.env.prod` value equals its `.env.example` placeholder (the older security audit found `POSTGRES_PASSWORD=postgres` etc.).

## 5. Redirect URIs

- [ ] Register the prod callback in Authentik's provider allow-list (`bootstrap.mjs` takes `AUTHENTIK_REDIRECT_URIS`): `https://app.gotcha.co.il/auth/callback`. This is the open-redirect gate - an unregistered URI is rejected at login.
- [ ] Bake the matching browser values into the gateway image at build time (they are frozen, not runtime): `NEXT_PUBLIC_OIDC_ISSUER`, `NEXT_PUBLIC_OIDC_REDIRECT_URI`, `NEXT_PUBLIC_OIDC_CLIENT_ID=gotcha-app`. `scripts/docker-publish.sh` now **fails the build** if issuer/redirect are missing.
- [ ] Registered URI, baked `NEXT_PUBLIC_OIDC_REDIRECT_URI`, and the actual app origin must be byte-identical.

## 6. SMTP (Authentik sends its own mail)

- [ ] Set `SMTP_HOST/PORT/USER/PASS/FROM` on the Authentik container - it sends recovery + verification mail directly (GOTCHA never does). Compose maps these to `AUTHENTIK_EMAIL__*`.
- [ ] Send a real recovery mail end-to-end and confirm delivery + link works.

## 7. Branding

- [ ] Point `AUTHENTIK_BRANDING_LOGO` / `AUTHENTIK_BRANDING_FAVICON` at real GOTCHA assets; apply email templates. Users land on this page at login, so it should not read as a stock Authentik install.

## 8. Auth flows - verify each on prod before launch

- [ ] **First login** (bootstrap admin): PKCE S256 login succeeds; token verifies via JWKS. (Drill-proven in dev + against a restored instance.)
- [ ] **Invitation flow**: owner invites → Authentik identity created **first**, then the local `User` row (`services/auth/src/services/invitation.service.ts:41,55`); invitee sets their own password via the recovery link; logs in; lands in the correct tenant with the role from the server-side `TenantInvite` row (never client input, `onboarding.ts:2900-2905`).
- [ ] **Logout**: clears local tokens **and** redirects to Authentik `end_session_endpoint` so the IdP session ends (`frontend/src/context/AuthContext.tsx:168`, `oidc.ts:191-198`) - the next login is not silently re-authenticated.
- [ ] **Channel connect** (Messenger/IG/WhatsApp/Gmail/Outlook/Slack): `GET /api/channels/oauth/init` now verifies the Authentik token via `resolvePrincipal` (fixed this pass - it previously HS256-verified an RS256 token and 401'd every user). Re-test at least one provider on prod.
- [~] **MFA**: TOTP/WebAuthn/recovery-codes are enabled and enrollable, but enforcement is optional (`not_configured_action=skip`). Decide whether to enforce, and note Authentik enforces **per-flow, not per-tenant** - per-tenant enforcement needs a policy-binding design.
- [~] **Passkeys (WebAuthn)**: available via the same MFA stage. Confirm the WebAuthn RP ID matches the prod domain (`auth.gotcha.co.il`) or registration fails; decide if passkeys are offered at launch.

## 9. Rollback plan

- [ ] **Decision:** the migration deleted GOTCHA's custom auth, so rollback is **not** "unset a flag." Rolling back to pre-Authentik means redeploying the prior image tag AND restoring a pre-migration GOTCHA DB snapshot (the schema dropped password/refresh columns). Keep the last pre-migration image tag and DB snapshot pinned until Authentik is proven in prod.
- [ ] **Forward-fix (preferred):** most failure modes are config, not code - issuer/proto mismatch, unregistered redirect URI, missing secret. Keep the `docs/security/authentik-architecture.md` "before debugging a 401" section handy; these are minutes-to-fix and do not need a rollback.
- [ ] Authentik health is independent of the app: if `authentik-server` is down nobody can log in or refresh. Confirm its healthcheck + `restart: unless-stopped` and alerting cover it.

## 10. Residual security items (tracked, not launch-blocking)

- [x] **Auth flow reviewed end-to-end** - verification, principal resolution, HTTP + socket gates, login, invitation, logout, closed registration all fail closed. **No way to obtain a user session without Authentik** (no local signing key, no public signup, no fail-open, no socket bypass).
- [x] **Fixed this pass:** internal-key receivers in `billing` + 4 voice-copilot call-control routes now use the hardened constant-time, fail-closed helper (was: plain `!==` against a committed default, internet-reachable).
- [~] **Remaining internal-key cleanup (tracked as C-2 in `docs/security/security-compliance-master-plan.md`):** ~18 caller/HMAC sites still carry the `|| "chatcenter-internal-2026"` fallback (incl. `voice-callback.ts`, ai/auth/conversation callers). Callers merely *send* the key (not the exploitable receiver path), and prod sets `INTERNAL_SERVICE_KEY` `:?required` so the default never activates - but remove them for hygiene.
- [~] **Tokens in `localStorage`** (`AuthContext.tsx:52`) - standard public-client SPA tradeoff, XSS-exposed, documented; the durable fix is a backend-for-frontend with an HttpOnly cookie.
- [~] **Notifications WS token in URL query** (`services/notifications/src/ws-server.ts:46`) - can leak via logs; move to a header or short-lived ticket, or ensure `access_log off` on `/ws`.
- [~] **`OIDC_AUDIENCE` optional** (`jwt.ts:94`) - enforced only when set; consider making it required for defense-in-depth.
