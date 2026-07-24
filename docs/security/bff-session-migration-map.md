# BFF Session Migration — Phase 1: Current-State Map

Status: **Phase 1 (map only, no code changed).** Precondition for Phases 2–5.
Awaiting map review before any Phase 2 code is written.

**Decision (2026-07-24):** topology bridge = **Option A** (§7) — nginx
`auth_request` → a `services/auth` session resolver that decrypts + refreshes the
OIDC token (single refresh owner, with a lock) and injects `Authorization:
Bearer` upstream. Downstream services stay unchanged; the cookie never reaches
services and the token never reaches the browser.
Goal: move browser auth from localStorage-held OIDC tokens to an opaque HttpOnly
GOTCHA session cookie backed by server-side, encrypted OIDC tokens. Authentik
stays the IdP; GOTCHA owns the application session and all authorization.

Companion: `docs/security/authentik-architecture.md` (the current model, which
explicitly names this BFF migration as the "durable fix, out of scope" for the
Authentik migration — §6 "Accepted tradeoffs").

---

## 0. The one thing the spec's model doesn't match: topology

The spec assumes a single BFF that all browser traffic passes through. Reality:

**`nginx` (gateway) fans `/api/<domain>` out to ~6 services directly**, and each
service verifies the Bearer **independently** via the shared `authenticate()`
gate. There is no single application backend today.

```
browser ──Bearer──▶ nginx ──/api/auth─────▶ auth_service        ┐
                         ──/api/billing──▶ billing_service     │ each runs
                         ──/api/conversations─▶ conversation   │ authenticate()
                         ──/api/... ───────▶ (analytics, ai,   │ from
                         ──/ws ────────────▶  notifications)   ┘ @chatcenter/shared
```

Every browser→service auth path therefore has to be bridged from
"cookie" back to "the Bearer the service already understands". The chosen
bridge is the central design decision for Phase 2/5 — see §7.

---

## 1. Browser-held secrets today (what must stop being JS-readable)

| Secret | Where held | Written by | Read by |
|---|---|---|---|
| OIDC **access token** | `localStorage["token"]` | `AuthContext.storeTokens` (`context/AuthContext.tsx:82`) | every `Bearer` call, `getMe`, sockets |
| OIDC **refresh token** | `localStorage["refreshToken"]` | same | `AuthContext.scheduleRefresh:159`, startup `:215` |
| access-token **expiry** | `localStorage["tokenExpiresAt"]` | same | refresh scheduling |
| PKCE **verifier** + **state** | `sessionStorage["oidc:verifier"/"oidc:state"]` | `oidc.beginLogin:94` | `oidc.completeLogin:132` |
| **active tenant** | `localStorage["activeTenantId"]` | `active-tenant.setActiveTenantId` | fetch interceptor, socket auth |

All five become server-side after migration. The access/refresh tokens move to
an **encrypted** server session record; the PKCE material moves to a server-side
login-state record; the active tenant moves to `session.activeMembershipId`.

---

## 2. Browser: token lifecycle (the code to replace)

- **`frontend/src/lib/oidc.ts`** — browser OIDC client (PUBLIC client + PKCE).
  Moves server-side wholesale:
  - `beginLogin()` `:89` — builds authorize URL, stores verifier/state in
    sessionStorage, redirects to Authentik.
  - `completeLogin()` `:122` — **browser-side code→token exchange** at
    `token_endpoint`. → becomes a backend callback.
  - `refreshTokens()` `:164` — **browser-side refresh**. → becomes server-owned.
  - `logoutUrl()` `:194`, `discover()` `:31`, `accountSettingsUrl`,
    `authentikFlowUrl`/`flowDoneUrl` (embedded MFA/passkey flows — stay browser,
    they use the Authentik *session cookie*, not our token).
- **`frontend/src/context/AuthContext.tsx`** — the token store + refresh timer +
  session bootstrap. Rewrite around cookie session:
  - `storeTokens/clearTokens` `:82/:88` (localStorage) → removed.
  - `adoptSession()` `:175`, startup effect `:197`, `scheduleRefresh()` `:150`,
    `hardLogout()` `:138`, `login()` `:232`, `logout()` `:236`.
  - Still owns: `user`, `memberships`, `tenantName`, `needsTenantSelection`,
    `switchTenant()` — but hydrated from `/api/auth/me` over the cookie, not a token.
- **`frontend/src/app/auth/callback/page.tsx`** — browser exchange +
  `adoptSession` + stale-flow auto-restart (`:36–:62`). → becomes a thin spinner;
  the exchange + stale-retry logic moves into the backend callback.
- **`frontend/src/app/auth/flow-done/page.tsx`** — embedded-flow postMessage
  bridge (MFA/passkey). Stays; unrelated to our token.

## 3. Browser: `Authorization: Bearer` construction sites (→ `credentials:"include"`)

All read `token` from `useAuth()`/localStorage. Centralize, then delete the header:

- `lib/api.ts` (`:23`, `:169`, `:793`, `:1287`, `:1402`, …), `lib/gotcha-api.ts`
  (`:21`, `:146`, `:366`), `lib/api-copilot.ts`, `api-scheduler.ts`,
  `api-funnel.ts`, `api-commerce.ts`, `api-billing.ts`, `api-notifications.ts`,
  `api-crm.ts`, `api-decision-timeline.ts`, `api-action-contracts.ts`,
  `lib/analytics.ts`.
