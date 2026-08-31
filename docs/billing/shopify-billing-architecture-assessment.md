# Shopify Billing — repository architecture assessment

Written on branch `feature/shopify-billing`, against `origin/main` @ `2a1d00c0`.

This is the "what is actually here" document. The plan that follows from it is
[shopify-billing-implementation-plan.md](./shopify-billing-implementation-plan.md).

The headline: **GOTCHA already has a mature, provider-neutral billing domain.**
The task is not to build one. It is to add a second *billing source* to a system
whose money model currently assumes exactly one, and to do that without
disturbing the iCount path that is taking real money today.

---

## 1. Where things live

npm workspaces: `packages/*`, `services/*`, plus top-level `gateway/` and
`frontend/`. Postgres via Prisma; Redis + BullMQ; Next.js frontend; services talk
over Docker DNS + HTTP (`http://billing:4009`).

| Concern | Location |
|---|---|
| Money state, provider webhooks, schedulers | `services/billing` |
| Entitlement + wallet **read models** | `packages/shared/src/lib/billing/` |
| Prisma schema (7,044 lines) | `packages/shared/prisma/schema.prisma` |
| All Shopify server code | `services/ai` |
| Shopify primitives shared across services | `packages/shared/src/lib/shopify-*.ts` |
| Shopify app manifests | `shopify-app/shopify.app*.toml` |
| Billing UI | `frontend/src/app/settings/billing/**`, `frontend/src/app/checkout/**` |

`CLAUDE.md` sets hard constraints that shape everything below:

- **No new microservices.** Billing work goes in `services/billing`.
- **No new dependencies.** No `@shopify/shopify-api`; the Shopify billing client
  must be built from what is already here (`axios`, or the existing fetch-based
  Shopify code).
- **No half-work** — UI *and* backend.
- **Main is sacred**; PR-based merges only.

---

## 2. The billing domain that already exists

### 2.1 The payer abstraction is already correct

`BillableEntity` is the payer, and money models reference `billableEntityId`,
never `tenantId`. `BillableEntityTenant.tenantId` is `@unique` today, which is
the deliberate V1 restriction ("one entity per tenant") that can be relaxed
later. **Nothing needs redesigning here.**

### 2.2 The entitlement service already exists and is already the right shape

`packages/shared/src/lib/billing/`:

- `entitlement-resolver.ts` — `isEntitled(tenantId, featureKey)`,
  `assertEntitled`, `resolveEntitlements`, `resolveLimit`, `assertWithinLimit`,
  `EntitlementDeniedError`.
- `entitlement-gate.ts` — `checkPaidAccess()` / `assertPaidAccess()`, which
  composes "is this organization in good standing" **and** "does their plan
  include this". Three modes: `off | audit | enforce`, with
  `assertEnforcementConfigured()` refusing to boot on a fail-open config.
- `entitlements.ts` — `materializeEntitlements(tenantId)` projects plan →
  `TenantEntitlement` rows.

Product code already asks the entitlement service rather than reading
subscription fields. **The prompt's requirement here is already satisfied**; the
work is to make entitlements aware of *which provider funded them*, without
changing a single call site.

### 2.3 Provider abstraction exists — but it is the wrong *layer* for Shopify

`services/billing/src/providers/provider.ts` defines `PaymentProvider`:

```
tokenizeAndVerify() · charge() · refund() · verifyWebhook()
startTokenization() · listStoredCards() · lookupTransactions()
```

This is a **card-tokenization** contract: we hold a token and we move money.
`services/billing/src/providers/index.ts` registers `ICOUNT`, `MANUAL`, and a
`STRIPE` slot currently aliased to `manualProvider`.

**Shopify cannot implement this interface.** Shopify owns the money end to end:
there is no token to store, no charge for us to submit, no refund for us to
issue. Forcing `SHOPIFY` into `PaymentProvider` would mean five methods that
throw, and `getCapabilities("SHOPIFY")` returning mostly `unsupported` — which
`assertCapability` would then correctly refuse, making the provider unusable.

The correct move is a **second, higher port** — subscription/billing-source —
that sits above `PaymentProvider` rather than beside it. `GOTCHA_EXTERNAL`
delegates down to the existing `PaymentProvider` registry; `SHOPIFY` talks to
Shopify. Entitlement logic sees neither.

There is already a strong precedent to copy: `providers/capabilities.ts` encodes
capabilities as `verified | unverified | unsupported` and **fails closed on
anything not verified**. Shopify's adapter should declare its capabilities the
same way — which is exactly how the "we have not heard back from Shopify yet"
problem gets represented in code instead of in a comment.

