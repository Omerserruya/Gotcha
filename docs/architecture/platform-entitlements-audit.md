# Platform Entitlements Audit — Auth, RBAC, Billing & AI Credits

> **Type:** Founder-level platform-architecture due-diligence audit (Enterprise SaaS Architect + Principal AI Architect lens).
> **Date:** 2026-07-08 · **Branch:** `feat/customer-intelligence-phase1` (working tree).
> **Method:** Phase-separated (Audit → Vision → Roadmap → Playbook). Every current-state claim is `file:line`-cited from a direct 2026-07-08 code trace.
> **Relationship to prior docs:** builds on the 2026-06-25 RBAC audit (`memory: project_rbac_audit`) and the 2026-06-30 Billing design (`memory: project_billing_architecture`). Both are superseded by reality: the designed `services/billing` **now exists and is substantially built** — this audit documents what shipped versus what is wired.
> **Constraint honored:** audit only — no code modified.

---

## Executive Summary

GOTCHA has three control systems, built to very different levels of completeness, and the gap between "modeled" and "enforced" is the entire story.

- **Authentication** is simple and mostly sound (HS256 JWT, 24h expiry, rotating 30-day refresh tokens, bcrypt) with **one live escalation hole**: `POST /api/auth/register` accepts a client-supplied `role` up to `SYSTEM_ADMIN` (`auth.ts:8-14` → `auth.service.ts:20-27`).
- **Authorization** is two overlapping systems, exactly as the 2026-06-25 audit found — but the fine-grained layer has since gained a **resolver bridge** inside `requireRole` (`rbac.ts:42-53`) and **real enforcement on billing routes** (`requirePermission("settings:billing:manage")`, 12 sites). Outside billing, the enforced layer is still the coarse `Role` enum (~210 `requireRole` sites across 43 files).
- **Billing** is the surprise: `services/billing` is a genuinely complete commercial system — plans, entitlements, an AI-Units wallet with lots/ledger/materialized balance, iCount invoicing, dunning, grandfathering, self-serve UI. **But it is dormant and disconnected:** enforcement mode defaults to `off` (`docker-compose.yml:232`), every COUNTER limit (seats, AI-employees, channels, storage) is **defined and never read** (`getLimits` has zero callers), no-subscription tenants bypass the AI gate even in hard mode (`enforcement.ts:67`), and the prod gateway has **no `/api/billing` route at all** (`gateway/nginx.prod.conf.template`).

**The one-sentence verdict:**

> **GOTCHA can model almost any commercial arrangement — trials, overrides, credit limits, grandfathering — but today it enforces almost none of them: the wallet is off by default, every quantitative limit is dead code, and the licensing layer bites only on the billing pages themselves.**

**The answers to the four capability questions the founder asked, up front:**
- **Can we expose only part of a feature (sub-feature independently)?** *Mechanically yes* — license resolution checks the most-specific key first (`permissions.ts:309-316`). *In practice no* — every writer emits domain-level keys only; no sub-feature entitlement row is ever produced.
- **Can pages dynamically render only licensed functionality?** *Partially* — `GET /api/permissions/me` returns a license-filtered permission set the frontend consumes via `<Can>`; but main nav is role-tier gated, and COUNTER limits are never sent to the frontend.
- **Can we easily create POC / enterprise-override / demo / unlimited / credit-limited / time-limited tenants?** *The models exist for all of them; the write paths mostly don't.* Trials (card-first) and grandfathered-unlimited work; enterprise-override and promo entitlements are modeled (`setTenantEntitlement`) but **have no route or UI** — the mechanism is unreachable.
- **Is the AI billing model scalable?** *The design is sound (cost-driven units, DB-configured model pricing); the write path is not yet proven at scale* — per-micro-call `UsageLog` inserts plus, when metering is on, a multi-statement wallet transaction touching per-tenant hot rows on every AI call.

**Overall score: 6.0/10** — an excellently-modeled entitlement and billing architecture (8/10 design) running at a fraction of its enforcement (3/10 wired), with two real security holes (register-role escalation, committed internal secret) that must close before any of it is turned on.

---

## ✅ Implementation Log — 2026-07-11 (P2 special-tenant surface + credit enforcement shipped)

Built and live-E2E-verified on the dev stack (graphify-guided; demo tenant used as the living example):

