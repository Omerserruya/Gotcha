# Pricing, Plans & Entitlements — Audit and Execution Matrix

**Branch:** `feat/pricing-entitlements` · **Base:** `696cbef` (latest completed Settings + AI Studio + auth HEAD)

This round **extends** the existing billing domain. It does not create a parallel
billing system, a second credit ledger, a second subscription model, or
frontend-only feature gates.

---

## 1. What already exists (reused, not rebuilt)

### Money / subscription spine — `services/billing` (port 4009)

| Component | File | Verdict |
|---|---|---|
| `BillableEntity` / `BillableEntityTenant` | schema | **Reuse.** The payer abstraction. All money keys off `billableEntityId`, never `tenantId`. |
| `Subscription` (+ `planKey`/`planVersion`) | schema | **Extend.** Already version-aware; missing the commercial snapshot. |
| `PendingSubscriptionChange` | schema | **Extend.** Covers scheduled downgrade/cancel; needs UPGRADE + volume targets. |
| `SubscriptionEvent` | schema | **Reuse.** Lifecycle audit trail. |
| `Invoice` / `Charge` / `BillingProfile` / `PaymentMethod` | schema | **Reuse.** iCount is the PCI vault; charges are idempotency-keyed. |
| `BillingWebhookEvent` | schema | **Reuse.** Unique `providerEventId` = replay-proof crediting. |
| `DunningState` + `dunning.service.ts` | service | **Reuse.** |
| iCount / manual providers | `providers/` | **Reuse.** |
| Billing scheduler (trials → renewals → pending → dunning) | `index.ts` | **Extend.** |

### Credit ledger — the single source of truth

| Component | Verdict |
|---|---|
| `AiUnitLot` (INCLUDED / PURCHASED buckets, FIFO, `periodKey`, `expiresAt`) | **Reuse verbatim.** This *is* the credit ledger. |
| `AiUnitLedgerEntry` (GRANT/CONSUME/EXPIRE/ADJUST/REFUND) | **Reuse verbatim.** |
| `TenantAiBalance` (materialized snapshot) | **Reuse verbatim.** |
| `wallet.ts` — `grantUnits` / `consumeUnits` / `rolloverIncluded` / `refundUnitsForReference` | **Reuse verbatim.** |
| `CreditTransaction` | Already marked DEPRECATED in-schema. Left untouched. |

> **Naming.** The ledger's internal noun is "AI Unit". The customer-facing
> contract (`/api/billing/credit-summary`) already renders them as **credits**.
> This round keeps the ledger unchanged and uses "credits" in every new
> customer-facing surface. No second ledger is introduced.

### Internal cost engine (Sysadmin-only)

| Component | Verdict |
|---|---|
| `BillableModel` (per-model provider rates + `categoryMultiplier`) | **Reuse.** Internal only. |
| `UnitPricingConfig` (`unitCostBasisUsd`, `marginFactor`) | **Reuse.** Internal only. |
| `pricing.ts` — `providerCostUsd` / `costToUnits` / `priceUsageFromDb` | **Reuse.** |
| `UsageLog` (`promptTokens`, `completionTokens`, `costUsd`, `unitsConsumed`, `turnId`, `feature`, `model`, `aiAgentId`) | **Reuse.** Already the attributable per-call fact table. |
| `enforcement.ts` — `checkAiAllowed` / `meterAiUnits`, `BILLING_ENFORCEMENT_MODE` off/observe/soft/hard | **Reuse.** |

### Entitlements

| Component | Verdict |
|---|---|
| `Plan` + `PlanEntitlement` (`@@unique([key, version])`) | **Extend into the canonical PlanVersion.** |
| `TenantEntitlement` (source-ranked overrides, `expiresAt`) | **Reuse as `OrganizationEntitlementOverride`.** |
| `entitlements.ts` — `getEffectiveEntitlements` / `getLimits` / `materializeEntitlements` | **Extend.** |
| `TenantFeature` (materialized read cache consumed by `isPermissionLicensed`) | **Reuse.** Generic `key → bool`, so fine-grained feature keys drop in unchanged. |
| `plans.ts` `PLAN_PRESETS` (9 coarse permission **domains**) | **Keep** (permission licensing depends on it) **and layer** the fine-grained feature catalog on top. |

