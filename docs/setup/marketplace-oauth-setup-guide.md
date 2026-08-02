# Marketplace OAuth Setup Guide

Step-by-step instructions to register the OAuth apps that power the marketplace `Connect with OAuth` flow for every supported provider.

For each provider you'll:

1. Register a developer app
2. Set the **redirect URI** to the URL listed below
3. Tick the **scopes** listed
4. Paste the issued **Client ID** and **Client Secret** into `.env`
5. `docker compose restart ai`

The redirect URI pattern for new providers is:
`https://<your-host>/api/connectors/<slug>/oauth/callback`

Three legacy providers (Zoho, Calendly, Google Calendar) use:
`https://<your-host>/api/integrations/oauth/<slug>/callback`

Replace `gotcha.co.il` with your actual host below.

---

## 1. Stripe (Stripe Connect)

**Why OAuth**: tenants connect their own Stripe account so refunds / payment links / invoices fire from their funds, not yours.

### Steps

1. Sign in at https://dashboard.stripe.com/login
2. Switch to your **platform** account (the one that owns the Connect integration)
3. Go to **Settings → Connect settings**: https://dashboard.stripe.com/settings/connect
4. Under **OAuth settings**, set:
   - **Redirect URI**: `https://app.gotcha.co.il/api/connectors/stripe/oauth/callback`
5. Copy the **Connect Client ID** (starts with `ca_…`) → `STRIPE_CLIENT_ID`
6. Go to **Developers → API keys** (https://dashboard.stripe.com/apikeys), copy the **Secret key** (`sk_live_…` or `sk_test_…`) → `STRIPE_SECRET_KEY`
7. The redirect URI in your env is already correct: `STRIPE_REDIRECT_URI=https://app.gotcha.co.il/api/connectors/stripe/oauth/callback`

### Scopes / capabilities

Stripe Connect doesn't use OAuth scope strings - what the connected account can do is set by the **capabilities** you request when onboarding the account. For our adapter you need at minimum:

- `card_payments` (creates payment links)
- `transfers` (if you take a platform fee)

These are configured **per Connect account type** at https://dashboard.stripe.com/settings/connect.

### .env

```bash
STRIPE_CLIENT_ID=ca_xxxxxxxxxxxx
STRIPE_SECRET_KEY=sk_live_xxxxxxxxxxxx
STRIPE_REDIRECT_URI=https://app.gotcha.co.il/api/connectors/stripe/oauth/callback
```

### Gotchas

- Stripe matches the redirect URI **byte-for-byte** - trailing slashes, http vs https, all matter
- For dev/staging, register a separate Connect Client ID against your test-mode Stripe account

---

## 2. HubSpot

### Steps

1. Go to https://app.hubspot.com/developer
2. Click **Create app** → name it (e.g. *Gotcha AI Marketplace*)
3. Open the app → **Auth** tab
4. Under **Redirect URL**, add: `https://app.gotcha.co.il/api/connectors/hubspot/oauth/callback`
5. Under **Scopes**, mark these as **required**:

   - `crm.objects.contacts.read`
   - `crm.objects.contacts.write`
   - `crm.objects.deals.read`
   - `crm.objects.deals.write`
   - `crm.objects.leads.read` *(Sales Hub Enterprise only - see note below)*
   - `crm.objects.leads.write` *(Sales Hub Enterprise only)*
   - `oauth`

6. Save → copy the **App ID / Client ID** → `HUBSPOT_CLIENT_ID`
7. Copy the **Client Secret** → `HUBSPOT_CLIENT_SECRET`

### Note about Leads scopes

The dedicated Leads object is **Sales Hub Enterprise only**. If your test account is on Pro/Starter and you tick the Leads scopes, HubSpot will reject the install. Either:

- Leave Leads scopes unchecked, OR
- Use a Sales Hub Enterprise developer test account

The marketplace UI will still show Lead tools to all tenants - the LLM gets a graceful 403 → `ok:false` and pivots to `create_contact`.

### .env

```bash
HUBSPOT_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
HUBSPOT_CLIENT_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
HUBSPOT_REDIRECT_URI=https://app.gotcha.co.il/api/connectors/hubspot/oauth/callback
```

---

## 3. Shopify

**Why OAuth**: each tenant connects their own Shopify store. Tokens are per-shop.

### Steps

1. Go to https://partners.shopify.com → **Apps** → **Create app** → **Create app manually**
2. App name: e.g. *Gotcha AI*
3. Open the app → **Configuration** tab
4. Under **App URL**, set: `https://gotcha.co.il`
5. Under **Allowed redirection URL(s)**, add: `https://app.gotcha.co.il/api/connectors/shopify/oauth/callback`
6. **Build → Configuration → Protected customer data access**: request access to `Email`, `Phone`, `Name`, `Address` (required for `shopify.get_customer`)
7. Go to **API access** tab → copy:
   - **Client ID** → `SHOPIFY_API_KEY`
   - **Client secret** → `SHOPIFY_API_SECRET`

### Scopes (set in the OAuth init code)

Already requested by `services/ai/src/routes/connectors-admin.ts`:

- `read_orders` - list orders
- `write_orders` - note + tag orders
- `read_customers` - get customer
- `write_discounts` - create discount codes
- `read_products` - (future)

If you change this list in the partner dashboard, also update the `scopes` constant in `connectors-admin.ts` so the OAuth init asks for them.

### .env

```bash
SHOPIFY_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_REDIRECT_URI=https://app.gotcha.co.il/api/connectors/shopify/oauth/callback
```

### Gotchas

- Shopify install URL must include the tenant's shop domain - the marketplace UI prompts the admin for it (`my-store.myshopify.com`) before kicking off OAuth
- You can't connect a *development store* to a non-published app unless you add the store under **Test on development store**
- For production, you'll eventually want to submit the app for review (read-only data tools don't require it; write tools do)

