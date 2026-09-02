# Shopify billing — the confirmed model

Supersedes the open commercial questions in
[shopify-billing-implementation-plan.md](./shopify-billing-implementation-plan.md).
Shopify App Review has confirmed the split, so the code no longer has to support
every possible policy — but it still does, because the flags that made that
possible are what let this ship disabled.

---

## 1. What was confirmed

**GOTCHA Core stays externally billed by GOTCHA.** Plans: Co-Pilot, AI Team,
Call-Pilot, Custom. Core covers the platform, the non-Shopify channels, team
limits, AI employees, credits and voice.

**Shopify billing is a separate charge** granting Shopify-related functionality.
Likely one connector subscription to start, but the architecture supports many
public and private plans.

This is **split billing**, which the plan listed as its first open question.
`SHOPIFY_ALLOW_SPLIT_BILLING` is therefore now a real option rather than a
placeholder — it still defaults to `false`, because a confirmed policy and a
configured deployment are different things.

### Still not decided, and deliberately not in code

Prices, currencies, trial lengths, the final plan count, and the publication
date. None of these appear in any TypeScript file. Prices and trials belong to
Shopify and are read back from it; the publication date is
`SHOPIFY_APP_PUBLICATION_CUTOFF`; the plan set is
`SHOPIFY_BILLING_PLAN_CATALOG`.

---

## 2. The three scenarios, and why there is only one code path

| | Merchant | Billing outcome |
|---|---|---|
| **A** | Paid GOTCHA **before** publication, installs Shopify later | No Shopify charge. Grandfathered. |
| **B** | Subscribes to Core **after** publication, connects Shopify from inside GOTCHA | Shopify subscription required. |
| **C** | Installs from the App Store | Shopify subscription required, unless grandfathered. |

All three enter `onShopifyConnected()` identically. **Acquisition source is
recorded and never read by the decision.** The only thing separating them is
evidence: whether the workspace was already paying GOTCHA before the cutoff.

`shopify-billing-flow.integration.test.ts` runs the same fixture through
`app_store`, `in_app_connect` and `admin` and asserts one answer, which is what
stops a well-meaning "App Store users are different" branch from appearing.

---

## 3. Ordering — OAuth always wins

```
Shopify install  →  HMAC verified  →  OAuth  →  store linked  →  billing decided
                                                                 ↑
                                              nothing here can retract the above
```

`onShopifyConnected` runs **after** the store is linked and can only decide what
the merchant is shown next. Every failure inside it is soft: a billing service
that is down leaves the store connected, the entitlements off, and the merchant
on the ordinary connected screen. An app that put a payment screen in front of
Shopify's authorization would fail review, and a half-completed install would
leave a store authorized on Shopify's side and unknown on ours.

The one exception is a cross-tenant claim, surfaced as a 409, because "this
store belongs to another workspace" must be told rather than retried past.

---

## 4. States

Derived, never stored. Computed from three tables that each have exactly one
writer, so there is no column to go stale.

| State | Meaning | Access |
|---|---|---|
| `UNRESOLVED` | Billing off, or no policy configured | off |
| `NOT_REQUIRED_GRANDFATHERED` | Paid GOTCHA before publication | **on** |
| `PLAN_SELECTION_REQUIRED` | No subscription; also a declined one | off |
| `APPROVAL_PENDING` | Shopify has an unapproved charge | off |
| `ACTIVE` / `TRIALING` | Shopify confirmed it | **on** |
| `PAST_DUE` | Shopify reports a failed charge | off |
| `FROZEN` | Shopify froze the store | off |
| `CANCELLED` | Subscription ended | off |
| `UNKNOWN_PLAN` | Shopify confirmed a subscription; the catalog cannot identify the plan | **no new grant, no revoke** |
| `ERROR` | A status we cannot interpret | off (fail-closed) |

**`UNKNOWN_PLAN` is our fault, not the merchant's.** Shopify says somebody is
paying and the local catalog cannot say what they bought. Both obvious
responses are wrong: granting the full set turns an unconfigured handle into a
way to widen access without review, and revoking cuts off a demonstrably paying
merchant because *our* config is wrong — during a bad deploy, that is an outage
for every paying store at once. So nothing new is granted, nothing already
verified is revoked, the handle is recorded on the row
(`metadata.configurationError = "unknown_plan"`, `metadata.unknownPlanHandle`)
and logged for an operator, and the next reconciliation pass repairs it once the
catalog is corrected. The connection stays `BILLING_PENDING`, never `CONNECTED`.