- **E-6 CLOSED — the special-tenant surface exists.** `system-features.ts` gained SYSTEM_ADMIN routes: `GET/PUT /api/system/tenants/:id/entitlements[/key]` (license-domain toggles writing `TenantEntitlement` OVERRIDE via the previously-unreachable `setTenantEntitlement`), `POST …/poc`, `POST …/credits`. New console UI: `EntitlementsSection` on `/system/tenants/[id]` — 9 domain toggles + billing snapshot (plan/status/balance/budget-used) + credit top-up + POC form.
- **POC mechanism (no card, credits-enforced, expiring):** new `services/billing/src/services/poc.service.ts` + internal endpoints `setup-poc` / `grant-credits` / `summary`. A POC = real subscription on a lazily-seeded sales-only `poc` plan (`enforcementEnabled:true`, `cancelAtPeriodEnd:true` keeps it out of renewals/dunning), operator-set credit budget granted as the INCLUDED allowance via `rolloverIncluded` (so 80/90/95/100% thresholds compute against the budget), feature picks written as TRIAL-source entitlements sharing the expiry (explicit `false` rows for unpicked domains — required because licensing is default-ALLOW). `expireDuePocs()` in `runBillingCycle` cancels expired POCs AND flips their materialized feature rows off (expired TRIAL rows otherwise leave stale `TenantFeature` values).
- **Enforcement ON:** compose default `BILLING_ENFORCEMENT_MODE=hard` (ai service). No-sub tenants still fail open (dev safety); enforced subscriptions block at zero — proven live: drained wallet → `ai_units:units_exhausted`, graceful bot degradation; console top-up → replies resume.
- **Workspace UI honors the license:** Sidebar nav items now carry `domain` and hide when `/api/permissions/me` (license-filtered) has no keys under that domain — verified: POC without analytics/approvals/integrations → those domains vanished from the admin's permission set. New `reconcileConnectSystemRecs`-style hygiene: none needed here.
- **80%/100% alerts:** the emit path (meter → `/internal/billing/usage-threshold` → `credit.threshold`/`credit.exhausted` → notifications templates) pre-existed and is now live (mode≠off); added the in-app surface — `CreditAlertBanner` in `AppLayout` (admins): amber pill at ≥80% budget used (session-dismissable), red persistent pill at zero ("AI paused") linking to `/settings/billing`. Fixed the pre-existing unclamped `consumedPct` in `GET /billing/credits/balance` (went to −2100 when purchased units exceed allowance).

**Not covered (unchanged from roadmap):** P0 security holes (S-1 register role, S-2 internal key — still open, still block prod `hard`), COUNTER limit gates (seats/employees/channels), pricing unification, prod-gateway `/api/billing` location.

---

# PHASE 1 — CURRENT STATE AUDIT

## 1.1 Authentication

- **JWT:** HS256, `JWT_SECRET` (≥16 chars enforced in prod, dev falls back to `"change-me"`) — `jwt.ts:12-22`. Expiry `JWT_EXPIRES_IN` default **24h** (`:23`). Claims: `userId, tenantId, role, email, departmentId?, departmentRole?` (`:26-33`) — department claims are a **login-time snapshot**, stale until refresh.
- **Refresh:** opaque UUID, **30 days**, persisted in `RefreshToken`, rotated on `/api/auth/refresh` (old deleted, new created in a tx), deactivated users rejected — `auth.ts:152-210`.
- **Transport:** **Bearer-only**, no cookies, no server session; frontend stores tokens in localStorage (`AuthContext.tsx:82-147`). Per-request liveness check on `user.isActive`, **fail-open on DB error** (`auth.ts:37-50`).
- **Signup/login:** register is public + rate-limited; login is tenant-slug + email + password; bcryptjs 10 rounds. Magic links + password reset (1h) exist and are enumeration-safe.
- **Tenant statuses:** `PENDING_ADMIN_SETUP | PENDING_ONBOARDING | ACTIVE | SUSPENDED` (`schema.prisma:44-49`); enforced by `requireActiveTenant()` (50+ route files) + inbound-message drop for non-ACTIVE (`incoming.worker.ts:160-168`); billing drives only ACTIVE↔SUSPENDED (`tenant-status.service.ts:11-21`).
- **Internal S2S auth:** two mechanisms — (A) `authenticate` treats a Bearer equal to `INTERNAL_SERVICE_KEY`/`INTERNAL_SERVICE_TOKEN` as `{userId:"system", role:"ADMIN", tenantId:<header>}`, bypassing RBAC (`auth.ts:23-31`); (B) billing's `requireInternalKey` on `X-Internal-Key` with hardcoded fallback `"chatcenter-internal-2026"` (`internal-auth.ts:8-16`, compose `:341`). Internal billing routes are Docker-network-only (no nginx location).
- **Gateway:** does **no authentication** — pure prefix router + per-IP rate limits. Note: **prod template has no `/api/billing` location** (`gateway/nginx.prod.conf.template`).

## 1.2 RBAC & permissions (two systems, one bridge)