---

## 4. Wix (Wix App - install flow)

> **IMPORTANT - read this first.** Wix has two OAuth-shaped flows. For *multi-tenant SaaS* like Gotcha (any Wix store owner connects their store), you **MUST** use the **Wix App install flow**, NOT "Headless OAuth". Headless OAuth is only for *your own* Wix sites/projects.
>
> The install flow URL is `https://www.wix.com/installer/install?appId=…&redirectUrl=…&state=…` - the user picks one of *their* sites, approves permissions, and Wix sends back a `code` + `instanceId` (the site identifier). Our backend exchanges the code for an access token scoped to that instance.

### Steps

1. Sign in at https://dev.wix.com
2. **My Apps** → **Create New App**
3. Choose: **"Build apps for Wix users"** (NOT "Headless"). This gives you a Wix App that other Wix users can install on their sites.
4. App name: e.g. *Gotcha AI*
5. Left sidebar → **App Settings → URLs / Endpoints**:
   - **App URL**: `https://gotcha.co.il` (where Wix users land after install - your dashboard)
   - **Redirect URL**: `https://app.gotcha.co.il/api/connectors/wix/oauth/callback`
6. Left sidebar → **Permissions** → **+ Add Permissions**, add:
   - **Wix Stores** → `Read Stores`, `Read Orders`
   - **Wix CRM (Contacts)** → `Read Contacts`, `Manage Contacts`
   - **Wix eCommerce** → `Read Orders`
7. Left sidebar → **OAuth**:
   - **App ID** → `WIX_CLIENT_ID`
   - **App Secret Key** (click reveal) → `WIX_CLIENT_SECRET`
8. (For testing without publishing) Left sidebar → **Test Your App** → click **Open in Wix** → install on one of your own Wix sites to verify the flow

### .env

```bash
WIX_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx     # = "App ID" in Wix dev console
WIX_CLIENT_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx # = "App Secret Key"
WIX_REDIRECT_URI=https://app.gotcha.co.il/api/connectors/wix/oauth/callback
```