- Contexts: `context/I18nContext.tsx` (`:106/:166/:209`, also reads
  `localStorage["token"]` directly `:13`), `context/VoiceCallContext.tsx:337`.
- Pages: `app/outbound/scheduled/page.tsx:110`, `app/outbound/templates/page.tsx:25`,
  `app/outbound/call/page.tsx:276`, `app/settings/voice-copilot/components/*`
  (`LiveMonitoringPanel:60`, `SttConfigPanel:37/:68`).
- **Tenant header interceptor** `lib/active-tenant.ts` — patches `window.fetch`
  to stamp `X-Tenant-Id` + self-heal `tenant_denied`. Keep the interceptor shape
  but (a) add `credentials:"include"` and (b) treat active tenant as server-owned
  (switch via `/api/auth/switch-tenant`, which updates `session.activeMembershipId`).

## 4. Browser: authenticated sockets & downloads

- **Conversation WS** — `lib/socket.ts:8` `io(WS_URL,{auth:{token,tenantId}})`.
  → `io(WS_URL,{withCredentials:true})`; server reads the cookie.
- **Notifications WS** — opened with the token as a **URL query param** `?token=`
  (server side `services/notifications/src/ws-server.ts:49`). Find the browser
  opener; move to cookie on the upgrade request. **Token-in-URL must go.**
- **CSV/file download** — `app/system/leads/page.tsx:166` `fetch().blob()` — rides
  the fetch interceptor, so cookie covers it automatically.
- **Channel-connect redirect** — `app/.../channels` sends `?token=` to
  `services/auth/src/routes/channels.ts:576` (verified via `resolvePrincipal`,
  admin-only). → same-origin redirect already carries the cookie; drop `?token=`.
- `app/account/verify-email/page.tsx:31` `?token=` is a **change-email** token
  (GOTCHA-issued), NOT the OIDC token — out of scope, leave as-is.

## 5. Server: token consumers (what the cookie must resolve to)

- **`packages/shared/src/middleware/auth.ts` `authenticate()`** — the one HTTP
  gate used by every service. Verifies `Authorization: Bearer` via JWKS
  (`resolvePrincipal`), plus an internal-service secret path. Also reads
  `X-Tenant-Id` as a validated hint.
- **`resolvePrincipal()` direct callers** (sockets / query-param):
  - `services/notifications/src/ws-server.ts:49` (WS, `?token=`)
  - `services/conversation/src/lib/socket.ts:24` (socket.io handshake)
  - `services/voice-copilot/src/routes/twilio-token.ts:32` (Bearer)
  - `services/auth/src/routes/channels.ts:589` (query-param redirect)
- **`packages/shared/src/lib/jwt.ts` `verifyAccessToken()`** + **`lib/principal.ts`
  `resolvePrincipal()`** — unchanged; still verify Authentik tokens. The BFF
  feeds them a server-decrypted token instead of a browser-supplied one.

No Next.js `middleware.ts`, no service worker, no SSR auth — nothing to migrate there.

## 6. Reusable infrastructure already present

- **Encryption**: `packages/shared/src/lib/encryption.ts` —
  `encryptCredentials`/`decryptCredentials` (AES-256-GCM, `CHANNEL_ENCRYPTION_KEY`).
  Already used to store provider OAuth tokens at rest (`KnowledgeIntegration`,
  channel `encryptedSecrets`, integration creds). **Reusable for OIDC tokens** —
  recommend a *dedicated* `SESSION_ENCRYPTION_KEY` for key separation.
- **Config already stubbed** in `.env`: `SESSION_TTL_SECONDS`,
  `MAX_CONCURRENT_SESSIONS`. Need to add: remembered-session TTL, cookie name,
  refresh skew, `SESSION_ENCRYPTION_KEY`.
- **No existing user `Session` model** (only `VoiceCallSession`/`DiscoverySession`,
  unrelated). Phase 2 creates a new one.
- **No server-side cookie handling today** — greenfield; `cookie-parser` or manual
  parse in the auth service (dependency rule: prefer manual/`jose` already-present;
  avoid adding cookie-parser unless approved).

## 7. Where the BFF/session-resolver lives (decision for §0 topology)

Three options to bridge cookie→Bearer across the nginx fan-out:

- **A. nginx `auth_request` → auth-service resolver (recommended).** Each `/api/*`
  triggers a subrequest to a new `services/auth` internal endpoint that: reads the
  cookie, loads+validates the session, decrypts the access token, refreshes it if
  near expiry (single owner, with a lock), and returns it in a response header.
  nginx captures it (`auth_request_set`) and injects `Authorization: Bearer …`
  upstream. **Downstream services unchanged; refresh centralized; cookie never
  reaches services; token never reaches the browser.** Cost: +1 internal hop/req.
- **B. Cookie-aware shared `authenticate()`.** Every service reads the cookie,
  looks up the session, decrypts, resolves. Simple nginx, but every service can
  refresh → violates "single owner of refresh" and spreads the decryption key.
- **C. Full app-level proxy** in front of all services. Cleanest conceptually but
  effectively re-routes all 6 services through one process — large, risky, and
  brushes against "no new microservices".