### 2.4 The pieces the prompt asks for that already exist

| Prompt asks for | Already in the repo |
|---|---|
| Billing account | `BillableEntity` + `BillableEntityTenant` |
| Subscription | `Subscription`, `SubscriptionEvent`, `PendingSubscriptionChange` |
| Entitlement service | `entitlement-resolver.ts` + `entitlement-gate.ts` |
| Usage ledger | `PaygAccrual` (+ `AiUnitLot` / `AiUnitLedgerEntry`, `UsageLog`) |
| Provider event store | `ProviderBillingEvent` (redacted payload, hash dedupe) |
| Webhook idempotency | `BillingWebhookEvent` (`providerEventId @unique`) |
| Reconciliation | `services/billing/src/services/reconciliation.service.ts` |
| Grandfathering | `grandfather.service.ts` + `SubscriptionStatus.GRANDFATHERED` |
| PAYG + caps | `payg.service.ts`, `AutoPurchasePolicy`, `AutoPurchaseLimitBehavior` |
| Dunning / retries | `dunning.service.ts`, `DunningState` |
| Commerce connection | `TenantIntegration` + `IntegrationCatalog` |
| Audit log | `AuditLog` |
| Token encryption | `encryptCredentials` (channel key); `payment-token-crypto.ts` (own key) |

**Do not rebuild any of these.**

### 2.5 The four structural blockers

These are the only places the existing schema genuinely resists what is being
asked for.

1. **`Subscription.billableEntityId` is `@unique`.** One subscription per payer.
   `SHOPIFY_CONNECTOR_ADDON` needs two concurrent subscriptions (external Core +
   Shopify connector). This unique constraint is the single biggest blocker to
   split billing.

2. **`Subscription` has no provider column.** Provider lives on
   `BillingProfile.provider`, and `BillingProfile.billableEntityId` is `@unique`
   — so provider is a property of the *payer*, not of the subscription. Billing
   source cannot currently vary below the payer level, which is precisely what
   the requirement demands.

3. **`SubscriptionStatus` does not cover Shopify's lifecycle.** Ours is
   `PENDING · TRIALING · ACTIVE · PAST_DUE · SUSPENDED · CANCELED · PAUSED ·
   GRANDFATHERED`. Shopify's `AppSubscriptionStatus` is `PENDING · ACTIVE ·
   DECLINED · EXPIRED · FROZEN · CANCELLED`. `FROZEN`, `DECLINED` and `EXPIRED`
   have no home, and mapping `FROZEN → SUSPENDED` would lose the fact that
   Shopify will reactivate it by itself when the merchant pays.

4. **`TenantEntitlement` has no funding link.** `@@unique([tenantId,
   entitlementKey, source])` with no subscription or provider reference. Nothing
   records *which* subscription paid for an entitlement, so nothing can revoke
   exactly the Shopify-funded ones when a Shopify subscription lapses while
   leaving externally-funded ones alone. `EntitlementSource` is the natural
   extension point.

---

## 3. The Shopify estate as it stands

There are **two distinct Shopify apps**, and confusing them is the main way this
work could break production.

| | **Core integration** | **Chat app** |
|---|---|---|
| Purpose | Product/order truth for the AI | Storefront live-chat widget |
| Credential | `SHOPIFY_API_KEY`, per-tenant token in `TenantIntegration.credentials` | `SHOPIFY_CHAT_APP_*`; `ShopifyChatInstallation.accessToken` |
| Scopes | `read_products`, `read/write_orders`, `read_customers`, price rules, returns | **`scopes = ""` — empty by design** |
| Embedded | n/a | `embedded = false`, no App Bridge, no session tokens |
| Manifest | not in this repo | `shopify-app/shopify.app.toml` |

`shopify.app.toml` carries a loud warning that deploying it against the Core
Partner app would strip Core's scopes from every connected store, and
`scripts/shopify/verify-chat-app-identity.mjs` refuses CLI commands when the
linked client id is wrong. **Any Partner Dashboard step in this work must name
which of the two apps it applies to.**

Other relevant facts:

- **API version is centralised** in
  `packages/shared/src/lib/shopify-api-version.ts`, pinned to **`2026-07`**,
  overridable by `SHOPIFY_API_VERSION`, with `checkShopifyResponseVersion()`
  comparing every response's `X-Shopify-API-Version` header against what was
  requested. Reuse this; do not add a second version constant.
- **No obsolete REST *billing* code exists** — because **no Shopify billing code
  exists at all**. There is no `appSubscriptionCreate`,
  `RecurringApplicationCharge`, `appUsageRecordCreate` or managed-pricing code
  anywhere in the tree. This is genuinely greenfield on the Shopify side.
- REST *is* still used by the Core adapter for products/orders alongside a
  `shopifyGraphQL()` helper. The version module documents why REST remains legal
  for these apps. **A separate unpushed branch (`fix/autoconnect-stale-state`,
  commit `25581f38`) moves the Admin API to GraphQL and is not in `main`** — per
  your instruction this branch is built against `origin/main`, so it does not
  depend on that work.
- The Chat app already handles `app/uninstalled` plus the three mandatory
  compliance topics (`customers/data_request`, `customers/redact`,
  `shop/redact`) in `services/ai/src/routes/shopify-webhooks.ts`. **That
  implementation must not be disturbed.**
- The Chat app uses an **App Proxy** (`/apps/gotcha-chat`) for signed shopper
  identity.

---

## 4. What Shopify's billing actually offers today

Checked against shopify.dev on **2026-08-31**. This materially changes the design
and some of it is recent enough to be easy to get wrong.

### 4.1 Managed Pricing is now "Shopify App Pricing", and it has no webhooks

- Managed Pricing **has been renamed Shopify App Pricing** and is the default
  for new public apps.
- Plans are configured **in the Partner Dashboard only** — not in
  `shopify.app.toml`, not in code. Plan handles and prices therefore *cannot* be
  version-controlled, only referenced.
- Plan selection is a redirect to
  `https://admin.shopify.com/store/:store_handle/charges/:app_handle/pricing_plans`.