### How the flow looks at runtime

1. Tenant clicks **Connect Wix** in your marketplace
2. Browser → `https://www.wix.com/installer/install?appId=<APP_ID>&redirectUrl=<callback>&state=<jwt>`
3. Wix shows: "Add **Gotcha AI** to which site?" - tenant picks
4. Wix shows the permission consent screen → tenant approves
5. Wix redirects to your callback with `?code=…&instanceId=<site-instance>&state=…`
6. Your backend POSTs the code to `https://www.wixapis.com/oauth/access` and persists the access/refresh tokens + the `instanceId` of the picked site
7. Adapter is now CONNECTED for that site

### Gotchas

- The **App ID** is what fills `WIX_CLIENT_ID` - Wix sometimes shows it as "Client ID" or "App ID" in different parts of the console. They're the same value
- "Headless OAuth" mode in the Wix console (the option you saw earlier) is for a different use case - apps where YOU own the Wix project. Don't use it for multi-tenant
- App distribution: while testing you can install on your own sites without publishing. For real customers you eventually want to **submit the app to the Wix App Market** (left sidebar → **App Market Listing** → fill the listing → submit). But you can also distribute privately by sharing the install URL directly
- `instanceId` is **per-site**. If a tenant has 3 Wix sites and connects to one, your tokens only work for that site. Connecting another site means another OAuth round → another integration row

---

## 5. Square

### Steps

1. Sign in at https://developer.squareup.com/apps
2. Click **+ Application** → name it
3. Open the app → **OAuth** tab
4. Under **Production Redirect URL**, add: `https://app.gotcha.co.il/api/connectors/square/oauth/callback`
5. (Optional) Add the same URL under **Sandbox Redirect URL** for test connections
6. Copy:
   - **Application ID** → `SQUARE_APPLICATION_ID`
   - **Application Secret** → `SQUARE_APPLICATION_SECRET`

### Scopes (set in the OAuth init code)

Already requested:

- `PAYMENTS_WRITE` `PAYMENTS_READ`
- `CUSTOMERS_READ` `CUSTOMERS_WRITE`
- `ORDERS_READ` `ORDERS_WRITE`
- `INVOICES_READ` `INVOICES_WRITE`
- `MERCHANT_PROFILE_READ`

These are also configurable on the OAuth tab - make sure they're enabled in the dev console.

### .env

```bash
SQUARE_APPLICATION_ID=REPLACE_ME
SQUARE_APPLICATION_SECRET=REPLACE_ME
SQUARE_REDIRECT_URI=https://app.gotcha.co.il/api/connectors/square/oauth/callback
```

### Gotchas

- Square has **separate Application IDs** for Sandbox vs Production - pick one per env. The same pair of vars works for both; the marketplace UI lets the tenant pick which environment to target via a dropdown
- Tenants must select a **default location** in their config (auto-selected from the first location returned by `/v2/locations` if not set)

---

## 6. Salesforce

### Steps

1. Sign in to your Salesforce org → **Setup** (gear icon → Setup)
2. Quick find: **App Manager** → **New Connected App**
3. Fill:
   - **Connected App Name**: *Gotcha AI Marketplace*
   - **API Name**: auto-fills
   - **Contact Email**: your address
4. **Enable OAuth Settings** → check
   - **Callback URL**: `https://app.gotcha.co.il/api/connectors/salesforce/oauth/callback`
   - **Selected OAuth Scopes**:
     - `Manage user data via APIs (api)`
     - `Perform requests at any time (refresh_token, offline_access)`
   - **Require Secret for Web Server Flow**: ✓ checked
5. **Distribution State**: set to **Global** - this is what lets users from *other* Salesforce orgs OAuth into your app. Without it, only users in *your* Salesforce org can install.
6. Save (5–10 min for Salesforce to propagate the new app)
7. **Important second pass - open the app → Manage → Edit Policies → OAuth Policies**:
   - **Permitted Users**: set to **"All users may self-authorize"** - without this, external admins would need to pre-approve specific users in their org before OAuth works
   - **IP Relaxation**: leave at default (`Enforce IP restrictions`) unless you have a known issue
