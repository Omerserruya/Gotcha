# Shopify Partner Dashboard — the steps that cannot be done in code

Everything in this file is a manual action in Shopify's Partner Dashboard. None
of it can be scripted from this repository, and until it is done the billing
integration stays in its `BILLING_PENDING` state by design.

Checked against shopify.dev on **2026-08-31**.

---

## 0. First, decide WHICH APP is being billed

**This is the decision that blocks everything else, and it is not ours to make
in code.** There are two separate Shopify apps, with separate Partner entries
and separate credentials:

| | **GOTCHA Core integration** | **GOTCHA Chat** (`shopify-app/shopify.app.toml`) |
|---|---|---|
| What it does | Product/order truth for the AI | Storefront live-chat widget |
| Credential | `SHOPIFY_API_KEY` | `SHOPIFY_CHAT_APP_CLIENT_ID` |
| Scopes | `read_products`, `read/write_orders`, `read_customers`, price rules, returns | **empty** |
| Embedded | n/a | **no** (`embedded = false`) |

A pricing plan belongs to exactly one app. Attaching plans to the wrong one
means merchants are billed for an app they did not install.

> ⚠️ `shopify.app.toml` sets `include_config_on_deploy = true`. Deploying that
> file against the **Core** app would replace Core's scopes and redirect
> allowlist, breaking OAuth for every connected store. Run
> `node scripts/shopify/verify-chat-app-identity.mjs` before any Shopify CLI
> command, as that file's own header instructs.

---

## 1. Choose the billing mechanism

| | **Shopify App Pricing** (managed) | **Manual Billing API** |
|---|---|---|
| Plan selection | Shopify-hosted page | Your own UI + `appSubscriptionCreate` |
| Plans defined in | **Partner Dashboard only** | Code |
| How you learn of a subscription | **Partner API poll — no webhooks** | Admin API + `app_subscriptions/update` |
| Credential needed | Organisation-level Partner API token | The shop's own Admin token |
| Non-embedded apps | **undocumented** | works |
| Config | `SHOPIFY_BILLING_MODE=app_pricing` | `SHOPIFY_BILLING_MODE=manual` |

**Both are implemented.** The switch changes no entitlement logic.

Two things should drive the choice:

1. **GOTCHA's Shopify app is non-embedded.** Shopify does not document whether
   App Pricing supports non-embedded apps. **Confirm this with Shopify before
   committing to `app_pricing`.**
2. **App Pricing fits our service boundaries better**, which is not obvious. Its
   credential is organisation-level, so the billing service holds it directly
   and never touches a merchant's Admin token. The manual path needs the shop's
   token, which belongs to `services/ai`, so billing has to ask that service to
   make the call on its behalf.

---

## 2. If using Shopify App Pricing

### 2.1 Create the pricing plans
**Partner Dashboard → App distribution → All apps → \<the app\> → Pricing.**

For each plan, record its **handle** — that is the only part this repo needs.

Then set `SHOPIFY_BILLING_PLAN_HANDLES` as a JSON map from our product key to
Shopify's handle:

```json
{"gotcha_core":"core-monthly","shopify_connector":"connector-monthly"}
```

> **Prices and plan definitions are never committed to this repository.** Under
> App Pricing they live only in the Partner Dashboard, so a copy here would
> eventually disagree with the number the merchant was actually shown.

### 2.2 Create the usage meters (only if metered billing is wanted)
On the same Pricing screen, add usage meters and record each **handle**.

- Maximum **5 active meters per plan**, **6 pricing tiers per meter**.
- Usage must be tied to a **monthly** billing cycle.
- Handles are **case-sensitive** and must match `SHOPIFY_USAGE_METER_HANDLES`
  exactly. A mismatch is skipped as `no_meter_handle_configured` rather than
  guessed at.

```json
{"ai_answer":"ai-answers","shopify_action":"shopify-actions"}
```

### 2.3 Set the app handle
`SHOPIFY_APP_HANDLE` must equal the app handle in the plan-selection URL:

```
https://admin.shopify.com/store/<store>/charges/<SHOPIFY_APP_HANDLE>/pricing_plans
```