- **Coarse enum:** `Role { SYSTEM_ADMIN, ADMIN, AGENT }` + `DepartmentRole { AGENT, MANAGER }` + `PermissionScope { OWN, TEAM, DEPARTMENT, WORKSPACE }` (`schema.prisma:236-251`).
- **Middleware:** `requireRole` (SYSTEM_ADMIN bypass; legacy fast-path; **resolver bridge** so an assigned built-in role satisfies the coarse gate — `rbac.ts:42-53`), `requireSystemAdmin`, `requireDepartmentRole`, `requirePermission` (hierarchical resolver), `requireFeature`/`requireTenantFeature`, `requireActiveTenant`.
- **Actual enforcement:** `requireRole` at **~210 sites / 43 files** (the dominant enforced layer); `requireSystemAdmin` at 5 files; **`requirePermission` at 12 sites, ALL in `services/billing`, all the single key `settings:billing:manage`**; `requireFeature` at **exactly one** endpoint (`auto-buy.ts:37`). So outside billing, the fine-grained system is not the enforced layer.
- **Fine-grained models:** `TenantFeature` (doubles as flags AND license rows), `TenantRole`/`TenantRoleFeature`/`UserRoleAssignment`/`UserFeatureGrant` (`schema.prisma:3766-3857`).
- **Catalog + resolver:** 44 keys in 9 domains (`permission-catalog.ts:89-148`); `hasPermission` order = SYSTEM_ADMIN → License (**default-ALLOW when no rows**, `permissions.ts:315`) → user grant/revoke → role (legacy bridge). 30s caches.
- **Frontend gating:** `GET /api/permissions/me` returns license-filtered permissions + scope + roleKey; `PermissionsContext`/`<Can>`/`RequirePermission` consume it (**19 usages / 15 files**). Main nav is **role-tier** gated (`Sidebar.tsx:95-96`); settings sub-nav is permission-gated; **16 raw `role===` string checks remain** in the frontend.
- **Department scoping:** the catalog's scope dimension (`resolveUserScope`) has **zero backend callers**; the only real data-scoping is a hardcoded conversation-list filter (`conversation.service.ts:40-45`). `VIEW_OTHER_AGENTS_CONVERSATIONS` is never checked.

## 1.3 Billing & plans — `services/billing` exists

- **Service:** port 4009; subscription/payment-methods/credits/invoices/webhooks/internal routes; **in-process hourly scheduler** (`runBillingCycle` + `runDunning`) with a single-instance caveat (`index.ts:30-48`).
- **Payer abstraction:** `BillableEntity` (TENANT|ACCOUNT) + `BillableEntityTenant` (1:1 in V1); money models key on `billableEntityId`, never `tenantId` (`schema.prisma:1996-2025`).
- **Catalog:** `Plan` (key/version, `basePrice` nullable = sales-only, `includedAiUnits`, `salesOnly`), `PlanEntitlement` (BOOLEAN|COUNTER|CONFIG), `CreditPackage`, `BillableModel` (per-1M in/out/cached rates, category multiplier — CHAT/EMBEDDING/VOICE/DEEP_RESEARCH), `UnitPricingConfig` (unit cost basis + margin) (`:2029-2114`).
- **Entitlement layer:** `TenantEntitlement` (source `PLAN_DEFAULT|OVERRIDE|PROMO|TRIAL|ADDON|BETA`, `expiresAt`) with source-rank precedence (`entitlements.ts:31-74`). `materializeEntitlements` writes BOOLEANs into `TenantFeature` so the existing resolver enforces the license with no hot-path change (`:113-124`).
- **Wallet:** `AiUnitLot` (INCLUDED|PURCHASED, FIFO), `AiUnitLedgerEntry` (GRANT/CONSUME/EXPIRE/ADJUST/REFUND, signed), materialized `TenantAiBalance` (`:2146-2202`). Consume = transaction: snapshot → scan lots (INCLUDED oldest-first, then PURCHASED FIFO) → per-lot decrement + CONSUME row → refresh; **clamped, never negative** (`wallet.ts:62-269`).
- **Money:** `BillingProfile`, `PaymentMethod` (raw PAN never stored — iCount is the vault), `Subscription` (`enforcementEnabled` = grandfather gate-skip), `PendingSubscriptionChange` (deferred downgrade/cancel), `Invoice`/`Charge` (idempotency-keyed), `AutoPurchasePolicy`, `DunningState`, `BillingWebhookEvent` (`:2206-2409`). `SubscriptionStatus`: PENDING/TRIALING/ACTIVE/PAST_DUE/SUSPENDED/CANCELED/PAUSED/GRANDFATHERED.
- **Lifecycle:** **card-before-trial** (14 days), upgrade charges prorated diff first, downgrade/cancel deferred to period end, dunning ladder 0/3/7 → SUSPENDED; PAST_DUE does not suspend the tenant (`subscription.service.ts`, `dunning.service.ts:19-79`).
- **Grandfathering:** MANUAL provider + `GRANDFATHERED` status + `enforcementEnabled:false` (gate-skip, full domains); idempotent; one-way migration to a real plan; triggered via internal endpoint only (`grandfather.service.ts:17-56`).
- **iCount:** PayPage tokenize + J5 preauth, `cc/charge` with `create_doc:"invrec"` (legal tax doc same call), HMAC webhook verify; **`ICOUNT_MODE` default mock** (`icount.provider.ts:34`).
- **Plan catalog (seed):** light ₪149/500u/(3 users,0 AI-emp,2 ch,5GB), pro ₪499/2500u/(10/2/6/25), business ₪1499/8000u/(30/6/20/100), enterprise sales-only/25000u/(200/25/100/500), grandfathered null (`seed-billing.ts:50-61`). Domain BOOLEANs per `PLAN_PRESETS`.

## 1.4 AI credits & token accounting (two parallel systems)