8. Back to the app overview → **Manage Consumer Details** (re-auth required) → copy:
   - **Consumer Key** → `SALESFORCE_CLIENT_ID`
   - **Consumer Secret** → `SALESFORCE_CLIENT_SECRET`

### .env

```bash
SALESFORCE_CLIENT_ID=3MVG9...consumer_key...
SALESFORCE_CLIENT_SECRET=A1B2C3...consumer_secret...
SALESFORCE_REDIRECT_URI=https://app.gotcha.co.il/api/connectors/salesforce/oauth/callback
```

### Gotchas

- Salesforce returns an `instance_url` with the access token - each tenant has their own subdomain (`https://acme.my.salesforce.com`). Our adapter persists this per-tenant and uses it for every API call
- The marketplace UI lets the tenant pick **login.salesforce.com** (production) vs **test.salesforce.com** (sandbox) before OAuth init
- After saving the Connected App, Salesforce can take **up to 10 minutes** before it accepts OAuth requests against it - be patient

---

## 7. Monday.com

### Steps

1. Sign in to https://monday.com → **Avatar → Developers** (or https://monday.com/developers/apps)
2. **Create app** → name it
3. **OAuth & Permissions** tab:
   - **Redirect URLs**: `https://app.gotcha.co.il/api/connectors/monday/oauth/callback`
   - **Scopes**: tick
     - `boards:read`
     - `boards:write`
     - `updates:write`
4. **Basic Information** → copy:
   - **Client ID** → `MONDAY_CLIENT_ID`
   - **Client Secret** → `MONDAY_CLIENT_SECRET`
5. (Optional) Submit the app for the marketplace if you want public install

### .env

```bash
MONDAY_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MONDAY_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MONDAY_REDIRECT_URI=https://app.gotcha.co.il/api/connectors/monday/oauth/callback
```

### Gotchas

- After OAuth completes, the marketplace shows a **board selector** - the admin picks the default board the AI will create items in. This is stored as `config.defaultBoardId`
- Monday's API key tokens are also accepted (`Authorization: <token>` without `Bearer`) - useful for testing without OAuth

---

## 8. Zoho CRM (already configured)

`.env` already populated. For reference:

- App registration: https://api-console.zoho.com → **Server-based Application**
- Redirect URI: `https://app.gotcha.co.il/api/integrations/oauth/zoho_crm/callback` *(legacy path)*
- Scopes: `ZohoCRM.modules.ALL,ZohoCRM.users.READ,ZohoCRM.org.READ`

---

## 9. Calendly (already configured)

`.env` already populated. For reference:

- App registration: https://developer.calendly.com → **My Apps**
- Redirect URI: `https://app.gotcha.co.il/api/integrations/oauth/calendly/callback` *(legacy path)*
- Scopes: handled implicitly - you ship a unified scope set

---

## 10. Google Calendar (uses existing GOOGLE_CLIENT_ID)

The same Google OAuth client used for Gmail also handles Calendar.