- **After 2026-04-28 — already four months ago — Shopify App Pricing sends no
  webhooks for subscription changes, and no longer appends `charge_id` to the
  redirect.** The old `APP_SUBSCRIPTIONS_UPDATE` topic is gone.
- The redirect returns only `plan_handle` and `shop`. Shopify's own guidance is
  to verify by querying the **Partner API**:
  `activeSubscription(appId:, shopId:)`.

The consequence is large: **for App Pricing, a reconciliation/polling job is not
a safety net, it is the only mechanism.** The prompt's "do not rely exclusively
on webhooks" is, here, "there are no webhooks at all."

It also introduces a dependency GOTCHA does not currently have: a **Partner API
credential**, which is organisation-level rather than per-shop and does not fit
the existing per-tenant token model.

Whether App Pricing supports **non-embedded** apps is **not documented** on any
page checked. Given `embedded = false`, this is an open question, not an
assumption.

### 4.2 The manual GraphQL Billing API remains supported

`appSubscriptionCreate(name, lineItems, returnUrl, test, trialDays,
replacementBehavior)` → `{ appSubscription, confirmationUrl, userErrors }`.

- `AppRecurringPricingInput`: `price`, `interval`, optional `discount`.
- `AppUsagePricingInput`: `terms`, `cappedAmount`.
- `AppPricingInterval`: **`EVERY_30_DAYS`, `ANNUAL`** — note there is no
  "monthly".
- `AppSubscriptionStatus`: **`PENDING`, `ACTIVE`, `DECLINED`, `EXPIRED`,
  `FROZEN`, `CANCELLED`** (plus deprecated `ACCEPTED`).
  - `FROZEN` = "on hold due to non-payment… re-activates after payments resume."
    Shopify recovers this by itself; we must not treat it as cancellation.
  - `EXPIRED` = merchant did not approve within **two days**. That is a real
    deadline for the "merchant abandons plan selection" flow.
  - `DECLINED` and `CANCELLED` are **terminal**.
- Verification uses the shop's own Admin API token
  (`currentAppInstallation { activeSubscriptions }`) — which **does** fit
  GOTCHA's existing per-shop model.

### 4.3 Usage billing: the App Events API

For App Pricing usage meters, billable events go to a **dedicated** API — not
Admin, not Partner:

```
POST https://api.shopify.com/app/unstable/events
Authorization: Bearer <JWT>     # OAuth2 client_credentials, 60-minute lifetime
                                # token endpoint: https://api.shopify.com/auth/access_token
{ shop_id, event_handle, timestamp, idempotency_key, attributes: { value } }
```

- `idempotency_key` — max 64 chars, **"enforced permanently"**. This maps
  directly onto a ledger row's idempotency key.