- **A — Analytics ledger (`UsageLog`):** one row per model call via `trackAIUsage`; `costUsd` from a **hardcoded in-code `AI_MODEL_PRICING`** map (`ai-usage.ts:25-48`), plus per-turn attribution (`turnId/durationMs/aiAgentId`). ⚠️ The billing columns `unitsConsumed/billedPeriodKey/ledgerEntryId` are **never written** (`schema.prisma:1835-1842`).
- **B — Commercial wallet (AI Units):** cost-driven — `providerCostUsd = Σ tokens × per-1M DB rates`, `unitsConsumed = cost × categoryMultiplier × marginFactor / unitCostBasisUsd` (`pricing.ts:61-161`). Debit via `meterAiUnits`. Thresholds 80/90/95/100% trigger auto-purchase.
- **The gate ("hard-block at zero"):** `BILLING_ENFORCEMENT_MODE` = `off`(default)/`observe`/`soft`/`hard`; **compose default `off`** (`docker-compose.yml:232`). `checkAiAllowed` reads subscription + `TenantAiBalance`; deny reasons `units_exhausted|suspended|canceled`; **fail-open** on read error and when **no subscription / enforcementEnabled=false** (`enforcement.ts:50-89`). Enforced at `generateResponse`/`streamResponse` (`ai.service.ts:342,555`). Graceful degradation: bot escalates to human when blocked.
  - **Coverage gap:** `services/ai` `generateEmbedding` tracks usage but calls neither `assertAiAllowed` nor `meterAiUnits` (`ai.service.ts:492-523`); voice has a ×2 multiplier row but no metering.
- **C — Legacy raw-token budget (mode-independent, still active):** per-turn 60k / per-conversation 250k / per-tenant-day 5M, fail-open (`cost-budget.service.ts:39-149`).
- **Rate limits:** nginx per-IP 100r/s; express per-IP 1000/15min; auth 30/15min. **No per-tenant or per-plan rate limiting anywhere.**

## 1.5 Tenant provisioning & special tenants

- **Only creation path:** SYSTEM_ADMIN `POST /api/system/tenants` (`system.ts:234-300`) — does **not** touch billing. Onboarding completion calls billing `ensure-entity` best-effort only.
- **Trials:** yes (TRIALING, 14d, card-first). **Grandfathered-unlimited:** the only "unlimited" mechanism. **Enterprise overrides / promo:** modeled (`TenantEntitlement` OVERRIDE + `setTenantEntitlement`) but **no route/UI writes them — unreachable**. **Demo tenant:** no dedicated concept. **Credit-limited:** any subscribed tenant in hard mode.
- **Invitations:** ADMIN `invite-team`/`invite-link` + public token accept (`onboarding.ts:2256-2460`).
- **Seat counting: none** — user creation is unchecked on all paths (`agents.ts:56`, `system.ts:536`).

## 1.6 The control matrix (defined-where → enforced-where)

| Control | Defined where | Enforced where |
|---|---|---|
| **Seats (max users)** | `limit:users` COUNTER (`seed-billing.ts:50-53`); reader `getLimit` (`entitlements.ts:103`) | **NOT ENFORCED** — zero `getLimit(s)` callers; creation unchecked |
| **Departments (count)** | Nowhere (no key) | **NOT ENFORCED** |
| **AI employees (count)** | `limit:ai_employees` COUNTER | **NOT ENFORCED** — no reader |
| **Channels (count)** | `limit:channels` COUNTER | **NOT ENFORCED** |
| **Storage** | `limit:storage_gb` COUNTER | **NOT ENFORCED** |
| **AI credits (Units)** | plan `includedAiUnits` + `CreditPackage`; pricing `BillableModel`/`UnitPricingConfig` | `assertAiAllowed`/`checkAiAllowed` — **only in `hard` mode (default `off`); no-subscription tenants always pass** |
| **Raw token abuse** | env 60k/250k/5M (`cost-budget.service.ts:39`) | bot-loop preflight; fail-open |
| **Feature licensing (domains)** | `PLAN_PRESETS` + `PlanEntitlement` BOOLEANs | `isPermissionLicensed` inside `hasPermission` — bites only where `requirePermission` mounts = **billing routes only**; default-ALLOW with no rows |
| **Fine feature flags (~80 keys)** | `features.ts` + `TenantFeature` | Backend: **one endpoint**; legacy Tenant booleans in bot/voice; else decorative |
| **Role-based access** | `Role` enum + built-in catalog | `requireRole` ~210 sites; `requireSystemAdmin` on system routes |
| **Data scope (own/team/dept/ws)** | catalog + `UserRoleAssignment.scope` | **NOT ENFORCED** (`resolveUserScope` zero callers); only hardcoded conversation filter |
| **Tenant status** | `TenantStatus` | `requireActiveTenant` (50+ files), inbound drop, billing suspend |
| **Subscription payment state** | `SubscriptionStatus` | dunning→SUSPENDED; AI gate refuses SUSPENDED/CANCELED in hard mode |
| **Rate limiting** | nginx/express/auth | per-IP only, **never per-tenant/plan** |
| **Billing management** | `settings:billing:manage` owner-only | `requirePermission` on all billing mutations |

## 1.7 What works well (do not redesign)