Recommendation: **A**, with the auth service as the single refresh owner. WS
servers call the same resolver on upgrade (cookie in the upgrade request).
**Chosen: A** (see header). Phases 2–5 will be built on this.

## 8. Session model (Phase 2 target — belongs to Identity, not Tenant)

New model (names TBD), fields per spec:
`id, identityId(User/authentikSubject), encryptedAccessToken, encryptedRefreshToken,
tokenExpiresAt, oidcSessionId?, createdAt, lastActivityAt, expiresAt, rememberMe,
revokedAt, revocationReason, browser/device/os, userAgentHash, ipMeta?, csrfSecret,
sessionVersion, activeMembershipId`. Authorization path stays
`Session → Identity → active Membership → Tenant → Permissions`. Never trust
browser/JWT `tenantId`; `X-Tenant-Id` remains a hint validated against memberships
(or is replaced by `activeMembershipId` on the session).

## 9. Tests / scripts / tooling that assume a token

- `scripts/authentik/e2e-oidc-check.mjs` (drives real login → token; asserts the
  API accepts it), `bootstrap.mjs`, `link-existing-users.mjs`,
  `scripts/demo/run-demo.ts`, `scripts/simulate-audit.ts`.
- The CDP screenshot driver reads `localStorage.getItem("token")` — will need a
  cookie-session login path.
- Regression tests: `packages/shared/src/middleware/__tests__/auth.test.ts`
  (extend for the cookie path).

## 10. Non-negotiables carried into Phases 2–5

- Never return tokens to the browser (no URL fragment/query, no readable cookie).
- Never log tokens/codes/cookie values/CSRF/MFA/signing secrets.
- Cookie: `__Host-gotcha_session`, HttpOnly, Secure, Path=/, no Domain,
  SameSite=Lax, explicit Max-Age; short (non-remembered) vs long (remembered).
- A GOTCHA session must not outlive a revoked Authentik session indefinitely
  (refresh failure / `invalid_grant` ⇒ revoke).
- No roles/permissions in Authentik; authorization stays 100% local.
- No new microservice; no new dependency without approval (`jose` already allowed).

---
---

# Phase 1 Addendum — Security & Rollout Design (approved decisions folded in)

Status: **design only, no code.** Extends the map with the Phase 5+ requirements.
All topology claims below are **verified from the real configs**, not inferred
from frontend code. Approved: topology **A**, dedicated `SESSION_ENCRYPTION_KEY`,
no `cookie-parser`, `__Host-gotcha_session` (prod) after host verification (done, §A1).

## A1. Verified host & proxy topology

Evidence: `nginx/nginx.conf.template` (dev), `gateway/nginx.prod.conf.template`
(prod), `docker-compose.yml`, `docker-compose.prod.yml`,
`docs/security/authentik-architecture.md` §8.

| Concern | Dev | Prod |
|---|---|---|
| App SPA + `/api/*` + `/socket.io/` + `/ws` | **same origin** — one `server{ server_name _; listen 80 }` block: `location /`→`frontend`, `location /api/*`→services (`nginx.conf.template:76–1247`) | **same origin** — `server_name _`; SPA served static from `/usr/share/nginx/html`, `/api/*`→services (`nginx.prod.conf.template:91+`) |
| Public app host | `dev.gotcha.co.il` | the single configured public host (**verify** against `NEXT_PUBLIC_OIDC_REDIRECT_URI` / `AUTHENTIK_REDIRECT_URIS`; e.g. `app.gotcha.co.il`) |
| Authentik (IdP) | `auth-dev.gotcha.co.il` — **separate** `server` block → `authentik-server` | `auth.gotcha.co.il` — separate vhost (`authentik-architecture.md` §8.1) |
| Help | `help.gotcha.co.il` → frontend `/help` | same |
| TLS | terminates at Cloudflare; `$scheme`=http inside gateway; real scheme via `X-Forwarded-Proto`/`$public_proto` map | same |

**Conclusion:** SPA and `/api` share the **exact same host** in both dev and prod
→ `__Host-gotcha_session` is viable, `SameSite=Lax` suffices for the app,
and **same-origin removes CORS for app traffic** (see A7). The IdP is a *different*
host, but login is a top-level redirect (not a CORS/XHR flow), so that is fine.

### Cookie behavior by environment (approved: separate dev cookie, never weaken prod)

| Env | Scheme | Cookie name | Attributes |
|---|---|---|---|
| **production** | https (public) | `__Host-gotcha_session` | HttpOnly; Secure; SameSite=Lax; Path=/; **no Domain**; explicit Max-Age; opaque 256-bit id |
| **dev (dev.gotcha.co.il)** | https via Cloudflare | `__Host-gotcha_session` | same as prod (dev is HTTPS end-to-end at the edge) |
| **preview** | https | `__Host-gotcha_session` | same; per-preview host, no Domain |
| **localhost (plain HTTP)** | http | `gotcha_session_dev` (distinct name, **no** `__Host-`/`Secure`) | HttpOnly; SameSite=Lax; Path=/; **guarded** |

Guard (fail-closed): a startup assertion **rejects the dev cookie config when
`NODE_ENV=production`** — `__Host-` + `Secure` is mandatory in prod; the plain
`gotcha_session_dev` name is only accepted when `NODE_ENV!=='production'`. The
prod cookie is never downgraded to support local HTTP.

