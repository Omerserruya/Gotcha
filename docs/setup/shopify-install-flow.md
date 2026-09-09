# Shopify installation flow

How a merchant's Shopify store becomes a connection in a GOTCHA workspace, why
the flow is shaped this way, and what has to be changed by hand in the Partner
Dashboard for it to work.

---

## 1. What was wrong

Installation used to start on a GOTCHA screen with a text box. The merchant
typed `my-store.myshopify.com`, GOTCHA built an authorize URL from what they
typed, and redirected there.

Three problems, in increasing order of severity:

1. **App Store requirement 2.3.1** forbids asking for the shop domain at all.
   Shopify identifies the store; the app does not ask.
2. **App Store requirement 2.3.2** requires OAuth before any app UI. The
   production `application_url` was `https://app.gotcha.co.il` - the
   application root - so a merchant who installed from Shopify landed on a
   **login screen**. Shopify's signed app-entry request (carrying `shop`,
   `hmac`, `timestamp`) arrived at a Next.js page that read none of it.
3. **The typed host was an unauthenticated claim.** It fed the authorize
   redirect and the eventual connection record. Separately, the OAuth
   **callback verified no HMAC at all** - it read `shop` and `code` from an
   unsigned request, so anything able to present a live `state` could drive a
   token exchange against a host of its choosing.

## 2. The flow now

```
  merchant (signed in)                     merchant (from Shopify, signed out)
  ────────────────────                     ──────────────────────────────────
  Connect Shopify                          App Store listing
      │  GET  /connectors/shopify/install/start
      │  → { url } + HttpOnly intent cookie
      ▼                                            │
  Shopify install page  ◄──────────────────────────┘
      │  merchant picks the store on SHOPIFY
      ▼
  GET /api/connectors/shopify/install        ← PUBLIC. application_url.
      │  verify shop + hmac + timestamp (services/shopify-install.ts)
      │  read intent cookie if present
      │  mint single-use state bound to the VERIFIED shop
      ▼
  302 https://<shop>/admin/oauth/authorize   ← OAuth starts here. No GOTCHA UI.
      │  merchant approves scopes
      ▼
  GET /api/connectors/shopify/oauth/callback ← PUBLIC. Unchanged path.
      │  1. verify callback HMAC
      │  2. consume state (single use, Redis SET NX, fail-closed)
      │  3. state.shop === query.shop
      │  4. exchange code
      ▼
  ┌─ had an intent? ─ yes ─► link to that workspace ─► /setup or /settings/business-systems
  └─ no ──────────────────► park as PENDING ────────► /settings/business-systems/shopify/finish
                                                          │ merchant signs in
                                                          ▼
                                              POST /connectors/shopify/install/claim
                                              (their session's workspace, their permission)
```

### The two questions, kept separate

The store and the workspace are answered by different authorities, and
conflating them is where every unsafe shortcut lives:

| Question | Answered by | Never by |
|---|---|---|
| Which **store**? | Shopify's HMAC over the app-entry request | anything the browser typed |
| Which **workspace**? | a validated GOTCHA session (at start, or at claim) | a query param, the shop name, an unsigned redirect |

## 3. Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/connectors/shopify/install/start` | authed + `connections:connect` | Returns the Shopify install URL; sets the intent cookie |
| `GET /api/connectors/shopify/install` | **public** | Shopify's signed app entry. Verifies, then 302s to authorize |
| `GET /api/connectors/shopify/oauth/callback` | **public** | Verifies HMAC + state, exchanges the code, links or parks |
| `GET /api/connectors/shopify/install/pending` | authed | Shop name of a parked install (never the token) |
| `POST /api/connectors/shopify/install/claim` | authed + `connections:connect` | Binds a parked install to the caller's workspace |
| `POST /api/connectors/shopify/install/cancel` | authed | Discards an abandoned intent |
| `GET /api/connectors/shopify/oauth/init` | authed + `connections:connect` | **Reauthorization only.** Shop read from the stored connection |