1. **The billing domain model.** BillableEntity abstraction, lots/ledger/materialized-balance wallet, source-ranked entitlements, idempotency-keyed charges, deferred downgrades, dunning, grandfather-as-gate-skip. This is a genuinely well-designed commercial core. Keep it.
2. **`materializeEntitlements` → `TenantFeature`.** Licensing rides the existing permission resolver with zero hot-path change — elegant. Keep.
3. **Cost-driven units with DB-configured pricing.** `BillableModel`/`UnitPricingConfig` mean model-price changes are data, not code. Keep (and migrate `UsageLog.costUsd` onto it — see debt).
4. **iCount same-call legal invoicing + PCI-out tokenization.** Correct for the ILS market. Keep.
5. **The resolver bridge + billing-route permission enforcement.** The fine-grained system is now real where it matters most (money). Keep and extend outward.

## 1.8 Weaknesses

### Security (must fix before enabling any enforcement)

- **S-1 · Public role escalation in `/api/auth/register`** — client `role` up to SYSTEM_ADMIN accepted (`auth.ts:12` → `auth.service.ts:20-27`). A known tenant slug + this endpoint = platform-tier takeover. *(Cross-ref: security audit.)*
- **S-2 · Committed internal-secret fallback** `"chatcenter-internal-2026"` in billing auth + compose + callers (`internal-auth.ts:10`, `docker-compose.yml:341`). Internal key = ADMIN-on-any-tenant. *(Owned by the security audit as N-1; noted here because it gates internal billing.)*

### Enforcement gaps (the "modeled but dead" theme)

- **E-1 · Every COUNTER limit is dead code** — seats/AI-employees/channels/storage seeded, `getLimits/getLimit` zero callers (`entitlements.ts:90-106`).
- **E-2 · Enforcement dormant by default** — `BILLING_ENFORCEMENT_MODE=off`; only `hard` blocks.
- **E-3 · No-subscription bypass** — cardless tenants pass the AI gate even in hard mode (`enforcement.ts:67`); nothing forces a subscription.
- **E-4 · Licensing bites only on billing routes** — default-ALLOW everywhere else; the 9 domain BOOLEANs gate almost nothing outside `/settings/billing`.
- **E-5 · Data scope never enforced** — `resolveUserScope` unused; the scope dimension is cosmetic.
- **E-6 · Enterprise-override / promo write path unreachable** — `setTenantEntitlement` exported, zero callers; no admin route writes `TenantEntitlement`.

### Technical debt

- **T-1 · Two divergent pricing sources** — in-code `AI_MODEL_PRICING` (UsageLog.costUsd) vs DB `BillableModel` (units); the seed comment itself calls the in-code map "stale."
- **T-2 · UsageLog billing columns never written** — `unitsConsumed/billedPeriodKey/ledgerEntryId` unlinked from the wallet ledger; no profitability join exists.
- **T-3 · Metering blind spots** — `services/ai` embeddings not gated/metered; voice modality unmetered.
- **T-4 · Prod gateway lacks `/api/billing`** — billing UI/API would 404 in prod.
- **T-5 · Dead models/functions** — `CreditTransaction` (never written), `applyPlanToTenant` (uncalled), `setTenantEntitlement` (uncalled), most of the ~80 `FEATURES` keys unchecked, `PAUSED`/`PENDING` subscription statuses unreachable.
- **T-6 · JWT staleness** — role/department/permission changes don't invalidate live 24h tokens; only `isActive` is re-checked; +30s cache lag.
- **T-7 · Usage write-path hot rows** — per-micro-call `UsageLog` insert + (when metering on) a wallet transaction upserting per-tenant `TenantAiBalance` on every AI call + an unindexed `metadata->conversationId` JSON-path scan in cost-budget.
- **T-8 · Fail-open stack** — authenticate DB check, `checkAiAllowed`, cost-budget, Oracle billing signal all degrade permissive; individually defensible, collectively a silent-bypass surface once enforcement is on.
- **T-9 · Grandfathering is manual/opt-in** — no boot backfill, so working-tree tenants may sit in the "no subscription → fail-open" state rather than an explicit GRANDFATHERED one.

## 1.9 Scores (0–10)

| Area | Score | Justification |
|---|---|---|
| Billing domain model (design) | **8.5** | Well-abstracted, complete commercial core |
| AI-Units accounting design | **8.0** | Cost-driven, DB-priced, ledgered wallet |
| Authentication | **6.5** | Sound primitives; register-role hole; fail-open |
| RBAC design (catalog + resolver) | **7.0** | Coherent hierarchy, license layer, bridge |
| RBAC enforcement (reality) | **4.0** | Coarse enum outside billing; scope unenforced |
| Entitlement enforcement | **3.0** | COUNTERs dead; mode off; no-sub bypass |
| Feature gating (sub-feature independence) | **4.0** | Mechanism present, never exercised |
| Tenant provisioning / special tenants | **4.5** | Trials+grandfather work; overrides/demo unreachable |
| AI billing scalability | **5.5** | Sound design; unproven hot-row write path |
| Security of the control plane | **3.5** | Register escalation + committed internal key |
| **Overall** | **6.0** | Excellent model, minimal enforcement, two holes |

---