**Never-subscribed is not `CANCELLED`.** A verified read that finds nothing
stores `CANCELLED` with a null provider id — that is the honest storage shape,
because "we asked and there is none" deserves a `lastVerifiedAt`. Reporting it
to a merchant as "your subscription ended" would be a lie to somebody who never
had one, and it would strand them: `CANCELLED` offers no route to a plan page.
The absent provider id tells the two apart.

---

## 5. Grandfathering

**The rule:** the workspace's GOTCHA subscription started being **paid** before
`SHOPIFY_APP_PUBLICATION_CUTOFF`.

Both halves have been got wrong before:

- **"started being paid", not "was created."** An account opened in January that
  first paid in November is a new customer commercially. Reading
  `tenant.createdAt` — one join closer, and the obvious shortcut — would
  grandfather them. `tenant.createdAt` is stored in the evidence blob as
  *context* and never compared against the cutoff, and there is a test asserting
  exactly that.
- **An unset cutoff grandfathers nobody.** Never everybody.

### Evidence ladder

| Rank | Source | Quality |
|---|---|---|
| 1 | `Invoice.paidAt` — money arrived | `CONFIRMED` |
| 2 | `SubscriptionEvent` → ACTIVE/TRIALING | `CONFIRMED` |
| 3 | `Subscription.createdAt` while paying | `INFERRED` |

### Properties

- **Idempotent.** `ShopifyGrandfatherGrant.tenantId` is unique. A reinstall
  finds the standing grant rather than re-deciding against whatever flags are
  set that day.
- **Auditable.** The grant stores the evidence, which row produced it, and the
  cutoff *in force at the time* — the configured value can move, and a grant has
  to stay explainable against the rule that made it.
- **Revocable, attributably.** Revocation requires a named actor and is never
  silently undone by a reinstall.
- **Admin override**, `SYSTEM_ADMIN` only, stamped `ADMIN_OVERRIDE` and
  `REVIEW_REQUIRED`, with `approvedBy` taken from the authenticated user rather
  than the request body. It also stores what the automatic rules concluded, even
  though it overrode them.
- **Development stores are not grandfathered automatically** unless
  `SHOPIFY_GRANDFATHER_DEV_STORES=true`.

Grandfathered capability is stamped `EntitlementSource.SHOPIFY_GRANDFATHERED`
and funded by `EXEMPT`, **not** `SHOPIFY_SUBSCRIPTION`.
`revokeShopifyEntitlements` deletes by the latter, so one shared value would let
a lapsed charge cut off the people who were promised they would never pay.

---

## 5a. Startup validation

`assertShopifyBillingConfig()` runs before the service accepts traffic and
**accumulates** every problem into one error. First-problem-wins turns
configuring a deployment into a guessing game played one restart at a time.

| Condition | Required |
|---|---|
| Billing disabled | nothing |
| `app_pricing`, any env **including mock** | `SHOPIFY_APP_HANDLE`, at least one sellable plan in `SHOPIFY_BILLING_PLAN_CATALOG` |
| `app_pricing`, `test` or `live` | additionally **all three** of `SHOPIFY_PARTNER_API_TOKEN`, `SHOPIFY_PARTNER_ORGANIZATION_ID`, `SHOPIFY_PARTNER_APP_ID` |
| `manual`, any env | none of the above |

Mock is exempt from Partner API credentials **only** because it performs no
network call and can neither create nor verify a real subscription —
`isShopifyBillingMock()` short-circuits every client. It is **not** exempt from
the catalog: without one, a merchant can approve a charge this deployment
cannot interpret and would be billed without receiving access.

Errors name variables, never values.

---

## 6. Environment variables

Names, and whether each is required. **No values here.**