### Existing UI

| Page | Today | Verdict |
|---|---|---|
| `/settings/billing` | Current plan, period, cancel/resume, payment method, invoices | **Extend.** |
| `/settings/billing/plan` | 3-up plan cards, change plan | **Replace body** with the pricing configurator. |
| `/settings/billing/credits` | Buy credits | **Extend** (package metadata). |
| `/settings/billing/usage-limit` | Auto-purchase policy | **Extend.** |
| `/settings/usage`, `/usage` | Credit usage | **Extend** (estimated remaining conversations). |
| `/system/pricing` | Sysadmin **cost analytics** (unit economics, calculator, trend, rate card) | **Keep as analytics**; the plan editor is a new sibling area. |
| `/system/usage` | Sysadmin platform usage | **Keep.** |

---

## 2. Confirmed gaps (what this round builds)

| # | Gap | Evidence | Resolution |
|---|---|---|---|
| G1 | **Numeric limits are defined but never enforced.** `getLimit`/`getLimits` have **zero call sites** outside their own module and `index.ts` re-export. `limit:ai_employees`, `limit:channels`, `limit:users`, `limit:storage_gb` are seeded and inert. | `grep -rn "getLimit\b"` → only definition + export | Phase 8: canonical resolver + `assertLimit` wired into real create paths. |
| G2 | **No public commercial estimation model.** Nothing anywhere converts credits → estimated conversations. | no such symbol | Phase 3: `PublicEstimationConfig`, versioned, Sysadmin-only, never derived from analytics. |
| G3 | **No plan lifecycle.** `Plan.active: Boolean` only — no Draft/Active/Retired/Archived, no publish step, no effective dates, no ordering, no recommended flag, no i18n name, no description. | schema `model Plan` | Phase 1. |
| G4 | **No custom / per-organization plans.** `Plan` has no tenant scope. | schema | Phase 1: `Plan.tenantId` + `kind=CUSTOM`. |
| G5 | **No commercial snapshot on `Subscription`.** Price + included credits are read live from `Plan`, so editing a plan silently rewrites what every existing customer is on. | `activateOrRenew` reads `plan.basePrice` at charge time | Phase 1/7: snapshot columns on `Subscription`. |
| G6 | **No volume options.** No chat/voice per-business-day selectors. | — | Phase 4: `PlanVolumeOption`. |
| G7 | **Currency is ILS-only, no FX, no rounding policy.** | `Plan.currency @default("ILS")` | Phase 12: `PricingCurrencyConfig` + `FxRateSnapshot`, USD canonical. |
| G8 | **Feature catalog is 9 coarse domains.** No `ai.employee`, `voice.call_pilot`, `communication.broadcasts`… | `PLAN_DOMAINS` | Phase 1: `FeatureDefinition` catalog + seeds. |
| G9 | **`CreditPackage` is minimal** — no plan eligibility, no active window, no expiry policy, no visibility, no max qty, no sort order, no Hebrew name. | schema | Phase 5. |
| G10 | **Auto-purchase has no concurrency lock**, no purchase increment, no price-per-credit, no warning threshold, no configurable behaviour at limit. Two concurrent triggers can both pass the ceiling check. | `triggerAutoPurchase` reads-then-writes without a lock | Phase 6. |
| G11 | **No POC/Trial configuration.** `poc.service.ts` hardcodes; no Trial vs POC distinction; no operator-facing defaults. | `poc.service.ts` | Phase 2: `TrialPocTemplate`. |
| G12 | **No per-conversation actual usage aggregate.** `UsageLog` has the facts but nothing rolls them to a conversation with a settlement window. `/system/pricing` computes `conversations` from a live scan. | `system.ts:1063` | Phase 10: `ConversationUsageAggregate` + `ConversationUsageEventLink`. |
| G13 | **No Sysadmin plan administration surface.** `/system/pricing` is read-only analytics. | — | Phase 9. |
| G14 | **No platform pricing permissions.** Everything is `requireSystemAdmin()` (a blanket bypass). | `system.ts` | Phase 14: explicit `platform:*` keys layered on the SYSTEM_ADMIN tier. |
| G15 | **`changePlan` tier order is hardcoded** to `light/pro/business/enterprise`. New plan keys would be treated as neither upgrade nor downgrade. | `plan.service.ts` `TIER_ORDER` | Phase 7: rank from `Plan.sortOrder`. |