# PHASE 2 — VISION

*First principles. The billing model is largely right; the vision is about enforcement, reachability, and closing the holes — not a rebuild.*

## 2.1 Entitlements become the single source of "what a tenant may do"

Today "what a tenant can do" is scattered across the `Role` enum, ~80 `TenantFeature` flags, 6 legacy Tenant booleans, plan BOOLEANs, and dead COUNTERs. The ideal: **one entitlement resolution** (`getEffectiveEntitlements`) is authoritative, and every gate — feature, sub-feature, and quantitative limit — reads it. `materializeEntitlements → TenantFeature` already proves the pattern for BOOLEANs; extend it to COUNTERs (a `getLimit` gate at every create path) and make sub-feature keys real (plans emit `analytics:dashboard`, not just `analytics`).

**Why:** the founder's questions ("expose part of a feature", "sub-feature independently", "pages render only licensed functionality") are all *already answerable by the model* — they fail only because no writer emits fine keys and no reader enforces limits. Close that loop and all three become true.

## 2.2 Enforcement is on, safe, and observable by default

`observe` mode should be the default in every non-dev environment: the wallet meters and the limits check, logging what *would* be denied, blocking nothing — so the data path is proven before `hard` flips. Every fail-open path emits a metric so "silently permissive" is visible. No-subscription tenants get an explicit state (auto-grandfather at provisioning or a free-tier subscription) so "no sub → bypass" stops being an accident.

## 2.3 Special tenants are a first-class admin surface

A single SYSTEM_ADMIN screen writes `TenantEntitlement` overrides (the modeled-but-unreachable `setTenantEntitlement`): POC (time-limited via `expiresAt`), enterprise-override (custom COUNTERs), demo (grandfathered + labeled), unlimited (grandfathered), credit-limited (capped INCLUDED grant). **The models exist; this is a write path + UI, not new architecture.**

## 2.4 The two holes close first, unconditionally

Register stops accepting a client `role` (server-assigns AGENT, or the first user of a PENDING tenant becomes ADMIN by provisioning, never by request). The internal service key is required-at-boot, not defaulted. These gate everything else — enforcement on top of an escalation hole is theater.

## 2.5 One pricing source

`UsageLog.costUsd` derives from the same DB `BillableModel` table the wallet uses (delete the in-code `AI_MODEL_PRICING`), and the wallet ledger writes back `unitsConsumed/ledgerEntryId` onto the `UsageLog` row — so profitability (revenue units vs provider cost) is one join, not two divergent maps.

## 2.6 What should remain exactly as it is

The BillableEntity abstraction, the lots/ledger/balance wallet, `materializeEntitlements`, iCount same-call invoicing, grandfather-as-gate-skip, the deferred-downgrade model, the resolver bridge. Correct — do not touch for novelty.

## 2.7 What should disappear

Dead `CreditTransaction`, `applyPlanToTenant`, the in-code pricing map; the ~60 unchecked `FEATURES` keys (prune to what is enforced); the 6 legacy Tenant boolean columns (migrate to `TenantFeature`).

---

# PHASE 3 — ROADMAP

> Sequencing law: **close the holes → prove the meter (observe) → enforce limits → reach the admin surface.** Never enable `hard` on top of an escalation hole or an unproven meter.

## P0 — Close the control-plane holes (days)

**Objective:** the control plane is safe to build on.
**Scope:** register stops trusting client `role` [S-1]; internal key required-at-boot, rotate the committed literal [S-2]; add `/api/billing` to the prod gateway [T-4]; auto-grandfather (or free-tier subscription) at tenant provisioning so no tenant sits in the fail-open no-sub state [E-3/T-9].
**Business value:** removes takeover risk; makes billing reachable in prod.
**Risk:** low; register change may affect any legitimate flow relying on client role (audit callers first — expected none). **Complexity:** S. **Dependencies:** none. Coordinate S-1/S-2 with the security audit's P0.
**Success criteria:** no client-supplied role accepted; boot fails without an internal key; every tenant has an explicit subscription/grandfather state.
**Verification:** register with `role:SYSTEM_ADMIN` → AGENT assigned; unset internal key → boot refuses; query tenants → none in null-subscription state.

## P1 — Prove the meter and enforce credits (2–4 weeks)

**Objective:** the AI-Units wallet is on in `observe`, then `hard`, safely.
**Scope:** default `BILLING_ENFORCEMENT_MODE=observe` in non-dev; add metering to `services/ai` embeddings + a voice mapping [T-3]; unify pricing on DB `BillableModel` and write `unitsConsumed/ledgerEntryId` onto `UsageLog` [T-1/T-2]; emit a metric on every fail-open [T-8]; load-test the wallet write path and add the missing `metadata->conversationId` index [T-7]; then flip pilots to `hard`.
**Business value:** revenue enforcement becomes real without surprise outages; profitability becomes measurable.
**Customer value:** honest usage limits + auto-purchase instead of silent overspend.
**Risk:** medium — `hard` can block real customers; the `observe` gate + no-sub fix (P0) de-risk it. **Complexity:** M. **Dependencies:** P0.
**Success criteria:** observe logs would-be denials with zero customer impact for one cycle; one pricing source; embeddings+voice metered; wallet write path holds at target QPS.
**Verification:** synthetic exhaustion in observe → logged not blocked; then in hard → blocked + bot escalates; profitability query returns from a single join.

