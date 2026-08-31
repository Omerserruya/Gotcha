# Shopify billing — developer guide

How the pieces fit, and what happens in each customer flow.

Related: [architecture assessment](./shopify-billing-architecture-assessment.md) ·
[implementation plan](./shopify-billing-implementation-plan.md) ·
[Partner Dashboard steps](./shopify-partner-dashboard-setup.md) ·
[rollout and rollback](./shopify-billing-rollout.md) ·
[config example](./shopify-billing.env.example)

---

## The one rule

**Entitlements change only after an authoritative read from the provider.**

Not after a merchant clicks a plan. Not after a return URL is hit. Not after a
webhook body arrives. `syncProviderSubscription()` is the only function that
grants or revokes Shopify-funded access, and the only thing it trusts is
`BillingSourceProvider.fetchSubscription()`.

Under Shopify App Pricing this is not caution, it is the only mechanism that
exists: since **2026‑04‑28** Shopify sends **no** subscription webhooks and no
longer appends `charge_id` to the redirect. The merchant comes back carrying
`plan_handle` and `shop`, which is a prompt to go and check — never evidence.

---

## The layers

```
  product code
      │  isEntitled(tenantId, "shopify_order_actions")
      ▼
  entitlement service            packages/shared/src/lib/billing/
      │  ← unchanged. Knows nothing about billing sources.
      ▼
  BillingSourceProvider          services/billing/src/billing-sources/
      │   who COLLECTS the money
      ├── GOTCHA_EXTERNAL ──► PaymentProvider registry (iCount)
      ├── SHOPIFY         ──► app-pricing.source.ts | manual-billing.source.ts
      └── EXEMPT / FREE   ──► charges nothing
```

`PaymentProvider` (tokenize → charge → refund) sits *below* this and is
untouched. Shopify cannot implement it — it moves the money itself, so there is
no token to store and no charge to submit.

### Where things live

| | |
|---|---|
| `billing-sources/source.ts` | the port |
| `billing-sources/capabilities.ts` | `verified` / `unverified` / `unsupported`, fails closed |
| `billing-sources/index.ts` | registry; resolves SHOPIFY **per call**, not at import |
| `billing-sources/shopify/config.ts` | flags and modes; anything unacknowledged degrades to `mock` |
| `services/billing-policy-resolver.service.ts` | which commercial arrangement applies |
| `services/provider-subscription.service.ts` | connections, verified activation, uninstall, reconciliation |
| `services/usage-ledger.service.ts` | record → route → dispatch |

---

## Flow A — direct GOTCHA customer, no Shopify

**Unchanged.** Subscription is created through the existing checkout, its
`billingSource` defaults to `GOTCHA_EXTERNAL`, entitlements come from the plan,
usage settles through PAYG. No `ProviderSubscription`, no `CommerceConnection`,
no Shopify records of any kind.

The `GotchaExternalBillingSource` adapter adds **no behaviour** — it reads
existing state so callers can ask one question instead of branching.

## Flow B — an existing workspace connects Shopify

Connecting on day one and connecting a year later are the same path.

1. An authenticated user starts the Shopify install; OAuth completes and is
   verified by the existing `services/ai` flow.
2. `linkCommerceConnection()` attaches the verified shop, keyed on the
   **immutable numeric shop id** — never the myshopify domain, which a merchant
   can rename. It lands in **`BILLING_PENDING`**, never `CONNECTED`: OAuth
   finishing proves an install, not a payment.
3. `resolveAndRecordBillingPolicy()` runs server-side and writes an audit row.

The decision:

| Policy | What happens |
|---|---|
| `SHOPIFY_CONNECTOR_ADDON` | External Core stays; merchant is sent to Shopify plan selection; Shopify entitlements stay pending. Requires `SHOPIFY_ALLOW_SPLIT_BILLING` — **refuses without it**, because that combination is exactly the double-charge. |
| `FULL_SHOPIFY` | Sent to plan selection. Nothing payment-gated activates until confirmed. If an external subscription exists, `requiresMigrationReview` is recorded and **nothing is cancelled**. |
| `GRANDFATHERED_EXTERNAL` | External subscription kept, no Shopify subscription created, evidence preserved. Needs both `SHOPIFY_ALLOW_GRANDFATHERED` **and** an active external subscription. |
| `UNRESOLVED` | The default. Connection stays `BILLING_PENDING`, nothing is charged, nothing is granted. |

4. `syncProviderSubscription()` verifies with the provider and moves
   entitlements to match.

## Flow C — merchant arrives from the App Store

Same as B from step 2, with two differences: `acquisitionSource` is recorded at
install (it cannot be reconstructed later, and the policy resolver reads it),
and if no workspace exists one must be created through normal onboarding.

**A shop is never linked to a workspace on an unverified email match.** The
only link is `linkCommerceConnection()`, guarded by a unique index on
`(platform, externalShopId)`; a shop another workspace holds raises
`CrossTenantShopClaimError` and is **never** moved.

---

## Subscription lifecycle

Shopify's `AppSubscriptionStatus` → ours, keeping the raw string in
`providerStatusRaw` because mapping is lossy.