| Variable | Purpose | Default |
|---|---|---|
| `SHOPIFY_BILLING_ENABLED` | Master switch | `false` |
| `SHOPIFY_BILLING_MODE` | `app_pricing` \| `manual` | unset → disabled |
| `SHOPIFY_BILLING_ENV` | `mock` \| `test` \| `live` | `mock` |
| `SHOPIFY_ALLOW_LIVE_BILLING` | Separate acknowledgement for `live` | `false` |
| `SHOPIFY_BILLING_POLICY_MODE` | `connector_addon` for the confirmed model | unset → `UNRESOLVED` |
| `SHOPIFY_ALLOW_SPLIT_BILLING` | Required by `connector_addon` | `false` |
| `SHOPIFY_ALLOW_GRANDFATHERED` | Lets the resolver reach a grant | `false` |
| **`SHOPIFY_APP_PUBLICATION_CUTOFF`** | ISO 8601. The grandfathering line | unset → nobody eligible |
| **`SHOPIFY_GRANDFATHER_DEV_STORES`** | Opt in for testing | `false` |
| **`SHOPIFY_BILLING_PLAN_CATALOG`** | JSON plan catalog | unset → nothing sellable |
| `SHOPIFY_BILLING_PLAN_HANDLES` | Minimal form: productKey → handle | unset |
| `SHOPIFY_APP_HANDLE` | Builds the plan-selection URL | unset |
| `SHOPIFY_PARTNER_API_TOKEN` | **Secret.** App Pricing verification | unset |
| `SHOPIFY_USAGE_BILLING_ENABLED` | Metered dispatch. **Not implemented** | `false` |

Bold rows are new in this round. All are declared in `docker-compose.yml` **and**
`docker-compose.prod.yml`, which `env-wiring.test.ts` enforces.

### Catalog shape

```json
[
  {
    "key": "SHOPIFY_CONNECTOR",
    "productKey": "shopify_connector",
    "handle": "<handle from the Partner Dashboard>",
    "visibility": "public",
    "enabled": true,
    "interval": "monthly",
    "rank": 1,
    "entitlements": ["shopify_catalog_sync", "shopify_order_read"],
    "restrictedToShops": []
  }
]
```

`restrictedToShops` is how a private plan and a store-specific arrangement are
expressed. There is deliberately **no price, currency or trial field** — Shopify
owns all three, and a copy here would eventually disagree with what the merchant
was shown and charged. A test asserts the parsed shape carries none of them.

---

## 7. Routes

| Method | Path | Auth |
|---|---|---|
| GET | `/api/billing/shopify/state` | member |
| GET | `/api/billing/shopify/plans` | member |
| POST | `/api/billing/shopify/plan-selection` | `settings:billing:manage` |
| POST | `/api/billing/shopify/complete` | `settings:billing:manage` |
| POST | `/api/billing/shopify/grandfather/evaluate` | `settings:billing:manage` |
| GET/POST/DELETE | `/api/admin/billing/shopify/grandfather/:tenantId` | **SYSTEM_ADMIN** |
| POST | `/api/internal/billing/shopify/connected` | `X-Internal-Key` |
| POST | `/api/internal/billing/shopify/uninstalled` | `X-Internal-Key` |
| GET | `/api/internal/billing/shopify/state/:tenantId` | `X-Internal-Key` |

**Frontend return page: `/integrations/shopify/billing/complete`.**

This is the App Pricing return URL. It renders **no outcome of its own**:
it POSTs to `/api/billing/shopify/complete`, which re-reads the subscription
from Shopify, persists status and plan handle, moves entitlements, and returns
the freshly computed state. Reaching the URL proves nothing — a merchant who
declined can reach it from history, and anyone can type it.

The `shop` parameter is forwarded only so the server can **reject** a return
naming a store the session does not own. It is a guard, never a credential.

---

## 8. Testing on a development store

### 8.1 Configure

```bash
SHOPIFY_BILLING_ENABLED=true
SHOPIFY_BILLING_MODE=manual          # or app_pricing once a Partner token exists
SHOPIFY_BILLING_ENV=test             # NOT live; no SHOPIFY_ALLOW_LIVE_BILLING
SHOPIFY_BILLING_POLICY_MODE=connector_addon
SHOPIFY_ALLOW_SPLIT_BILLING=true
SHOPIFY_APP_HANDLE=<the app handle>
SHOPIFY_BILLING_PLAN_CATALOG='[{"key":"SHOPIFY_CONNECTOR","handle":"<plan handle>","entitlements":["shopify_catalog_sync","shopify_order_read"]}]'
```