### Not a gap (verified clean)

- **No tenant API exposes internal token data.** `/api/billing/credit-summary`, `/credits/balance`, `/plans`, `/invoices` return credits and money only. Every token/cost surface (`/api/system/usage/*`, `/api/system/pricing/*`) is behind `requireSystemAdmin()`. This round preserves that invariant and adds a regression test for it.
- **Cross-tenant IDOR** on payment methods is already scoped via `updateMany` on the resolved profile.
- **Webhook replay** is already deduped on `providerEventId`.

---

## 3. Migration exposure

Existing plan rows: `light`, `pro`, `business`, `enterprise`, `grandfathered`, `poc`
(ILS, `version = 1`). Existing subscriptions reference them by `(planKey, planVersion)`.

**Non-destructive strategy:** every legacy row is preserved and re-labelled
`kind = LEGACY`, `status = RETIRED`, keeping its price, currency, included
credits and entitlements. Existing subscriptions keep pointing at exactly the
row they already point at, and gain a snapshot backfilled from that row. New
public plans are seeded as **new keys** (`foundation`, `ai_workforce`,
`ai_voice`) at `version = 1`. No subscription is repointed, no price rewritten,
no ledger row touched.

---

## 4. Execution matrix

| Phase | Deliverable | Primary location |
|---|---|---|
| 1 | Canonical pricing domain + migration | `packages/shared/prisma` |
| 1 | Feature catalog + entitlement resolver | `packages/shared/src/lib/billing` |
| 2 | Plan seeds (3 public + custom + POC/Trial) | `packages/shared/prisma/seed-pricing.ts` |
| 3 | Manual public estimation engine | `packages/shared/src/lib/billing/estimation.ts` |
| 4 | Chat + voice volume options | schema + seed + estimation |
| 5 | Credit packages | schema + `services/billing` |
| 6 | Auto-purchase enforcement | `services/billing/src/services/purchase.service.ts` |
| 7 | Subscription lifecycle | `services/billing/src/services/subscription.service.ts` |
| 8 | Organization entitlement enforcement | `packages/shared` + call sites |
| 9 | Sysadmin pricing administration | `services/billing/src/routes/admin-*.ts` + `/system/plans` |
| 10 | Actual usage analytics | `packages/shared/src/lib/billing/conversation-usage.ts` + `/system/conversation-costs` |
| 11 | Customer pricing UX | `/settings/billing/plan` |
| 12 | USD/ILS display | `currency.ts` + FX snapshot |
| 13 | Billing + Usage integration | existing pages |
| 14 | Permissions + audit | `permission-catalog.ts`, `platform-permissions.ts` |
| 15 | Migration + compatibility | `scripts/migrate-pricing.ts` |
| 16 | Automated tests | `__tests__` across shared + billing + frontend |
| 17 | Running UI verification | Playwright screenshots |

---

## 5. Invariants this round must not break

1. One credit ledger (`AiUnitLot` / `AiUnitLedgerEntry`). Nothing else grants or consumes credits.
2. One subscription model (`Subscription`).
3. Changing a public estimation ratio never writes to the ledger, an invoice, or an existing subscription's snapshot.
4. Tokens never cross a tenant-facing API boundary.
5. `authenticate()` remains the single auth gate; authorization stays local.
6. Frontend visibility mirrors backend entitlements and is never authoritative.