| Shopify | Ours | Notes |
|---|---|---|
| `PENDING` | `PENDING` | awaiting approval |
| `ACTIVE` | `ACTIVE` | grants access |
| `DECLINED` | `DECLINED` | terminal — the merchant refused |
| `EXPIRED` | `EXPIRED` | terminal — **not approved within two days**; the abandoned-selection case |
| `FROZEN` | `FROZEN` | non-payment; **Shopify reactivates it itself** |
| `CANCELLED` | `CANCELLED` | terminal |
| *anything else* | `REQUIRES_ACTION` | never guessed either way |

Two mappings are worth stating explicitly because getting them wrong is
expensive:

- **`FROZEN` is not our `SUSPENDED`.** Shopify recovers a frozen subscription
  by itself once payments resume. `SUSPENDED` means dunning is exhausted and a
  human must act. Access stops during `FROZEN`, but **nothing is deleted** and
  it returns on its own.
- **`EXPIRED` is not `CANCELLED`.** It is a merchant who never answered, which
  wants different follow-up from one who refused or one who left.

**Auto-renewal:** Shopify owns renewal and collection entirely. GOTCHA never
charges an external payment method for a Shopify-billed subscription — the
routing that guarantees this is on the ledger row, described below. Externally
billed subscriptions keep their existing renewal, dunning and grace behaviour
untouched.

---

## Usage and PAYG

```
  recordUsage()          → local DB write, no network, safe inside a transaction
  dispatchPendingUsage() → outside any transaction, network, retried
```

**The invariant: the same unit is never charged by two providers.** It is
structural, not a matter of discipline: `billingSource` is decided **once**,
when the row is written, and the dispatcher only ever sends a row to the source
that row already names. No code path asks "who should bill this?" at dispatch
time, because a question asked twice can be answered differently twice.

The second guard is `idempotencyKey`, unique in the database and capped at **64
characters at record time** because that is Shopify's limit — a unit that could
never be dispatched should not be recordable as dispatchable. Shopify enforces
its own copy of the key permanently, so the two defences agree by construction.

A key recorded for one source and later claimed for another logs
`[usage][conflict]`; the first attribution wins and no second charge occurs.

**Reversal** is a new row with a negative quantity under a new key — what an
append-only ledger requires and what Shopify's App Events API accepts.
Reversing something never dispatched refuses to credit a charge never made.

**Caps** and disabled integrations produce `SKIPPED` with a stated reason, not
errors. The usage happened and reporting needs it; it just must not reach a
provider.

**Retries** back off exponentially and dead-letter into `FAILED` after 8
attempts — visibly, because making lost revenue disappear is worse than leaving
a row to look at. A `4xx` other than `429` is treated as permanent and stops
immediately.

---

## Uninstall, cancellation, reinstall

**Verified `app/uninstalled`** → `handleCommerceUninstall()`: connection
`DISCONNECTED`, provider subscription `CANCELLED` (kept, not deleted),
Shopify-funded entitlements revoked.

It touches **nothing else** — not the workspace, not the external subscription,
not WhatsApp, Instagram or WooCommerce. A merchant removing the Shopify app has
said something about Shopify and nothing about their phone number. No data is
deleted; retention is a separate, policy-driven path.

**Cancellation without uninstall** → the next verified read reports a terminal
status, Shopify entitlements stop, the connection returns to
`BILLING_PENDING`, and the app connection itself is preserved.

**Reinstall** → `linkCommerceConnection()` finds the existing row by shop id,
clears `uninstalledAt`, and returns it to `BILLING_PENDING` — **never straight
to `CONNECTED`**. A reinstall proves nothing about whether the previous
subscription is still alive; only a fresh verified read decides that.

---

## Reconciliation

`reconcileProviderSubscriptions()` runs as a stage in the existing billing
scheduler tick. It re-reads every mirrored subscription from the provider and
moves entitlements to match.

Under App Pricing it is **not** a repair mechanism for missed webhooks — there
are none — so **its cadence is how quickly a cancellation, freeze or
reactivation is noticed.**

Two properties are load-bearing and both are tested:

- **A provider outage never revokes.** A thrown error is not "no subscription".
  "We could not ask" and "they are not paying" are different facts.
- **One failure never aborts the sweep.** Otherwise a single bad shop would
  leave everything after it unchecked.

---

## Security notes

- Shop lookup is scoped by tenant; cross-tenant attachment is refused by a
  database unique index and never silently merged.
- The shop's identity is its **immutable numeric id**, never a user-supplied
  domain.
- Billing never holds a merchant's Admin token. App Pricing uses an
  organisation-level Partner credential; the manual path asks `services/ai`,
  which owns the token, to make the call.
- No provider error body is echoed into an exception message, and no response
  body is logged — an auth failure is exactly where a credential could come
  back at you.
- Every policy decision is written to `BillingPolicyDecision` with its evidence
  and the code and config versions that produced it.

## Testing

`SHOPIFY_BILLING_ENV` defaults to `mock`, which performs **no network call**,
so the suite can never create a real charge. `live` additionally requires
`SHOPIFY_ALLOW_LIVE_BILLING=true`.

A mock App Pricing stack deliberately returns **no** subscription from
`fetchSubscription` — a mock that invented an ACTIVE contract would let the
activation path pass its tests without ever proving it checks anything.

```bash
# billing (integration tests, real dev database)
cd services/billing && npx vitest run

# shared
npm run test -w @chatcenter/shared

# note: docker-compose does not publish redis to the host
export REDIS_URL="redis://$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' chatcenter-redis-1):6379"
```