- `event_handle` must exactly match a Partner-Dashboard-configured meter handle,
  case-sensitively.
- `timestamp` must be inside the current billing cycle and no more than 5
  minutes in the future — so a retry of a stale event **cannot** simply be
  replayed, which the dispatcher has to handle.
- **Corrections are supported**: send a negative `value` with a *new*
  idempotency key, inside the current cycle.
- Limits: up to 5 active usage meters per plan, 6 pricing tiers per meter, and
  usage must be tied to a monthly cycle.
- Development stores incur no real charges.
- The path says **`unstable`** — that is Shopify's own current documented path
  and is worth flagging as a stability risk.

### 4.4 Policy

> "All apps published on the Shopify App Store are required to use a Shopify
> provided billing solution and adhere to the terms and conditions of the
> Shopify Partner Program Agreement."

Nothing on the pages checked explicitly permits **or** forbids split billing.
This is exactly the question outstanding with Shopify, and the code must
therefore not encode an answer.

---

## 5. Conventions this work must follow

**Feature flags.** There is no central flag system, and per `CLAUDE.md` we must
not invent one. The convention is a plain `process.env.X_ENABLED` read, default
**off**, plus a boot-time `assert*Config()` that fails closed (`assertIcountConfig`,
`assertEnforcementConfigured`, `assertPublicUrlConfigured` all run before
`startService`). Existing examples: `ICOUNT_CHECKOUT_ENABLED`,
`ICOUNT_TOKENIZATION_ENABLED`, `ICOUNT_STORED_CARD_CHARGE_ENABLED`,
`BILLING_ENFORCEMENT_MODE`, `PUBLIC_PRICING_ENABLED`.

`services/billing/src/__tests__/env-wiring.test.ts` **enforces that every env var
a service reads is declared in both `docker-compose.yml` and
`docker-compose.prod.yml`.** New flags must be added to both files or the suite
fails. Declaring them with safe, disabled defaults is a repo-config change, not a
change to any live production environment — but it is worth stating plainly.

**Provider modes.** `icount-config.ts` is the template: `mock` (default, no
network) / `simulator` (models declines, timeouts, ambiguous outcomes; opt-in via
`ICOUNT_ALLOW_SIMULATOR`) / `test` / `live`. Anything not explicitly acknowledged
degrades to `mock`. Copy this shape exactly for Shopify.

**Encryption.** `encryptCredentials()` for provider credentials;
`payment-token-crypto.ts` has its own key for card tokens and deliberately shares
with nothing.

**Testing.** Vitest. Billing tests are **integration tests against the real dev
database** with `fileParallelism: false` and a `global-teardown.ts` that sweeps
orphaned `BillableEntity` rows. The suite turns payment capabilities ON via
`vitest.config.ts` while keeping `ICOUNT_MODE` non-networked.

**Frontend.** No shared `ui/` kit — `components/ui/` holds only `Modal.tsx`.
Screens compose local primitives with Tailwind tokens from
`frontend/tailwind.config.ts` (`primary` 50–900 at `#7c5cfc`, `gray-150`, shadow
scale `card/float/subtle/panel/inner-glow`). `CheckoutShell.tsx` backs all seven
checkout states with a `tone` prop (neutral/positive/warning/critical) — that is
the component to reuse for Shopify's billing states.

**Acquisition source.** `ShopifyChatInstallation` records `installedAt`,
`boundAt`, `uninstalledAt` and `appIdentity`; `Tenant` has `createdAt`. There is
**no** dedicated acquisition-source field, so a grandfathering decision cannot
currently be derived from stored evidence alone — which is why the policy
resolver must be able to answer `REVIEW_REQUIRED`.

---

## 6. Baseline state

`origin/main`'s billing suite was **red before this branch existed** — 7 files,
31 tests — and no CI workflow runs vitest (`.github/workflows/` contains only
`security.yml`). Four independent causes, all test-side drift rather than
production defects, are repaired in commit `27eb673b`; see that commit message
for the detail.

Verified green after the repair:

- `services/billing` — **773 passed, 46 files**
- `packages/shared` — **1858 passed, 109 files**
- `tsc --noEmit` clean for both

One environment note: `docker-compose.yml` publishes Postgres (`5432:5432`) but
**declares no `ports:` for redis**, while tests default to
`redis://localhost:6379`. Host-run suites therefore need `REDIS_URL` pointed at
the container. Left as-is rather than changed.