- Already in `.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- Calendar redirect URI: `https://app.gotcha.co.il/api/integrations/oauth/google-calendar/callback` *(set as `GOOGLE_CALENDAR_REDIRECT_URI`)*
- Required scopes (add at https://console.cloud.google.com → APIs & Services → OAuth consent screen):
  - `https://www.googleapis.com/auth/calendar`
  - `https://www.googleapis.com/auth/calendar.events`

---

## 11. PayPal - no platform-side OAuth needed

PayPal uses **client-credentials** at the **tenant** level: each tenant pastes their own `client_id` + `client_secret` from their own PayPal Developer account into the marketplace UI. No platform-wide app registration needed.

The marketplace form fields:

- **Client ID** (tenant's)
- **Client Secret** (tenant's)
- **Environment**: `live` | `sandbox`

To test:

1. Each tenant goes to https://developer.paypal.com/dashboard → **Apps & Credentials**
2. Creates an app, copies the **Client ID** + **Secret**
3. Pastes them into the marketplace card
4. Clicks **Save & Connect** → marketplace tests the connection by minting an access token

---

## 12. WooCommerce - no OAuth (consumer key/secret)

WooCommerce REST API uses HTTP Basic auth with a **consumer key + consumer secret** the tenant generates inside their WooCommerce admin. No platform-side app needed.

The marketplace form fields:

- **Store URL** (e.g. `https://shop.example.com`)
- **Consumer Key**
- **Consumer Secret**

To test:

1. Tenant logs into their WooCommerce admin
2. **WooCommerce → Settings → Advanced → REST API → Add Key**
3. Permissions: **Read/Write**
4. Copies the generated Consumer Key + Secret into the marketplace card

---

## 13. Airtable - Personal Access Token (no OAuth)

Each tenant generates their own PAT at https://airtable.com/create/tokens.

Required scopes:

- `data.records:read`
- `data.records:write`
- `schema.bases:read` (so the marketplace can populate the base + table selector)

After pasting the PAT, the marketplace UI fetches the tenant's bases → tables, the admin picks one → stored as `config.baseId` + `config.tableId`.

---

## 14. PostgreSQL / MongoDB / AWS RDS - connection strings

No OAuth. Each tenant pastes their own DB connection string + an **allowlist** of tables (Postgres/RDS) or collections (MongoDB) the AI may read/write.

The marketplace UI exposes:

- **Connection String** (password)
- **Tables AI may read** (comma-separated)
- **Tables AI may write** (comma-separated, must be a subset of reads)
- **Max rows per query** (default 100)

For RDS, an additional **Engine** dropdown picks `postgres` | `mysql` | `mariadb`.

---

## After everything is set

1. Edit `.env` with all the credentials you collected
2. Restart the AI service:

   ```bash
   docker compose restart ai
   ```

3. Open the marketplace at `https://gotcha.co.il/integrations`
4. For each provider, click the card → **Connect with OAuth** (or fill the API-key form for non-OAuth providers)
5. Approve the install at the provider's screen → you'll be redirected back with a `?status=connected` indicator
6. Tools appear in the integration detail page - toggle them on to expose to your AI agents

---

## Verifying a connection works

For each connected integration, click **Test Connection** in the marketplace card. The button calls the adapter's first READ tool against the real provider. A green check means:

- Credentials decrypted correctly
- Token refresh works (for OAuth providers)
- Provider returned a 2xx response

A red error includes the provider's exact failure message - usually a missing scope or a misconfigured redirect URI.

---

## Common errors

| Error | Cause | Fix |
|---|---|---|
| `oauth_init failed: no STRIPE_CLIENT_ID` | Env var blank | Paste credentials into `.env`, `docker compose restart ai` |
| `redirect_uri_mismatch` | Provider's allowed list doesn't include this exact URI | Re-check the URI byte-for-byte (https/http, trailing slash) |
| `invalid_scope` | Asked for a scope the app doesn't have | Add it in the provider's dev console + re-install |
| `bad_state` (from our callback) | OAuth state JWT expired (>10 min) | Re-click Connect to start a fresh flow |
| `not_connected:<slug>` (from a tool call) | Token expired and refresh failed | Marketplace card will show ERROR - tenant clicks Reconnect |
| `rate_limited:<slug>:retry_after_ms=...` | More than 10 calls/sec/provider | LLM will pivot; no action needed |

---

## Where the code lives

- **OAuth init/callback handlers**: `services/ai/src/routes/connectors-admin.ts`
- **Adapters (one per provider)**: `services/ai/src/services/connectors/<slug>.adapter.ts`
- **Catalog (what shows in marketplace UI)**: `packages/shared/prisma/migrations/20260506100000_marketplace_real_integrations_only/migration.sql`
- **Frontend marketplace pages**: `frontend/src/app/integrations/`