Without it the service refuses to start rather than redirect merchants to a
broken admin URL.

### 2.4 Create a Partner API token
**Partner Dashboard → Settings → Partner API clients.**

Needed for `activeSubscription(appId:, shopId:)`. **This is not optional under
App Pricing** — since **2026‑04‑28** Shopify sends no subscription webhooks and
no longer appends `charge_id` to the redirect, so this query is the only way to
learn that anyone paid.

Record three values: `SHOPIFY_PARTNER_API_TOKEN` (**secret**),
`SHOPIFY_PARTNER_ORGANIZATION_ID`, `SHOPIFY_PARTNER_APP_ID`.

### 2.5 Create App Events credentials (only for metered billing)
OAuth2 `client_credentials` for `https://api.shopify.com/app/unstable/events`.
Record `SHOPIFY_APP_EVENTS_CLIENT_ID` and `SHOPIFY_APP_EVENTS_CLIENT_SECRET`
(**secret**).

### 2.6 Set the redirect URL
Where Shopify returns the merchant after plan selection. It arrives with
`plan_handle` and `shop` — **and nothing else.** The code treats those as a
prompt to go and verify, never as proof of payment.

---

## 3. If using the manual Billing API

1. Define plans **in code**, not in the Dashboard.
2. Confirm the app has an Admin API access token per shop — note that the Chat
   app currently requests **`scopes = ""`** and stores no token, so a scope and
   a token-storage/rotation flow must be added first.
3. Subscribe to `app_subscriptions/update` in **Partner Dashboard → Webhooks**
   (or the app TOML), and point it at a GOTCHA endpoint.
4. Implement the three internal endpoints in `services/ai` that
   `manual-billing.source.ts` calls:
   - `POST /api/internal/shopify/billing/subscription-create`
   - `POST /api/internal/shopify/billing/active-subscription`
   - `POST /api/internal/shopify/billing/subscription-cancel`

   They must be behind `requireInternalKey`. **`services/ai` performs the
   Shopify call because it owns the merchant's token; billing never sees it.**

---

## 4. Development stores and test charges

- Create development stores in the **same Partner organisation** as the app.
- Under App Pricing, Shopify prices contracts at **$0** on development stores —
  the full flow is exercisable with no real money.
- Under the manual API, `appSubscriptionCreate(test: true)`. The adapter sets
  this automatically for anything that is not `SHOPIFY_BILLING_ENV=live`.
- **The automated suite never reaches Shopify at all.** `SHOPIFY_BILLING_ENV`
  defaults to `mock`, which performs no network call, and `live` additionally
  requires `SHOPIFY_ALLOW_LIVE_BILLING=true`.

---

## 5. App Store review

- Apps on the App Store are **required to use a Shopify billing solution**.
- **Whether split billing is permitted for GOTCHA is unresolved.** Nothing on
  the pages checked permits or forbids billing some capabilities through
  Shopify and others externally. **This is the open question for Shopify/Kyle**,
  and it gates `SHOPIFY_ALLOW_SPLIT_BILLING` and the entire
  `SHOPIFY_CONNECTOR_ADDON` policy.
- Do not request an access scope nothing consumes — App Store review rejects it,
  as `shopify.app.toml` already notes.

---

## 6. Checklist

| Step | Needed for | Blocking? |
|---|---|---|
| Decide which app carries the plans | both | **yes** |
| Confirm App Pricing supports non-embedded apps | app_pricing | **yes** |
| Get Shopify's answer on split billing | connector_addon | **yes** for that policy |
| Create plans, record handles | app_pricing | yes |
| Create usage meters, record handles | metered billing | only for usage |
| Partner API token + org id + app id | app_pricing | **yes** |
| App Events client id/secret | metered billing | only for usage |
| Set `SHOPIFY_APP_HANDLE` | app_pricing | yes |
| Configure redirect URL | app_pricing | yes |
| Add a scope + token storage to the Chat app | manual | yes for manual |
| Subscribe `app_subscriptions/update` | manual | yes for manual |
| Create development stores in the same org | testing | recommended |