## P2 — Enforce quantitative limits + the special-tenant surface (4–6 weeks)

**Objective:** COUNTER limits bite; special tenants are self-serve for ops.
**Scope:** wire `getLimit` at every create path (users [E-1], AI-employees, channels, departments — add the missing key, storage) with a structured 402/403 and a frontend limit context; SYSTEM_ADMIN screen writing `TenantEntitlement` overrides (POC/enterprise/demo/unlimited/credit-limited/time-limited) [E-6, §2.3]; expose COUNTER limits to the frontend so pages render "3 of 10 seats used."
**Business value:** plans mean something; sales can provision POCs/overrides without engineering.
**Risk:** medium — enforcing seats/limits on existing over-limit tenants needs a grace/grandfather pass. **Complexity:** M-L. **Dependencies:** P1 (entitlement resolution proven).
**Success criteria:** creating past a plan limit is blocked with an upgrade path; an AE provisions a time-boxed POC from the console in minutes.
**Verification:** exceed each limit → blocked; create a POC tenant with `expiresAt` → access revokes on expiry.

## P3 — Fine-grained gating + enterprise entitlement (quarter+)

**Objective:** sub-feature independence + enterprise-grade entitlement.
**Scope:** plans emit sub-feature keys; extend `requirePermission`/`requireFeature` beyond billing to the domains that need it; enforce data scope (`resolveUserScope`) server-side [E-5]; per-tenant/per-plan rate limiting; SSO/SAML tie-in with entitlement; usage-based add-ons.
**Risk:** medium; broad surface. **Complexity:** L. **Dependencies:** P2.
**Success criteria:** a plan can enable `analytics:dashboard` without `analytics:export`; pages render only licensed functionality; scope is enforced.
**Verification:** sub-feature toggle E2E; a non-workspace-scope user cannot read another team's data server-side.

---

# PHASE 4 — IMPLEMENTATION PLAYBOOK (for Claude Sonnet)

> NO CODE. Backend/shared changes: `npm run db:generate`, per-service rebuilds, `nginx -s reload`. **Never** enable `hard` before `observe` proves the path. Treat S-1/S-2 as blocking prerequisites for everything else.

## 4.1 Implementation order

**P0:** (1) register server-assigns role → (2) internal key required-at-boot + rotate → (3) prod gateway `/api/billing` location → (4) provisioning auto-grandfather/free-tier.
**P1:** (5) default observe in non-dev → (6) meter embeddings + voice → (7) unify pricing on `BillableModel` + write UsageLog billing columns → (8) fail-open metrics → (9) index + load-test wallet path → (10) flip pilots to hard.
**P2:** (11) `getLimit` gates at create paths → (12) special-tenant admin screen (`setTenantEntitlement`) → (13) frontend limit context.
**P3:** (14) sub-feature keys → (15) extend permission gates → (16) enforce scope → (17) per-tenant rate limits.

## 4.2 Key architecture decisions (made)

- **One entitlement source:** `getEffectiveEntitlements` is authoritative; `materializeEntitlements` continues to project BOOLEANs onto `TenantFeature`; add a parallel `getLimit(tenantId, key)` read used by a new `requireLimit(key, countFn)` middleware at create paths. Do NOT invent a second resolver.
- **Enforcement default:** `observe` in non-dev via compose env; `hard` per-tenant via a pilot flag, not global, until proven.
- **No-subscription fix:** at `POST /api/system/tenants` and onboarding `ensure-entity`, create either a grandfather subscription (internal tenants) or a free-tier plan subscription — so `checkAiAllowed`'s no-sub branch (`enforcement.ts:67`) is never reached in prod.
- **Pricing unification:** `UsageLog.costUsd` computed from `BillableModel` (same query the wallet uses); delete `AI_MODEL_PRICING`; the wallet's CONSUME transaction writes `unitsConsumed`+`ledgerEntryId` back onto the originating `UsageLog` row (pass the row id into `meterAiUnits`).
- **Special tenants = `TenantEntitlement` writes:** the admin screen calls the existing `setTenantEntitlement` (OVERRIDE/PROMO/TRIAL/BETA source + `expiresAt`); no new model. POC = TRIAL/OVERRIDE with `expiresAt`; unlimited/demo = grandfather; credit-limited = a capped INCLUDED `AiUnitLot`.

## 4.3 Files likely affected

- **Auth:** `routes/auth.ts` (register role), `routes/system.ts` (provisioning subscription), `routes/system-features.ts` (special-tenant screen backend).
- **Shared:** `middleware/auth.ts` (internal key required), new `requireLimit` middleware, `lib/billing/entitlements.ts` (getLimit gate helper), `lib/ai-usage.ts` (delete in-code pricing → BillableModel), `prisma/schema.prisma` (index; optional prune of dead columns).
- **Billing:** `services/billing/src/lib/internal-auth.ts` (no default), routes for override writes.
- **AI:** `ai.service.ts` (meter embeddings; pass UsageLog id to meter), voice metering hook.
- **Gateway:** `gateway/nginx.prod.conf.template` (`/api/billing` location).
- **Frontend:** limit context + create-path guards; special-tenant admin UI.