## A2. nginx trust boundary (exact contract)

Today nginx **passes client request headers through untouched** except it blanks
`X-Internal-Key ""` per location (`nginx.conf.template` — every `location`). That
blank-a-client-header pattern is the precedent we extend.

**On every authenticated `/api/*` location (and the `/t/:tenant/...` variants):**

1. **Strip/neutralize inbound client identity headers** before the auth
   subrequest and before proxying upstream — set each to empty so a client
   cannot supply them:
   `proxy_set_header Authorization "";` (until injected in step 3),
   `X-User-Id ""`, `X-Identity-Id ""`, `X-Tenant-Id ""`, `X-Membership-Id ""`,
   `X-Permissions ""`, and a catch for `X-Auth-*`. (Keep the existing
   `X-Internal-Key "";`.) Client-supplied Bearer can **never** reach a service.
2. **`auth_request /_session_resolve;`** — internal subrequest (see A4).
3. On 2xx, capture the resolver's outputs from response headers via
   `auth_request_set` and inject them as the **trusted** upstream headers:
   `auth_request_set $up_authz $sent_http_x_gotcha_authorization;`
   `proxy_set_header Authorization $up_authz;`
   (plus `X-Tenant-Id`/`X-Membership-Id`/correlation id similarly, all
   server-set). The internal service `authenticate()` still JWKS-verifies the
   injected Bearer — defense in depth.
4. **Public locations are NOT auth-gated** (no `auth_request`): `/api/public/*`,
   `/api/waitlist`, `/api/embedded-chat`, `/api/webhook`, `/webhooks`, all
   provider `/oauth/*/callback`, the login routes in A5, `/health`, and SPA
   static. These must still strip the identity headers in step 1.
5. `/t/:tenant/api/...` currently sets `X-Tenant-ID $1` from the URL path. Under
   the session model this becomes a **hint only**, still validated against
   memberships; the authoritative active tenant is `session.activeMembershipId`.

## A3. Do-not-leak-the-token guarantees

- The upstream token exists only in nginx internal vars (`$up_authz`) and the
  proxied upstream request. It is **never** added with `add_header` to the client
  response, never in a redirect `Location`, never in an error body.
- `proxy_hide_header` any `X-Gotcha-Authorization`/token-bearing header the
  resolver returns, so the subrequest's response headers cannot bleed to the
  browser.
- **Access logs:** define a `log_format` that logs `$request`/`$status` but
  **never** `$http_authorization`, `$sent_http_*` token vars, or `Cookie`. The
  resolver and every service must keep tokens/codes/cookie values/CSRF/MFA
  secrets out of logs, traces, analytics, and error bodies (already a
  non-negotiable, §10).

## A4. Session-resolver endpoint contract (`services/auth`, internal-only)

`GET /internal/session/resolve` — reachable **only** as an nginx `auth_request`
subrequest (not routed publicly; enforced by not adding a public `location` and
by an internal-only guard).

- **Receives:** the `Cookie` header (session cookie only), original method
  (`X-Original-Method`), original URI (`X-Original-URI`), `Origin`,
  correlation id. **The original request body is NOT forwarded** (`proxy_pass_request_body off; proxy_set_header Content-Length "";`).
- **Does:** parse+validate the session cookie (A11 parser) → load session →
  check `revokedAt IS NULL`, not expired, `sessionVersion` current → resolve
  active membership → decrypt access token → refresh if within skew (A9, single
  lock) → slide `lastActivityAt`.
- **Returns, explicitly:**
  - `200` + response headers `X-Gotcha-Authorization: Bearer <token>`,
    `X-Tenant-Id`, `X-Membership-Id`, `X-Correlation-Id` (body empty).
  - `401` — no/invalid/expired/revoked session (browser must re-login).
  - `403` — authenticated session but membership/authorization failure
    (e.g. active membership revoked) — maps to the app's `tenant_denied`.
  - `5xx` — internal failure; nginx returns a generic 503 to the client and logs
    detail server-side **without** secrets. Never fail *open*.
- **CSRF pre-check** for unsafe methods happens here or in a sibling gate (A6).

## A5. Login / callback flow (server-side, Auth Code + PKCE)

Moves `lib/oidc.ts` + `auth/callback/page.tsx` logic into `services/auth`:

- `GET /api/auth/login` → create short-lived **login-state** record
  (`state`, `nonce`, PKCE `verifier`, `returnTo`, `createdAt`, single-use,
  ~10 min TTL), 302 to Authentik authorize (S256).
- `GET /api/auth/callback` (public location, **no** auth_request) → validate
  `state` (exists/unused/unexpired) → `iss`/`aud`/nonce → exchange code
  server-side (confidential exchange; the browser never sees tokens) → resolve
  Identity (`authentikSubject`) → load memberships → **create app session**
  (encrypted tokens) → set `__Host-gotcha_session` → 302 to the resolved
  destination (only tenant / picker / invitation onboarding / MFA continuation /
  verified `returnTo`). Preserve the current **stale-flow auto-restart**
  (password-reset replay) server-side. **Session fixation:** always mint a fresh
  session id on login; never adopt a pre-login id.
- `POST /api/auth/logout` (A10). No tokens in any URL/fragment/body ever.

## A6. CSRF design (cookie auth ⇒ layered, not SameSite alone)