`oauth/init` still exists because re-granting a scope and replacing a revoked
token are real operations - but it no longer accepts a `shop` parameter. A
tenant with no Shopify connection gets `409 shopify_not_connected` pointing at
the install flow.

## 4. Environment variables

Exact names, where they are read, and whether production has them today.
**No values are recorded here or anywhere in this repo.**

| Variable | Read by | Purpose | Prod status |
|---|---|---|---|
| `SHOPIFY_API_KEY` | `getShopifyAppIdentity()` (`packages/shared/src/lib/shopify-app-identity.ts`) → install handler, `oauth/init`; also `connectors-admin.ts` token exchange | App **client ID**. Public; appears in the authorize URL. | configured |
| `SHOPIFY_API_SECRET` | same identity helper → `verifyAppEntryHmac`, `verifyOAuthCallbackHmac`, `verifyShopifyWebhookHmac`, app-proxy signatures | App **client secret**. Verifies every signature. | configured |
| `SHOPIFY_REDIRECT_URI` | `getShopifyAppIdentity()` → `buildShopifyAuthorizeUrl` | Absolute OAuth **callback**. Must match `auth.redirect_urls` exactly. | configured |
| `SHOPIFY_APP_URL` | `getShopifyAppIdentity()`; falls back to the origin of `SHOPIFY_REDIRECT_URI` | Public app base URL. | absent — **derived**, so not required |
| `SHOPIFY_APP_HANDLE` | `resolveShopifyInstallUrl()` (Connect button) and `buildAppAdminLink()` (admin deep link) | **OPTIONAL.** App Store listing handle. | commented placeholder — unset by design pre-listing |
| `SHOPIFY_API_VERSION` | `shopifyApiVersion()` (`packages/shared/src/lib/shopify-api-version.ts`) | Overrides the Admin API pin. | absent — default `2026-07` applies |
| `FRONTEND_URL` | `resolveAppPublicUrl()` → post-OAuth redirects, install error page | Public app origin for redirects. | configured |
| `DASHBOARD_URL` | `dashboardRedirect()` in `connectors-admin.ts` | Marketplace landing after connect. | configured |

**Scopes are NOT in the environment.** They are a source constant:
`SHOPIFY_OAUTH_SCOPES` in
`services/ai/src/services/shopify-connection-link.service.ts`, used by both
the install handler and `oauth/init` so the two cannot disagree.

### On `SHOPIFY_APP_HANDLE` being optional

It powers exactly one thing: the merchant-facing **Connect Shopify** button.
When it is unset that button returns `503 shopify_install_not_available` and
the UI says new connections are not available yet.

It does **not** gate any of the following, and there are tests pinning each:

* installation initiated from the Partner Dashboard,
* the public install handler receiving and validating Shopify's signed request,
* OAuth authorization and callback processing,
* existing store connections,
* reauthorization of an already-connected store.

There is deliberately **no `SHOPIFY_APP_INSTALL_URL`**. A custom-distribution
install link is generated per store (the dashboard asks for the shop's domain
first), so configuring one would hard-code a single merchant's shop into
everyone's button — and custom distribution forecloses Shopify billing and
App Store review, irreversibly. There is also no `SHOPIFY_DEV_STORE`, no
hardcoded shop, and no development-only OAuth bypass.

## 5. Shopify Partner Dashboard - MANUAL CHANGES REQUIRED

**None of this happens automatically.** `shopify.app.production.toml` only
takes effect on `shopify app deploy`, and that command republishes the entire
manifest.

Every value below is taken from a route that exists in this repository:

| Dashboard field | Exact value | Backing route |
|---|---|---|
| **App URL** | `https://app.gotcha.co.il/api/connectors/shopify/install` | `router.get("/connectors/shopify/install")` — `services/ai/src/routes/shopify-install.ts`, mounted at `/api` in `services/ai/src/index.ts` |
| **Allowed redirection URL(s)** — 1 | `https://app.gotcha.co.il/api/connectors/shopify/oauth/callback` | `router.get("/connectors/shopify/oauth/callback")` — `services/ai/src/routes/connectors-admin.ts` |
| **Allowed redirection URL(s)** — 2 | `https://gotcha.co.il/api/connectors/shopify/oauth/callback` | same route, apex host |
| **Allowed redirection URL(s)** — 3 | `https://dev.gotcha.co.il/api/connectors/shopify/oauth/callback` | same route, dev host |
| **App proxy URL** | `https://app.gotcha.co.il/api/shopify-chat/proxy` | `services/ai/src/routes/shopify-chat-public.ts` (unchanged) |
| **Distribution** | Public distribution | — do **not** select Custom distribution; the choice is irreversible |

Only the **App URL** changes in this rollout. The three redirect URLs, the app
proxy and the webhook endpoints are unchanged, and all three redirects must
stay listed — the manifest REPLACES the live allowlist on deploy.

Before any `shopify app` command:

```bash
node scripts/shopify/verify-unified-app-identity.mjs
```

It fails closed, has no bypass flag, and asserts the App URL above.

> ⚠️ `shopify.app.toml` in the same directory is the **retired Chat app**
> manifest and is marked as such at the top of the file. Deploying it would
> strip all 26 scopes from every connected merchant. It is not the production
> source of truth.

## 6. Existing merchants

Nothing about a connected store changes. Specifically:

- Tokens are untouched; nobody is disconnected.
- The callback path is unchanged, so in-flight OAuth still lands.
- Tenant ownership is unchanged.
- `TenantIntegration` keeps its `@@unique([tenantId, integrationId])`, so a
  reconnect updates one row and never creates a second.
- An `app/uninstalled` webhook still marks the row `DISCONNECTED` and clears
  the credentials while **keeping** `tenantId` and `config.shopDomain`. That
  retained ownership is what makes a reinstall land back in the same
  workspace - and it is why `findShopOwner` deliberately counts
  `DISCONNECTED` rows as owned. Without that, a second workspace could claim a
  store the moment the first uninstalled.

No database migration was added. The connection intent and the pending
connection are short-lived Redis records (30 and 15 minutes), which gives
expiry and single-use consumption natively; the pending record holds the
access token **encrypted** with the same helper used for the database.

## 7. Testing on a development store BEFORE the listing is published

This is the whole point of keeping `SHOPIFY_APP_HANDLE` optional: the install
path works today, without a listing, without a handle, and without any
development-only bypass. Shopify itself initiates the install from the Partner
Dashboard.

### 7.1 Prerequisite (one manual change)

Partner Dashboard → **Apps** → **GOTCHA** → **Configuration** → **App URL**:

```
https://app.gotcha.co.il/api/connectors/shopify/install
```

Nothing else changes. Without this, Shopify sends its signed request to the
application root and you land on a login screen instead of OAuth.

### 7.2 Start the install from Shopify

1. Go to <https://partners.shopify.com> → **Apps** → **GOTCHA**.
2. Open **Overview** (or **Test your app**) → **Select store**.
3. Pick your development store and click **Install app**.

You never type a domain anywhere in GOTCHA. Shopify knows the store.

### 7.3 What must happen, in order

| # | What | Expected |
|---|---|---|
| 1 | Shopify calls **first** | `GET https://app.gotcha.co.il/api/connectors/shopify/install?shop=<store>.myshopify.com&hmac=…&timestamp=…&host=…` |
| 2 | GOTCHA responds | `302` to `https://<store>.myshopify.com/admin/oauth/authorize?client_id=…&scope=…&redirect_uri=…&state=…` |
| 3 | Merchant sees | Shopify's **permissions/consent** screen. **No GOTCHA login or onboarding screen before this.** |
| 4 | After approving | `GET https://app.gotcha.co.il/api/connectors/shopify/oauth/callback?code=…&hmac=…&shop=…&state=…` |
| 5 | Final landing | signed in → `/settings/business-systems?connected=shopify` · signed out → `/settings/business-systems/shopify/finish?handle=…` |

