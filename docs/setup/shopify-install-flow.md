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

| Variable | Required | Notes |
|---|---|---|
| `SHOPIFY_API_KEY` | yes | App client id. Already set. |
| `SHOPIFY_API_SECRET` | yes | Verifies app-entry and callback HMACs. Already set. |
| `SHOPIFY_REDIRECT_URI` | yes | Must equal a `redirect_urls` entry exactly. Already set. |
| `SHOPIFY_APP_INSTALL_URL` | one of these two | Limited-visibility install link for an unlisted app. Wins when set. Must be `https` on a Shopify-owned host (`apps.shopify.com`, `admin.shopify.com`, `accounts.shopify.com`, `*.myshopify.com`). |
| `SHOPIFY_APP_HANDLE` | one of these two | Public listing handle **read from the Partner Dashboard**. Derives `https://apps.shopify.com/<handle>`. |

With neither set, `Connect Shopify` returns `503
shopify_install_url_not_configured` and the UI says the environment is not
configured yet. That is deliberate: a guessed listing URL 404s, and a
hard-coded development store would send every merchant to somebody else's shop.

`SHOPIFY_APP_HANDLE` also feeds the existing admin deep link
(`buildAppAdminLink`), so setting it fixes two things at once.

## 5. Shopify Partner Dashboard - MANUAL CHANGES REQUIRED

**None of this happens automatically.** `shopify.app.production.toml` only
takes effect on `shopify app deploy`, and that command republishes the entire
manifest.

1. **App URL** → set to
   `https://app.gotcha.co.il/api/connectors/shopify/install`
   (was `https://app.gotcha.co.il`). This is the change that makes OAuth start
   before any GOTCHA screen.
2. **Allowed redirection URL(s)** → confirm all three are present, unchanged:
   - `https://app.gotcha.co.il/api/connectors/shopify/oauth/callback`
   - `https://gotcha.co.il/api/connectors/shopify/oauth/callback`
   - `https://dev.gotcha.co.il/api/connectors/shopify/oauth/callback`
3. **App handle** → read it from the dashboard and set `SHOPIFY_APP_HANDLE`
   in the environment. Do not guess it.
4. If the app is **not publicly listed**, copy the limited-visibility install
   link from the dashboard into `SHOPIFY_APP_INSTALL_URL` instead.

Before any `shopify app` command:

```bash
node scripts/shopify/verify-unified-app-identity.mjs
```

It fails closed, has no bypass flag, and now asserts the new `application_url`.

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

## 7. Manual verification on a development store

1. Sign in to an existing GOTCHA workspace.
2. Settings → Business Systems → Shopify → **Connect Shopify**.
3. Confirm the page that opens is on Shopify and that **no domain input was
   shown anywhere** in GOTCHA.
4. Pick the development store on Shopify.
5. Confirm the request lands on `/api/connectors/shopify/install` (network tab:
   a 302, not an HTML page).
6. Confirm the next hop is `https://<shop>/admin/oauth/authorize` - no GOTCHA
   login or onboarding screen in between.
7. Approve the scopes.
8. Confirm you return to Business Systems and the store is connected **to the
   workspace you started from**.
9. Ask the assistant an order question to confirm the tools work.
10. Uninstall from Shopify admin → confirm the connection shows DISCONNECTED.
    Reinstall → confirm it returns to the same workspace with **one**
    connection row (`select count(*) from tenant_integrations where ...`).
11. Repeat 2-8 in an incognito window with no GOTCHA session, starting from
    Shopify: confirm you are asked to sign in **after** authorization, land on
    `/settings/business-systems/shopify/finish`, and that claiming attaches the
    store to your workspace.
12. Negative cases, by hand against `/api/connectors/shopify/install`:
    - tamper one character of `hmac` → refused
    - remove `hmac` → refused
    - replay a captured URL after 5 minutes → refused
    - `shop=evil.com`, `shop=shop.myshopify.com.evil.com` → refused
    - replay a completed callback URL → `state_already_used`
    - install the same store into a second workspace → conflict message, and
      the store stays with the first