- **Transport:** double-submit bound to the session. On session create, derive
  `csrfSecret` (stored in the session row, never sent) and issue a **non-secret**
  CSRF token = `HMAC(csrfSecret, sessionId)` (rotated on privilege change /
  tenant switch / refresh-rotation). Delivered via a **readable** `XSRF-TOKEN`
  cookie (not HttpOnly, no secret in it) and/or `/api/auth/csrf`.
- **Enforce on unsafe methods (POST/PUT/PATCH/DELETE):** require ALL of —
  (1) `SameSite=Lax` session cookie, (2) **exact `Origin` allow-list** match
  (A7), (3) header `X-CSRF-Token` that validates against `csrfSecret`.
  `Sec-Fetch-Site: same-origin` accepted as an additional positive signal.
- **Validation failure** → `403 csrf_failed`; the SPA fetches a fresh token and
  retries once. **File uploads** (`/api/uploads`, `/api/knowledge-bases`) use the
  same header token (multipart body unaffected). **Exceptions:** OAuth/OIDC and
  connector **callbacks** are top-level GET redirects carrying single-use
  `state`/PKCE/nonce with replay protection — they are exempt from the CSRF-token
  check but keep their own state defense (A12).

## A7. CORS / origin policy

Same-origin app traffic ⇒ **no CORS needed** for `/api/*` (verified A1). Policy:

- **Never** `Access-Control-Allow-Origin: *` **with** credentials. App endpoints
  set **no** ACAO (same-origin) — a credentialed cross-origin XHR is simply
  refused by the browser.
- The **exact Origin allow-list** (for the A6 check and any future credentialed
  need): prod app host + `dev.gotcha.co.il` + explicit preview hosts +
  `http://localhost:3000`. Enumerated, never wildcard, never reflected.
- `/api/embedded-chat` stays `ACAO: *` but is **public + credential-free** (no
  session cookie), so it is not a CSRF/creds risk.
- Authentik host is reached by top-level navigation only (no XHR) → no CORS.

## A8. Active membership & tenant switching

Authorization path stays **Session → Identity → active Membership → Tenant →
Permissions**. Active tenant becomes `session.activeMembershipId` (server-owned);
the browser's `localStorage["activeTenantId"]` and the `X-Tenant-Id` request
header are removed as *sources of truth* (header may remain a validated hint
during migration only).

- `POST /api/auth/me/switch-tenant` (exists, `services/auth/.../auth.ts:144`) →
  validate membership → **atomically** update `session.activeMembershipId` +
  `User.lastActiveAt` → rotate CSRF token → return new active context.
