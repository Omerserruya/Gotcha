# Shopify Billing — implementation plan

Companion to
[shopify-billing-architecture-assessment.md](./shopify-billing-architecture-assessment.md).
Branch `feature/shopify-billing`, based on `origin/main` @ `2a1d00c0`.

## Guiding constraints

From `CLAUDE.md`: no new microservices, **no new dependencies**, UI *and*
backend, main is sacred. From the assessment: the billing domain already exists
and must be extended, not duplicated. From Shopify: the policy question about
split billing is **unanswered**, so the code must support every policy without
choosing one.

Everything ships **disabled by default**. A missing or disabled flag must land in
a non-charging `BILLING_PENDING` state — never in accidental paid access, and
never in a real charge.

---

## Decision 1 — a second port, above `PaymentProvider`, not beside it

`PaymentProvider` (tokenize → charge → refund) is a card-movement contract.
Shopify moves the money itself, so it cannot implement it (assessment §2.3).

Introduce **`BillingSourceProvider`** in
`services/billing/src/billing-sources/`:

```ts
export interface BillingSourceProvider {
  readonly source: BillingSource;                       // GOTCHA_EXTERNAL | SHOPIFY | EXEMPT | FREE
  readonly capabilities: BillingSourceCapabilities;     // verified | unverified | unsupported

  /** Where to send the merchant to choose/approve a plan. Never a charge. */
  beginSubscription(input: BeginSubscriptionInput): Promise<BeginSubscriptionResult>;
  /** Authoritative read. The ONLY thing allowed to activate entitlements. */
  fetchSubscription(ref: ProviderSubscriptionRef): Promise<ObservedSubscription | null>;
  cancelSubscription?(ref: ProviderSubscriptionRef): Promise<void>;
  /** Usage. Absent when the source cannot meter. */
  dispatchUsage?(event: UsageDispatchInput): Promise<UsageDispatchResult>;
  reverseUsage?(event: UsageReversalInput): Promise<UsageDispatchResult>;
}
```

- `GotchaExternalBillingSource` **delegates down** to the existing
  `PaymentProvider` registry. Behaviour for today's customers is unchanged; it is
  a thin wrapper, not a reimplementation.
- `ShopifyAppPricingSource` and `ShopifyManualBillingSource` are two
  implementations behind one `SHOPIFY_BILLING_MODE` switch, so we can move
  between App Pricing and the manual GraphQL Billing API **without touching
  entitlement logic** — which the prompt requires and which the unresolved
  non-embedded question (assessment §4.1) makes genuinely likely.

Capabilities are copied from `providers/capabilities.ts` and **fail closed on
`unverified`**. This is how "Shopify has not confirmed split billing" is
expressed in code rather than in a comment.

## Decision 2 — do NOT relax `Subscription.billableEntityId @unique` in phase 1

Split billing needs more than one subscription per payer. The obvious change —
swap the unique for `@@unique([billableEntityId, billingSource])` — breaks **22
call sites across 11 files** that do `findUnique({ where: { billableEntityId } })`
(`subscription.service.ts`, `dunning.service.ts`, `checkout-activation.service.ts`,
`grandfather.service.ts`, `refund.service.ts`, `poc.service.ts`,
`evaluation.service.ts`, `purchase.service.ts`, `billable-entity.service.ts`,
`routes/internal.ts`, `routes/payment-methods.ts`). That is a large, risky edit
to the path currently taking real money, in service of a policy Shopify has not
confirmed.

**Phase 1 leaves it alone** and adds a separate `ProviderSubscription` table for
subscriptions that a provider *owns* and GOTCHA only *observes*. The distinction
is real, not a workaround: we cannot charge, prorate or cancel a Shopify
subscription, only mirror it.

Reversibility: the new table is purely additive; dropping it restores today's
behaviour exactly. If split billing is confirmed and we later want one unified
table, that is a separate migration that folds `ProviderSubscription` into
`Subscription` — deliberately deferred, not designed out.

---

## Schema changes (all additive)

`packages/shared/prisma/schema.prisma` — new enums:

```
BillingSource            GOTCHA_EXTERNAL | SHOPIFY | EXEMPT | FREE
BillingPolicy            FULL_SHOPIFY | SHOPIFY_CONNECTOR_ADDON
                       | GRANDFATHERED_EXTERNAL | EXTERNAL_ONLY | FREE
                       | UNRESOLVED
PolicyEvidenceQuality    CONFIRMED | INFERRED | UNKNOWN | REVIEW_REQUIRED
ProviderSubscriptionStatus
                         PENDING | TRIALING | ACTIVE | FROZEN | PAST_DUE
                       | CANCELLED | DECLINED | EXPIRED | REQUIRES_ACTION
CommerceConnectionStatus PENDING | CONNECTED | BILLING_PENDING | DISCONNECTED
UsageDispatchStatus      RECORDED | PENDING | DISPATCHED | ACKED | FAILED
                       | SKIPPED | REVERSED
```

New/changed models:

| Model | Purpose |
|---|---|
| `Subscription.billingSource` | New column, default `GOTCHA_EXTERNAL`. Makes today's rows self-describing. No constraint change. |
| `ProviderSubscription` | Provider-owned subscription mirror. `billableEntityId`, `tenantId`, `billingSource`, `providerSubscriptionId`, `providerCustomerId`, `planKey`/`planVersion`, `status`, **`providerStatusRaw`** (never lose the provider's own word), trial/period dates, `cancelAtPeriodEnd`, `commerceConnectionId`, `metadata`. `@@unique([billingSource, environment, providerSubscriptionId])` and `@@unique([billableEntityId, billingSource, productKey])`. |
| `CommerceConnection` | Shopify/Woo/etc. connection **separate from billing**. `tenantId`, `platform`, `externalShopId`, `shopDomain`, `status`, `installedAt`/`uninstalledAt`. `@@unique([platform, externalShopId])` — the constraint that makes cross-tenant shop capture impossible. |
| `BillingPolicyDecision` | Append-only audit: `policy`, `reason`, `acquisitionSource`, `accountCreatedAt`, `cohort`, `grandfathered`, `evidence` (Json), `evidenceQuality`, `decidedAt`, `codeVersion`, `configVersion`. |
| `UsageLedgerEntry` | Canonical append-only usage. `tenantId`, `subscriptionRef`, `entitlementKey`, `metric`, `quantity`, `occurredAt`, **`idempotencyKey @unique`**, `billingSource`, `status`, `providerEventId`, `failureCode`, `attempts`, `reversalOfId`. |
| `BillingOutboxEntry` | Provider calls made durable — never inside a DB transaction. |
| `TenantEntitlement.fundedBy…` | `fundedByBillingSource` + `fundedByProviderSubscriptionId`, nullable. Lets a Shopify lapse revoke exactly the Shopify-funded entitlements and nothing else. |
| `EntitlementSource` | Add `SHOPIFY_SUBSCRIPTION`. |

Migration is one additive SQL migration under
`packages/shared/prisma/migrations/`. Backfill is conservative: existing
subscriptions get `GOTCHA_EXTERNAL`; **nothing is inferred as grandfathered** —
absent evidence yields `UNKNOWN`/`REVIEW_REQUIRED`.

---

## Files to add

```
services/billing/src/billing-sources/
  source.ts                     BillingSourceProvider port + shared types
  capabilities.ts               verified/unverified/unsupported, fails closed
  index.ts                      registry + getBillingSource()
  gotcha-external.source.ts     wraps the existing PaymentProvider registry
  shopify/
    config.ts                   modes + flags, mirrors icount-config.ts
    admin-graphql.client.ts     Admin GraphQL, reuses shopifyApiVersion()
    partner-api.client.ts       activeSubscription(appId:, shopId:)
    app-events.client.ts        POST /app/events, client_credentials JWT
    app-pricing.source.ts       Shopify App Pricing implementation
    manual-billing.source.ts    appSubscriptionCreate implementation
    status-map.ts               AppSubscriptionStatus -> internal, keeps raw
    fake.ts                     deterministic fake for tests

services/billing/src/services/
  billing-policy-resolver.service.ts
  provider-subscription.service.ts
  usage-ledger.service.ts
  usage-dispatch.service.ts
  billing-outbox.service.ts
  shopify-reconciliation.service.ts

services/billing/src/routes/
  shopify-billing.ts            plan-selection start + verified return
  commerce-connections.ts       connection state for the UI

packages/shared/src/lib/billing/
  billing-source.ts             shared read model (source of an entitlement)
  commerce-connection.ts

frontend/src/app/settings/billing/shopify/page.tsx
frontend/src/components/billing/BillingSourceStates.tsx
```

## Files to modify

- `packages/shared/prisma/schema.prisma` + one migration.
- `packages/shared/src/lib/billing/entitlements.ts` — `materializeEntitlements`
  stamps funding; revocation becomes source-scoped.
- `packages/shared/src/lib/billing/entitlement-resolver.ts` — unchanged public
  API. **No call site changes**, which is the point.
- `services/billing/src/index.ts` — mount new routes, `assertShopifyBillingConfig()`
  before `startService`, add the reconciliation stage to `runSchedulerTick`.
- `services/ai/src/routes/shopify-webhooks.ts` — on verified `app/uninstalled`,
  additionally mark the `CommerceConnection` disconnected and disable
  Shopify-funded entitlements. **Existing compliance handling untouched.**
- `docker-compose.yml` **and** `docker-compose.prod.yml` — declare the new vars
  (required by `env-wiring.test.ts`), all disabled.
- `frontend/src/app/settings/billing/page.tsx` — billing-source section.

## Flags (all default off / non-charging)

```
SHOPIFY_BILLING_ENABLED=false
SHOPIFY_BILLING_MODE=app_pricing|manual        # unset => disabled
SHOPIFY_BILLING_POLICY_MODE=full|connector_addon|grandfathered_only
SHOPIFY_ALLOW_SPLIT_BILLING=false              # Shopify has not confirmed this
SHOPIFY_ALLOW_GRANDFATHERED=false
SHOPIFY_USAGE_BILLING_ENABLED=false
SHOPIFY_BILLING_MODE_ENV=mock|test|live        # mock default, never networks
SHOPIFY_ALLOW_LIVE_BILLING=false               # explicit acknowledgement
```

---

## Order of work

1. **Schema + migration**, `BillingSource` on `Subscription`, backfill
   `GOTCHA_EXTERNAL`. Prove the existing 773 billing tests still pass.
2. **`BillingSourceProvider` port + `GotchaExternalBillingSource`.** Behaviour
   change: none. This is the safety net for everything after it.
3. **Entitlement funding attribution** — stamp and revoke by source.
4. **Billing Policy Resolver** + `BillingPolicyDecision` audit, defaulting to
   `UNRESOLVED` → `BILLING_PENDING`.
5. **Shopify adapters** (App Pricing + manual) behind the mode flag, with the
   fake used by tests.
6. **Routes + verified return path.** A return URL is never proof; activation
   only follows `fetchSubscription`.
7. **Usage ledger + outbox dispatch**, single-source routing so one unit is never
   billed twice.
8. **Reconciliation job** in the existing scheduler tick.
9. **Uninstall / cancel / reinstall**.
10. **UI states.**
11. **Tests** for the 23 listed scenarios.
12. **Docs**: developer guide, rollout/rollback, Partner Dashboard steps.

## Open questions — not to be answered in code

1. **Split billing**: permitted? Drives `SHOPIFY_ALLOW_SPLIT_BILLING`.
2. **Non-embedded + App Pricing**: undocumented (assessment §4.1). If
   unsupported, `SHOPIFY_BILLING_MODE=manual` is the answer — which is why both
   adapters exist.
3. **Partner API credential**: App Pricing verification needs an org-level
   Partner API token GOTCHA does not have. The manual Billing API needs only the
   shop's Admin token.
4. **The Chat app requests `scopes = ""`** and stores no access token. The manual
   Billing API needs a token for the shop; App Pricing does not. This may decide
   the mode on its own.
5. **Which app is billed** — Chat or Core? They are separate Partner apps
   (assessment §3) and a plan belongs to exactly one.
6. **Commercial metric** for PAYG, and its Partner-Dashboard meter handle.