Confirm step 1→2 in the browser network panel with **"Preserve log"** on;
without it the redirect chain is gone before you can read it.

### 7.4 Verify OAuth completed

```bash
# Correct: a 302 whose Location is the shop's own authorize URL.
curl -s -D- -o /dev/null \
  "https://app.gotcha.co.il/api/connectors/shopify/install?shop=<store>.myshopify.com" \
  | grep -i '^location:'
# UNSIGNED, so this must NOT reach Shopify - expect the internal error page.
```

Service log lines (no secrets in any of them):

```bash
docker logs --since 10m chatcenter-ai-1 2>&1 | grep -i "shopify install\|shopify oauth"
```

* Success: no rejection line, followed by a capability probe.
* Rejection: `[shopify install] app entry rejected: <reason>` — one of
  `shop_missing`, `shop_invalid`, `hmac_missing`, `hmac_invalid`,
  `timestamp_missing`, `timestamp_stale`, `not_configured`. The rejected shop
  value and the HMAC are deliberately never logged.

### 7.5 Verify the store linked to the RIGHT workspace

Read-only, and selecting **no credential columns**:

```sql
SELECT ti.id,
       ti.tenant_id,
       t.name        AS workspace,
       ti.status,
       ti.config->>'shopDomain' AS shop,
       ti.connected_at
FROM tenant_integrations ti
JOIN integration_catalog ic ON ic.id = ti.integration_id
JOIN tenants t              ON t.id  = ti.tenant_id
WHERE ic.slug = 'shopify'
ORDER BY ti.connected_at DESC
LIMIT 10;
```

Never `SELECT *` here and never select `credentials` — that column holds the
encrypted access token.

Expect **exactly one row** for your dev store, with `tenant_id` equal to the
workspace you started from. Re-running the install must not add a second row:

```sql
SELECT ti.config->>'shopDomain' AS shop, COUNT(*)
FROM tenant_integrations ti
JOIN integration_catalog ic ON ic.id = ti.integration_id
WHERE ic.slug = 'shopify'
GROUP BY 1 HAVING COUNT(*) > 1;   -- must return zero rows
```

### 7.6 Incognito, with no GOTCHA session

1. Open a **private window**. Do not sign in to GOTCHA.
2. Repeat 7.2 from the Partner Dashboard.
3. OAuth must still run first — Shopify's consent screen appears with no
   GOTCHA login before it.
4. After approving you land on `/settings/business-systems/shopify/finish?handle=…`
   and are asked to sign in. The page shows only the **shop name**.
5. Sign in, click **Connect to this workspace**.
6. Re-run the SQL in 7.5: the store is attached to the workspace you signed
   into, still one row.
7. Press the button again (or reload and re-submit): expect
   `409 pending_install_already_used` — the claim is single-use.

### 7.7 Negative cases

Run these against the public handler; all must refuse, and none may produce a
`Location:` containing `admin/oauth/authorize`:

| Case | Expected |
|---|---|
| `?shop=evil.com` | 302 → `…?shopify_install_error=invalid_request` |
| `?shop=shop.myshopify.com.evil.com` | same |
| valid shop, no `hmac` | same |
| valid shop, `hmac` altered by one character | same |
| replay a captured URL after 5 minutes | same (`timestamp_stale`) |
| replay a completed callback URL | `400 state_already_used` |
| install the same store into a second workspace | conflict; the store stays with the first |

### 7.8 Existing merchants (regression check)

Before and after, confirm an already-connected store is untouched: its
connection stays `CONNECTED`, order/product tools still answer, and
**Re-authorize on Shopify** works without asking for a domain.