## 4.4 Database migrations

- Additive index on `UsageLog(metadata conversationId)` or a materialized `conversationId` column for the cost-budget scan [T-7].
- Optional (P3): prune legacy Tenant boolean columns after migrating to `TenantFeature` (non-additive — dedupe/migrate first).
- No new billing models required (the model is complete); only writers/readers.

## 4.5 API changes

- `POST /api/auth/register`: drop `role` from the accepted schema (server-assigns).
- New: `requireLimit`-gated 402/403 on user/AI-employee/channel/department create paths; `GET /api/entitlements/limits` (frontend limit context); SYSTEM_ADMIN entitlement-override write route.
- No breaking change to existing billing route contracts.

## 4.6 AI changes

- No new LLM calls. Metering additions only (embeddings + voice). Pricing source swap is internal accounting, not model behavior.

## 4.7 Regression risks

- **Enabling `hard` blocks real customers** — mitigated by observe-first + no-sub fix; roll per-tenant.
- **Register change** — audit for any legitimate caller passing `role` (expected none); tests must cover ADMIN provisioning still works via the system route.
- **Pricing unification** — `UsageLog.costUsd` values will shift to match `BillableModel`; document the discontinuity for analytics.
- **Limit enforcement on existing over-limit tenants** — a grace pass (grandfather current counts) before blocking.
- **Wallet hot-row contention under load** — validate the index + transaction before hard.

## 4.8 Manual QA checklist

- [ ] Register with elevated role → AGENT assigned; ADMIN still provisioned via system route.
- [ ] Boot with unset internal key → refuses; with rotated key → S2S works.
- [ ] Prod gateway routes `/api/billing`.
- [ ] Every tenant has an explicit subscription/grandfather state; no-sub bypass path unreachable.
- [ ] Observe mode: synthetic exhaustion logs would-be denial, blocks nothing.
- [ ] Hard mode (pilot): exhaustion blocks AI, bot escalates to human; embeddings + voice metered.
- [ ] Exceed each COUNTER (users/AI-employees/channels/departments/storage) → blocked with upgrade path.
- [ ] Special-tenant screen: create POC (expires), enterprise-override (custom limit), unlimited (grandfather), credit-limited (capped grant); verify each enforces.
- [ ] Frontend shows "N of M" for licensed limits; sub-feature toggle (P3) hides only the sub-feature.
- [ ] Profitability query returns revenue-units vs provider-cost from one join.

## 4.9 Automated testing checklist

- [ ] Register-role rejection test; internal-key-required boot test.
- [ ] `getEffectiveEntitlements` precedence test (OVERRIDE > TRIAL > PLAN_DEFAULT).
- [ ] `requireLimit` gate tests per create path (at/over limit).
- [ ] Wallet consume test under concurrency (no negative, correct FIFO).
- [ ] Pricing-unification test (UsageLog.costUsd == BillableModel-derived).
- [ ] Fail-open metric emitted on forced read error.
- [ ] Special-tenant expiry test (POC access revokes at `expiresAt`).

## 4.10 Rollout / rollback

- **Rollout:** P0 immediately (security). Enforcement: dev→off, staging→observe, prod→observe for one billing cycle, then per-tenant hard. Special-tenant screen behind SYSTEM_ADMIN. Limit gates behind a per-limit flag so each can be enabled independently after its grace pass.
- **Rollback:** enforcement mode → off (instant, env); limit gates → per-flag off; register/internal-key changes are security-forward (do not roll back — fix forward); pricing unification keeps the old map in git history for analytics reconciliation.

## 4.11 Definition of Done (per phase)

- **P0:** no client role accepted; internal key required; prod billing reachable; no fail-open no-sub tenants.
- **P1:** observe default; one pricing source; embeddings+voice metered; wallet path load-proven; pilots on hard.
- **P2:** every COUNTER enforced with an upgrade path; special tenants self-serve from the console; limits visible in the UI.
- **P3:** sub-feature independence works; scope enforced server-side; per-tenant rate limits live.

---

# VERIFICATION CHECKLIST (audit integrity)

- [x] Every current-state claim cited to working-tree `file:line` (2026-07-08).
- [x] The four founder capability questions answered from code (§Executive Summary + §1.6 + §2.1), not from design intent.
- [x] Prior docs reconciled: the 2026-06-30 billing DESIGN is now BUILT — documented what shipped vs what is wired; the 2026-06-25 RBAC finding (two systems, coarse enum enforced) re-verified as still true with the new resolver bridge + billing enforcement noted.
- [x] Security holes (register escalation, committed internal key) flagged and cross-referenced to `docs/security/enterprise-readiness-audit.md`, which owns them.
- [x] No code, migrations, or tasks created. Cross-references: AI-employee count limit → `docs/product/ai-employee-platform-audit.md`; onboarding provisioning → `docs/product/onboarding-platform-audit.md`.