Shopify applies **$0 to development stores**, so no real charge occurs. Leave
`SHOPIFY_ALLOW_LIVE_BILLING` unset: `live` degrades to `mock` without it, which
is the intended safety net.

### 8.2 Scenario B/C — a merchant who must pay

1. Install from the Partner Dashboard (see
   `docs/setup/shopify-install-flow.md` §7 for the install itself).
2. After OAuth, expect a redirect to
   `https://admin.shopify.com/store/<store>/charges/<app>/pricing_plans`.
3. Approve. Shopify returns to `/integrations/shopify/billing/complete`.
4. Expected: verification runs, then a redirect to
   `/settings/business-systems?connected=shopify`.

```sql
-- Read-only. Never SELECT *: neighbouring tables hold encrypted tokens.
SELECT ps.status, ps.provider_status_raw, ps.provider_plan_handle,
       ps.current_period_end, ps.last_verified_at
FROM provider_subscriptions ps
WHERE ps.tenant_id = '<tenant>' AND ps.billing_source = 'SHOPIFY';

SELECT entitlement_key, source, funded_by_billing_source
FROM tenant_entitlements WHERE tenant_id = '<tenant>';
```

Expect `source = 'SHOPIFY_SUBSCRIPTION'` and
`funded_by_billing_source = 'SHOPIFY'`.

### 8.3 Scenario 7 — decline

Decline the charge on Shopify. Expect: the connection **stays**, the state is
`PLAN_SELECTION_REQUIRED` with `declined: true`, and no entitlement rows.

### 8.4 Scenario A — grandfathered

Set `SHOPIFY_ALLOW_GRANDFATHERED=true` and a cutoff **after** the workspace's
first paid invoice. Reinstall. Expect: **no** redirect to a plan page, and

```sql
SELECT source, reason, paid_since, paid_since_evidence, cutoff_at, evidence_quality
FROM shopify_grandfather_grants WHERE tenant_id = '<tenant>';
```

one row, `source = 'AUTOMATIC'`. Entitlements carry
`source = 'SHOPIFY_GRANDFATHERED'`, `funded_by_billing_source = 'EXEMPT'`.

To prove the dev-store guard, leave `SHOPIFY_GRANDFATHER_DEV_STORES` unset: a
partner development store is refused with
`development_store_not_auto_grandfathered`.

### 8.5 Uninstall and reinstall

Uninstall. Expect the connection `DISCONNECTED`, Shopify-funded entitlements
gone, and **Core untouched**. Reinstall: the same row is reused, never
duplicated, and a revoked grant is **not** silently re-granted.

### 8.6 The forged return

```bash
curl -X POST "https://<host>/api/billing/shopify/complete?shop=someone-else.myshopify.com&charge_id=999&status=active" \
  -H "Authorization: Bearer <token>"
# => 409 shopify_shop_mismatch
```

No parameter grants anything. The verified read decides.

---

## 9. Partner Dashboard

| Field | Value |
|---|---|
| App URL | `https://app.gotcha.co.il/api/connectors/shopify/install` |
| Redirect URL | `https://app.gotcha.co.il/api/connectors/shopify/oauth/callback` |
| **App Pricing return URL** | `https://app.gotcha.co.il/integrations/shopify/billing/complete` |
| Distribution | **Public.** Never Custom — irreversible, and it forecloses App Store billing |

**Do not create live plans yet.** The catalog reads handles from configuration,
so plans can be created and wired without a deploy.

---

## 10. Not implemented, on purpose

- **Usage / PAYG billing.** `SHOPIFY_USAGE_BILLING_ENABLED` exists and the ledger
  is built, but no App Events are dispatched. The GOTCHA credit and auto-top-up
  system is untouched.
- **Cancelling a Shopify subscription from GOTCHA.** Shopify owns it. We mirror.
- **A renewal engine.** Shopify manages renewal and trials; we reflect state.
- **Custom distribution.** Explicitly out of scope.