- After switch: invalidate any per-tenant caches, force a permissions refresh,
  and **reconnect WebSockets** (A9) so no socket keeps the old tenant. The SPA
  does a full reload (matches today's `switchTenant`), which rebuilds every
  provider against the new active membership.

## A9. WebSockets & SSE

Two authenticated sockets today: conversation `/socket.io/` (handshake
`auth.token`) and notifications `= /ws` (**token in `?token=` query — removed**).
SSE streams (`/api/agent`, `/api/ai-agents/builder`) ride normal `/api` auth.

**Chosen model: short-lived single-use WS ticket via the authenticated BFF**
(preferred over cookie-only because it gives explicit, revocation-checked
authorization at connect time and avoids relying on cookies over the upgrade):

- `POST /api/auth/ws-ticket` (cookie-authenticated, CSRF-checked) → returns a
  one-time, ~30s ticket bound to `{sessionId, identityId, activeMembershipId}`,
  stored server-side single-use. The browser opens the socket with the ticket
  (in the handshake auth payload / `Sec-WebSocket-Protocol`, **never** a query
  param). The WS server validates+consumes the ticket via the resolver and maps
  it to the principal. (Cookie-on-handshake + periodic revalidation is the
  documented fallback if tickets prove heavy.)
- **Continuous validity:** the current request-auth model does not revalidate an
  already-upgraded socket, so each socket runs a **server-side periodic
  session-revalidation** (e.g. every 60s: session not revoked, membership live,
  version current). On failure the server closes the socket with a reason.
- **Lifecycle behavior — on logout / logout-all / expiry / membership
  revocation / tenant switch / disabled identity:** open sockets are closed
  server-side at the next revalidation tick (and immediately on an explicit
  revocation broadcast). Tenant switch closes + the SPA reopens with a new
  ticket for the new active membership. No Authentik access token is ever in a
  socket URL or payload.

## A10. Logout, revocation & session management

- `POST /api/auth/logout` — revoke the current session (`revokedAt`,
  `revocationReason`), stop refresh, clear the cookie (`Max-Age=0`), then 302 to
  Authentik `end_session` so the IdP session ends too (preserve today's
  behavior). Frontend cache-clear alone is **not** logout.
- `POST /api/auth/logout-all` — revoke **all** sessions for the identity.
- `GET /api/auth/sessions` + a **Session-list UI** (device/browser/os, IP meta,
  lastActivityAt, current-session flag) → `DELETE /api/auth/sessions/:id`
  revokes another device.
- **Immediate rejection:** the resolver checks `revokedAt`/`sessionVersion` every
  request (A5 says **no auth_request caching**, §A cache), so a revoked session
  is rejected on its next call; sockets close at the next revalidation tick.
- **Multi-tab propagation without secrets:** a `BroadcastChannel`/`storage`
  event carrying only a *non-secret* "logged-out" signal makes other tabs drop
  to the login screen; they hold no tokens to clear.
- Bind to Authentik back-channel logout / token revocation where supported.

## A11. Cookie parse/serialize (no `cookie-parser`)

Express has no built-in cookie parser and we may not add `cookie-parser`. Provide
one **narrowly scoped, well-tested** helper in `packages/shared` (used by the
resolver + auth routes only):

- `parseSessionCookie(header): string | null` — reads only
  `__Host-gotcha_session` / `gotcha_session_dev`; **rejects** malformed,
  duplicate, or ambiguous cookie input (two session cookies ⇒ reject, not
  "pick first"); validates the opaque-id charset/length; no dependency on
  undeclared transitive packages.
- `serializeSessionCookie(id, opts)` — emits the exact attribute set from A1,
  with the prod/dev guard. Unit tests cover: absent, malformed, duplicate,
  oversized, wrong-charset, prod-guard-rejects-dev-config.

## A12. OAuth connector compatibility (keep separate from the login session)

Verified: connectors use `/oauth/<provider>/init` (ADMIN — signs a JWT `state`
with `OAUTH_STATE_SECRET` carrying `{tenantId, aiAgentId, userId}`) +
`/oauth/<provider>/callback` (public — verifies + **single-use consumes** state,
exchanges code). Providers: shopify, hubspot, stripe, salesforce, zoho_crm,
airtable, wix, square, monday, calendar (google), confluence, google_drive
(`services/ai/src/routes/{connectors-admin,crm-oauth,calendar-oauth,knowledge-oauth}.ts`).

Requirements under the new cookie model:

- **`/init` becomes cookie+CSRF authenticated** (it is an app action). The signed
  state must additionally bind `{ sessionId, activeMembershipId, provider,
  originating Settings/AI-Studio location, single-use, short expiry }` — so a
  connect initiated in one workspace cannot complete in another.
- **`/callback` stays public** (Authentik/provider redirects a top-level GET; no
  cookie needed) and remains **exempt from A6 CSRF** — its defense is the signed
  single-use state (replay-protected). Do **not** couple it to the session
  cookie for auth, only for *binding validation*.
- The new architecture must not cause **duplicate provider connections or wrong
  callback destinations**: the state's originating-location field drives the
  post-connect redirect back into the exact Settings/AI-Studio surface.

## A13. Invitation, onboarding, MFA & password compatibility

Preserve every path (map from `authentik-architecture.md` §4, `oidc.ts`,
`invitation.service.ts`, `/join`, `/api/public/onboarding`):

- **New-tenant invite / existing identity invited to another tenant** — invite
  token (`/api/public/onboarding`, `/join`) is public + token-validated; on first
  login the app session is created only **after** the Authentik flow completes.
- **New-user password setup / email verification / password reset** — owned by
  Authentik (recovery links); GOTCHA holds no credential. The stale-flow restart
  (A5) covers the reset-in-a-fresh-tab replay.
- **MFA-required login / MFA + passkey enrollment** — enforced inside the
  Authentik flow; embedded flows (`authentikFlowUrl`, `/auth/flow-done`) stay
  browser-side (they use the Authentik **session cookie**, not our token).
- **Rule:** the app session is created **only after the complete required
  Authentik flow succeeds** (callback has real tokens). **Session fixation
  prevention:** fresh session id at creation; `returnTo` must be a validated
  relative path.

## A14. Removal of browser token storage — exact deletion sequence

Only at rollout stage 4→7 (A15), in order:
1. Delete `lib/oidc.ts` browser exchange/refresh (`completeLogin`,
   `refreshTokens`); keep only `beginLogin`→server redirect + embedded-flow
   helpers.
2. Delete `AuthContext` `storeTokens`/`clearTokens`/`scheduleRefresh` +
   `localStorage["token"/"refreshToken"/"tokenExpiresAt"]`; hydrate from
   `/api/auth/me` over the cookie.
3. Remove every `Authorization: Bearer` builder (§3 list) → `credentials:"include"`
   centralized in the `active-tenant.ts` interceptor.
4. Remove frontend JWT parsing + token-derived tenant context;
   `activeTenantId` localStorage → server active membership.
5. Remove WS token param (notifications `?token=`) + socket `auth.token` →
   ticket (A9).
6. Remove `?token=` query auth (channels redirect) → cookie.
7. Keep unrelated UI prefs (`sidebar-collapsed`, `locale`, `notificationSound`,
   onboarding flags — §1 of the map lists them).
- **Regression test (repo-level):** a test that greps the frontend for
  `localStorage.*token`, `sessionStorage.*token`, `Authorization: \`Bearer`,
  `?token=` in ws/api, and **fails** if browser auth-token storage/transport is
  reintroduced. (Mirrors the existing `settings-ia`/parity source-assertion
  tests.)

## A15. Feature flags & staged rollout

Independent flags (env / tenant-scoped): `SESSION_COOKIE_CREATE` (issue cookie
sessions), `SESSION_COOKIE_ACCEPT` (resolver honors cookie), `LEGACY_BEARER_ACCEPT`
(services still accept browser Bearer), `BROWSER_TOKEN_ISSUE` (SPA still stores
tokens), `COOKIE_ONLY_ENFORCE` (reject browser Bearer).

Sequence (each stage reversible, see A16):
1. Ship session infra + resolver, all flags off → **no behavior change**.
2. `CREATE`+`ACCEPT` on for selected dev identities/tenants; Bearer still works.
3. Measure legacy Bearer usage (metric on `authenticate()` path).
4. Migrate all browser surfaces to cookie (A14 steps 1–6 behind `BROWSER_TOKEN_ISSUE`).
5. `BROWSER_TOKEN_ISSUE` off — stop issuing browser tokens.
6. Revoke/expire legacy browser sessions.
7. `COOKIE_ONLY_ENFORCE` on — services reject browser Bearer (keep internal
   service-key path).
8. Delete compatibility code + flags. **No indefinite dual-auth.**

## A16. Rollback plan (per stage)

- Stages 1–2: flags off → resolver dormant; zero user impact.
- Stage 3: metric only; nothing to roll back.
- Stage 4: re-enable `BROWSER_TOKEN_ISSUE`; interceptor falls back to Bearer
  (keep both code paths until stage 8).
- Stage 5: re-enable token issue if cookie sessions misbehave.
- Stage 6: reissue is impossible (tokens gone) → rollback = re-enable login to
  mint fresh cookie sessions; users re-login (acceptable).
- Stage 7: turn `COOKIE_ONLY_ENFORCE` off to re-accept Bearer instantly.
- **Invariant:** never delete compatibility code (stage 8) until stage 7 has
  soaked with zero legacy Bearer and clean cookie metrics.

## A17. Updated threat model (deltas vs today)

| Threat | Today | After (Option A) |
|---|---|---|
| **XSS token theft** | access+refresh in `localStorage`, fully readable | **eliminated** — tokens server-side, HttpOnly opaque id; XSS can still *act* in-session, so keep CSP + short session + revocation |
| **CSRF** | ~n/a (Bearer not auto-sent) | **introduced by cookies** → mitigated by A6 (SameSite+Origin+token), not SameSite alone |
| **Client header spoofing** (Authorization/X-Tenant-Id) | services trust validated Bearer/hint | nginx **strips** all client identity headers; only nginx injects trusted Authorization (A2) |
| **Gateway bypass** | app services internal-only | **verified**: prod publishes only the gateway host port; app svcs + db internal; AWS SG no inbound 80/443, Cloudflare tunnel sole ingress |
| **Token leak via logs/redirects** | Bearer in client-side fetch | injected token confined to nginx internals + upstream; log format excludes it (A3) |
| **Refresh storm / rotation loss** | each tab refreshes | single distributed lock per session, atomic rotation, `invalid_grant`→revoke (A9/§4) |
| **Revoked session lingering** | token valid till expiry | resolver checks every request (no cache), sockets revalidate periodically (A10/A9) |
| **Cross-tenant via stale active tenant** | `activeTenantId` in localStorage | server-owned `activeMembershipId`; header only a validated hint in migration |
| **Session fixation** | n/a | fresh id at login, never adopt pre-login id (A5/A13) |
| **In-network service-key = any tenant** | accepted tradeoff | **unchanged**; out of scope (tracked separately) |

## A18. Phase-by-phase commit plan

1. `feat(shared): session model + SESSION_ENCRYPTION_KEY envelope + cookie codec`
   (Prisma model, encryption v-envelope A-encryption, cookie parse/serialize,
   startup key assertions) — pure infra, no wiring, tests.
2. `feat(auth): login-state + Auth-Code callback + session create/set-cookie` (A5)
   behind `SESSION_COOKIE_CREATE`.
3. `feat(auth): internal session-resolver endpoint` (A4) behind `SESSION_COOKIE_ACCEPT`.
4. `feat(gateway): auth_request wiring + client-header stripping + token injection`
   (A2/A3) — dev template first.
5. `feat(auth): server-owned refresh with per-session lock + invalid_grant revoke` (§4/A9).
6. `feat(auth): CSRF issuance/validation + Origin allow-list` (A6/A7).
7. `feat(auth): tenant switch → session.activeMembershipId + WS reconnect` (A8).
8. `feat(realtime): WS ticket + periodic revalidation; drop ?token=` (A9).
9. `feat(auth): logout / logout-all / session-list UI / revocation` (A10).
10. `feat(frontend): credentials:include interceptor; remove Bearer builders` (A14 3).
11. `feat(frontend): remove browser OIDC exchange/refresh + token storage` (A14 1–2,5,6).
12. `feat(connectors): bind OAuth state to session/membership/location` (A12).
13. `test(security): repo-level no-browser-token regression + matrix` (A14/A19).
14. `chore(rollout): flags, prod gateway template, docs, delete compat` (A15/A16).

## A19. Test matrix (must pass before each enforcement stage)

- **Cookie:** prod config asserts `__Host-`+Secure+HttpOnly+Lax+no-Domain; dev
  guard rejects prod; parser rejects malformed/duplicate/oversized.
- **Resolver:** 200 injects Bearer; 401 on missing/expired/revoked; 403 on
  revoked membership; body never forwarded; never fails open.
- **nginx (integration):** client-sent `Authorization`/`X-Tenant-Id`/`X-User-Id`
  are dropped and cannot reach a service; injected token absent from client
  response + access log.
- **Encryption:** round-trip; versioned envelope; wrong/absent prod key →
  startup failure; ciphertext ≠ plaintext; no token in error text.
- **Refresh:** N concurrent near-expiry requests → exactly one Authentik refresh;
  rotated token persisted atomically; `invalid_grant` → session revoked.
- **CSRF:** unsafe method without token → 403; with valid token → ok; upload
  works; OAuth callback exempt but state-replay blocked.
- **Tenant switch:** active membership updated atomically; permissions refreshed;
  sockets reconnect; old tenant not served.
- **WS:** ticket single-use + short TTL; no token in URL; revoked session closes
  socket at next tick; logout/logout-all/tenant-switch close sockets.
- **Logout/revocation:** revoked session rejected on next request; other-device
  revoke works; multi-tab drops to login with no secrets exchanged.
- **Invite/MFA:** session only after full flow; fresh id (fixation); returnTo is
  relative.
- **Gateway-bypass (deploy check):** prod exposes only the gateway port; app
  services + db unreachable from host; no alternate ingress.
- **Regression:** the no-browser-token grep test fails on reintroduction.

## A20. Decisions

**Resolved (2026-07-24, user-approved):**
- **Session store** = **Postgres (`UserSession`) + Redis lock.** Session rows in
  Postgres; per-session refresh lock + hot reads in Redis (already present via
  BullMQ). Backs the single-refresh-owner guarantee under concurrency.
- **WS auth** = **short-lived single-use ticket** (A9), never token/ticket in a URL.
- **Remember-me TTLs** = **12h (non-remembered) / 30d (remembered)**, env-backed,
  both capped by Authentik session/refresh validity + revocation.
- **Cookie codec** = **hand-rolled** in `packages/shared` (A11), no new dependency.
- **Sequencing** = review this addendum, then implement commit 1 (A18).

**Still open (resolve before/within implementation):**
1. **Exact prod app hostname** — deployment config answers this: the production
   app origin is **`https://app.gotcha.co.il`** (`scripts/authentik/bootstrap.mjs`
   registers `https://app.gotcha.co.il/auth/callback` + `https://app.gotcha.co.il/`;
   Authentik is `auth.gotcha.co.il`). These are env-OVERRIDABLE defaults
   (`AUTHENTIK_REDIRECT_URIS` / `NEXT_PUBLIC_OIDC_REDIRECT_URI`), so the LIVE
   deploy env value must still be confirmed before `APP_ORIGIN` is set and the
   prod cookie is enabled. → `APP_ORIGIN=https://app.gotcha.co.il` (pending live
   confirmation).
2. **`sessionVersion` bump triggers** — which events force global re-auth
   (password change, MFA change, role/permission change?).
3. **auth_request performance** — accept +1 internal hop/request, or add a short
   *negative-only* cache later (positive caching is banned, §cache)?

_Update: item 2 resolved by the commit-2 policy in §A21 below; commit 1 lands its
primitives. Item 3 resolved: accept the +1 hop, no caching in Phase 2, with
resolver instrumentation from the start. Item 1 remains open._

## A21. sessionVersion & revocation policy table (approved)

Three distinct mechanisms. Commit 1 lands the primitives
(`Identity.sessionVersion`, `UserSession.sessionVersion` snapshot, revocation
fields, `REVOCATION_REASON`, the invalidation query builders); the triggers are
wired in later commits.

| Event | Mechanism | Effect |
|---|---|---|
| Logout (current) | rotate + revoke | revoke current session, clear cookie, end IdP session |
| Logout all | **global version bump** | `Identity.sessionVersion++` → every older session invalid |
| Password reset / recovery password change | **global version bump** | all sessions for the identity invalid; re-login required |
| Admin-forced credential reset | **global version bump** | same |
| MFA removed/reset/recovery | **global version bump** | same |
| Passkey recovery/removal weakening auth | **global version bump** | same |
| Identity disabled | **global bump** + revoke | all sessions invalid immediately |
| Security incident / compromised-account | **global bump** + revoke | all sessions invalid |
| Authentik subject/issuer binding change | **global version bump** | all sessions invalid (identity re-bind) |
| Explicit admin force-reauth | **global version bump** | all sessions invalid |
| Successful login | rotate | fresh session id (fixation prevention) |
| In-session password change (after step-up) | rotate current + revoke others | keep current (rotated), drop all others; requires recent/step-up auth |
| MFA enrollment | rotate current | new id, same session |
| Passkey enrollment | rotate current | new id, same session |
| Active membership / workspace switch | rotate current | new id; `activeMembershipId` updated atomically; CSRF rotated |
| Permission/role change affecting a session | rotate affected + re-resolve | authz re-resolved from live membership; no stale token perms |
| Privilege elevation | rotate current | new id |
| Sensitive account-setting change | rotate current | new id |
| Permission/role/department/feature-flag change | **membership-context enforce** | authz always resolved from current GOTCHA membership, never the token |
| Membership suspended/removed | **membership-context revoke** | revoke sessions on that membership; another membership → require workspace selection; else → require login |
| Profile / locale / display-name / UI-preference change | **none** | no version bump, no rotation |

Rule: authorization is ALWAYS resolved from current GOTCHA Membership state, never
from permissions embedded in an Authentik access token.
