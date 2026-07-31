# GOTCHA Platform — CTO Technical Due-Diligence Audit

**Date:** 2026-07-30
**Branch:** `scratch/shopify-live-chat-on-pricing`
**HEAD:** `b83b190f2d442520549c86e156c168b9165b10a0` — *fix(commerce): say why an action is missing, and stop reporting one status twice*
**Working tree at audit time:** 67 modified, 10 untracked (uncommitted work in progress)
**Auditor mode:** read-only inspection + controlled Dev probes. No code changed, nothing pushed, no production configuration touched.

---

## 0. How to read this document

Every claim carries one of these states. They are used strictly.

| State | Meaning |
|---|---|
| **VERIFIED WORKING** | Traced in source AND confirmed by execution, DB query, or live probe |
| **VERIFIED BROKEN** | Defect demonstrated with concrete evidence |
| **PARTIALLY VERIFIED** | Source traced; runtime behaviour not exercised |
| **IMPLEMENTED BUT UNTESTED** | Code exists and looks correct; no test or runtime proof found |
| **UI ONLY** | Frontend surface exists; backend ignores it |
| **BACKEND ONLY** | Backend capability exists; no user-reachable surface |
| **DEAD/UNUSED** | No reachable caller found |
| **UNKNOWN** | Not investigated in this pass |

### Audit completeness — read this first

This audit was scoped as ten phases. **Every phase has been opened; none is exhaustive.** Phases 0–3 were executed substantially; 4–9 were executed on their highest-risk axis only; 10 is bounded by all of the above. Nothing was blocked — the scope is simply larger than one pass.

Every phase below states which axis was covered and which were not. What is written here is real and evidenced; what is missing is named explicitly rather than filled with inference.

**A note on method, because it shaped the result.** Four grep-derived conclusions were reached and then **retracted** during this audit after verification: "four Shopify API versions" (regex matched dates in comments), "`mode: assist` drift" (a debug label, not an `AgentMode`), "1,003 orphan i18n keys" (93 dynamic `t()` template calls defeat static analysis), and "36 files with hardcoded Hebrew" (they use deliberate `he ? … : …` bilingual patterns). A fifth — "unbounded audit table" — was falsified by finding a working retention scheduler.

Consequently **no finding in this document rests on a single grep.** Each is confirmed by a second independent method: a live probe, a database query, official provider documentation, or reading the implementation from both ends. Where a measurement could not be made reliable, it is reported as inconclusive rather than as a finding.

| Phase | Scope | Status |
|---|---|---|
| 0 | Graphify index + coverage | **COMPLETE** |
| 1 | AI core & AI Employee creation | **SUBSTANTIALLY COMPLETE** — full 38-column field map in §II-11 (12 inert, 2 safety-relevant); hiring-chat / clone / resume not traced |
| 2 | AI runtime, autonomous vs Copilot | **PARTIAL** — dispatch order and mode model traced; full state machine not validated at runtime |
| 3 Tools & HITL | **SUBSTANTIALLY COMPLETE** — all 66 call sites classified (§II-5), 147-tool governance matrix (§II-17); per-tool scope/entitlement/telemetry UNKNOWN |
| 4 Integrations | **PARTIAL** — version axis for 12 providers (§II-6), OAuth structure for 16 (§II-18), Shopify webhooks verified; pagination/rate-limit/retry/error-taxonomy UNKNOWN for all |
| 5 | Source of Truth architecture | **PARTIAL** — only the conversation-summary entitlement question was answered |
| 6 | Billing, plans, entitlements, RBAC | **PARTIAL** — enforcement-coverage measured; plan/credit/dunning lifecycle not audited |
| 7 Frontend/i18n | **PARTIAL** — i18n parity clean (§8c), EN/HE public browser sweep run (§II-19); authenticated journeys, mobile, duplicate-UX map open |
| 8 Database | **PARTIAL** — integrity, retention and 143-model usage classification done (§8d, §II-16); index/cascade/secret-scan axes open |
| 9 Dead code | **PARTIAL** — routes (§8e), env vars (§II-15), unused exports (§II-24); components/registries/flags/fixtures not swept |
| 10 | Production-readiness verdict | **PARTIAL** — bounded by the above |

**Provider documentation was checked for exactly two providers (Shopify, Meta) and on exactly one axis (API version support / deprecation).** See §8b. Every other provider — Fireberry, HubSpot, Airtable, AWS RDS, Gmail, Google Calendar, Google Drive, iCount, Bank of Israel FX, Authentik, Twilio, Stripe, PayPal, Monday, Salesforce, Zoho, WooCommerce, ReturnGO — remains **UNKNOWN**. No integration may be called production-ready on the strength of this document.

---

## 1. Graphify update result

Incremental rebuild against HEAD `b83b190`. Prior index was dated Jul 13 (17 days stale).

| Metric | Value |
|---|---|
| Changed files re-extracted | 1,022 (941 code · 80 docs · 1 image) |
| Deleted files pruned | 5 → 55 nodes removed |
| AST pass | 7,969 nodes / 22,419 edges |
| Semantic pass | 882 nodes / 1,114 edges / 15 hyperedges (6 subagent chunks) |
| **Final graph** | **12,687 nodes · 26,876 edges · 580 communities** |
| Delta vs Jul-13 | +4,810 nodes, +11,573 edges, −367 nodes, −1,601 edges |
| Integrity check | **OK** — 0 dangling, 0 missing-endpoint, 0 self-loop, 0 collapsed edges |
| Extraction cost | 1,222,469 subagent tokens |

**Freshness verified:** HEAD's `.tsx` files present in the index; **0** modified/untracked source files absent from the graph.

### Coverage

| Area | Nodes | Files | Area | Nodes | Files |
|---|---:|---:|---|---:|---:|
| frontend | 3,682 | 482 | services/conversation | 184 | 31 |
| services/ai | 3,448 | 472 | services/notifications | 120 | 17 |
| packages/shared | 1,705 | 197 | remotion-gotcha | 99 | 28 |
| docs | 978 | 100 | services/webhook | 61 | 9 |
| services/billing | 844 | 110 | services/analytics | 59 | 7 |
| services/voice-copilot | 470 | 61 | services/chatbot | 59 | 7 |
| services/auth | 437 | 47 | services/outgoing-worker | 51 | 6 |
| services/incoming-worker | 193 | 24 | scripts / infra | ~250 | ~35 |

Node types: 11,608 code · 687 concept · 207 rationale · 152 document · 33 image.

### Graphify limitations affecting this audit

1. **`frontend/src/i18n/en.json` / `he.json` are not indexed** — the detector classifies them as neither code nor document. Phase 7's i18n comparison cannot use Graphify and must be done by direct file diff.
2. **`graph.html` is an aggregated community view** (580 community nodes), not node-level, because the graph exceeds the 5,000-node visualisation limit. Node-level tracing works through `graph.json`.

### Structural inventory (direct source count, cross-checked against the graph)

| | |
|---|---|
| Services | 11 (+ gateway, frontend, packages/shared) |
| Backend endpoints | **720** — ai 258 · auth 190 · conversation 109 · billing 97 · analytics 13 · webhook 11 · notifications 8 · chatbot 7 · voice-copilot 27 |
| Frontend pages | 108 (App Router `page.tsx`); 0 Next API routes |
| Prisma models | **143** · enums 87 · migrations 141 |
| Provider adapters | 17 files, 16 registered |
| Catalog integrations | 17 rows, 15 with tools (147 catalog tools total) |

---

## 2. Executive summary

GOTCHA is a genuinely ambitious, largely coherent multi-tenant AI customer-engagement platform. The architecture rules in `CLAUDE.md` are **not decorative** — the two most important ones hold under inspection:

- **LLM calls are confined to `services/ai`.** The apparent duplicate `ai-bot.service.ts` in `incoming-worker` (994 lines) is a clean side-effects-only shell that calls `services/ai` over HTTP; the 4,314-line brain lives in `services/ai`. This is correct separation, not duplication. **VERIFIED WORKING.**
- **Authentication is Authentik's.** `services/auth/src/services/auth.service.ts` was deleted (confirmed in the Graphify prune list) and the auth gate is a single `authenticate()` in shared.

The prompt-assembly layer is unusually disciplined — a cache-stable block layout with an explicit contract about what may read per-turn state. The OAuth state store is better than most production systems: single-use `jti` consumed in Redis, tenant bound *into* the signed state, no return URL taken from a query parameter.

**But the commercial and authorisation layers have not kept up with the product surface.** Three findings dominate:

1. **A route exists that executes arbitrary provider actions with no tool-policy gate and no specific permission.** Any authenticated member of an active tenant can call it. This defeats the entire Approvals/HITL product for anyone who can read the network tab.
2. **Entitlement enforcement covers 18 of 720 endpoints (2.5%)**, split across two parallel and non-interoperating systems. A `feature-catalog.ts` field named `enforcementLocations` documents where each entitlement is enforced — and for at least one feature that documentation is fiction.
3. **Configuration the product invites users to set is silently ignored at runtime.** Seven AIAgent fields are stored and never read, including one whose schema comment claims it is a safety gate.

The pattern connecting all three: **the system's own documentation — schema comments, catalog metadata, defaults files — asserts behaviour that the runtime does not implement.** For an audit, that is the most important structural finding, because it means internal documents cannot be trusted as evidence. Every claim in this report was therefore taken from executable code, a live probe, or a database query.

**Production readiness:** not ready to scale without addressing finding P0-1. The platform is closer to ready than the finding count suggests — the defects are concentrated in the authorisation/commercial seams, not in the core runtime.

---

## 3. Risk register (ranked)

| # | Finding | Sev | State |
|---|---|---|---|
| 1 | **Two** `ai-assist` routes run any provider action with no policy gate **and no cross-customer guard** — privilege escalation + customer-data exposure (§II-3, §II-23) | **P0** | VERIFIED BROKEN |
| 2 | Commercial enforcement: **3 of 90** features gated; **~9 of 90** capabilities enforced across both systems (§II-27) | **P1** | VERIFIED BROKEN |
| 3 | `escalationGates` documented as an enforced safety gate; never read | **P1** | VERIFIED BROKEN |
| 3b | **`capabilities.auto/assist` — disabling autonomous mode for an employee does nothing** (§II-11) | **P1** | VERIFIED BROKEN |
| 4 | HIGH-risk mutating tools ship with `hitl: never` | **P1** | VERIFIED BROKEN |
| 5 | Two parallel entitlement systems that do not interoperate | **P1** | VERIFIED BROKEN |
| 6 | `enforcementLocations` catalog metadata is unverified fiction | **P1** | VERIFIED BROKEN |
| 7 | Shopify pinned ~15 months past EOS; silent fall-forward, no detection | **P1** | VERIFIED BROKEN |
| 8 | WhatsApp/Messenger on expired Meta Graph v19.0; same silent fall-forward | **P1** | VERIFIED BROKEN |
| 9 | Shopify webhook version differs dev (`2026-10`) vs prod (`2024-04`) | **P1** | VERIFIED BROKEN |
| 10 | **12** AIAgent config fields stored, never read at runtime (§II-11) | **P2** | VERIFIED BROKEN |
| 11 | KB deletion silently breaks the activation invariant | **P2** | VERIFIED BROKEN |
| 12 | Business hours exist only in Redis, no Postgres backing | **P2** | VERIFIED |
| 13 | ACTIVE subscriptions with no reachable tenant (constraint gap) | **P1** | VERIFIED BROKEN |
| 14 | ~14 of ~26 integrations unverified against provider docs; **no** provider verified on OAuth/webhook/rate-limit axes | **P1** | UNKNOWN |
| 15 | Stripe API version unpinned — governed by account dashboard, invisible to code (§II-6) | **P1** | VERIFIED BROKEN |
| 16 | Source of Truth facade bypassed by the live writeback path (§II-13) | **P1** | VERIFIED BROKEN |
| 17 | `FeatureDefinition` DB table is a stale mirror of the TS catalog — already diverged 35 vs 29 (§II-16) | **P1** | VERIFIED BROKEN |
| 18 | No catalog tool retries; no circuit breaker; mode filtering inert (§II-17) | **P2** | VERIFIED |
| 19 | Shopify refund/cancel not idempotent at framework level (§II-17) | **P2** | VERIFIED |
| 20 | `/legal/terms-of-service` throws 8 hydration errors (§II-19) | **P2** | VERIFIED BROKEN |
| 21 | `/login` has no `lang`/`dir` — WCAG 3.1.1 (§II-19) | **P2** | VERIFIED BROKEN |
| 22 | Public pages ignore `Accept-Language`; Hebrew visitors get English/LTR (§II-19) | **P2** | VERIFIED |
| 23 | Credential read path silently accepts unencrypted credentials — 11 sites (§II-20) | **P2** | VERIFIED BROKEN |
| 24 | `IntegrationCatalog` delete cascades into every tenant's credentials (§II-21) | **P2** | VERIFIED |
| 25 | Three superseded local modules duplicate shared audit/usage/channel code (§II-24) | **P2** | VERIFIED BROKEN |

---

## 4. Findings

### P0-1 — Arbitrary provider-action execution with no tool-policy gate

**Subsystem:** Tools & HITL / Copilot API
**Severity:** P0 — privilege escalation within tenant; defeats the Approvals product
**State:** **VERIFIED BROKEN**

**Evidence**

`services/ai/src/routes/ai-assist.ts:704-727`:

```ts
router.post("/:conversationId/adapter-tools/execute", async (req, res) => {
  const { toolFunctionName, args } = req.body;
  if (typeof toolFunctionName !== "string" || !toolFunctionName.includes(".")) {
    res.status(400).json({ error: "toolFunctionName must be 'provider.tool'" }); return;
  }
  const result = await executeAdapterTool({
    tenantId: req.tenantId!,
    conversationId: convId === "system" ? undefined : convId,
    toolFunctionName,
    args: args || {},
  });
  ...
});
```

- Guards on this route are only `authenticate, resolveTenant, requireActiveTenant()` (`ai-assist.ts:252`). **No `requirePermission`, no `requireRole`, no `requireInternalKey`.**
- `grep -c "evaluatePolicies" services/ai/src/routes/ai-assist.ts` → **0**.
- `grep -c "evaluatePolicies" services/ai/src/services/connectors/integration-framework.ts` → **0**. The adapter framework itself has no policy gate; it does rate-limiting, scope checks and audit only.
- `accessScope` is not passed, so it defaults to `internal` — which means the Shopify **cross-customer access guard** (`integration-framework.ts:592`, fires only when `accessScope === "customer"`) is also skipped.
- Publicly proxied on the whole prefix: `nginx/nginx.conf.template:602` and `gateway/nginx.prod.conf.template:588` (`location /api/ai-assist`).
- Live probe (safe, bogus provider, no side effects): `POST /api/ai-assist/test-conv/adapter-tools/execute` → **HTTP 401**, i.e. the route is reachable and gated *only* by authentication.

**The asymmetry proves intent.** Other routes in the same file *do* carry authorisation: `requireRole("ADMIN")` at lines 41, 74, 104, 132, 255, 807; `requireRole("SYSTEM_ADMIN")` at 603; `requireInternalKey` at 152. This route was simply missed.

**Reproduction:** authenticate as any tenant member (including the lowest-privilege `AGENT`), then
`POST /api/ai-assist/<any-conversation-id>/adapter-tools/execute` with
`{"toolFunctionName":"shopify.refund_order","args":{...}}`.

**What it bypasses:** `TenantToolPermission` enable/disable · HITL approval requirement (the entire Approvals feature) · tool risk classification · the Integrations & Tools policy screen · per-tool entitlement.
**What it does not bypass:** tenant isolation (`req.tenantId` is server-resolved from the session, never from the body) and provider OAuth scopes. This is escalation *within* a tenant, not cross-tenant.

**Customer impact:** a support agent restricted to "suggest only" can issue refunds, edit orders, mutate CRM records and run `postgresql.update_row` against the tenant's own database.
**Business impact:** the HITL/Approvals capability is sold and configurable but not enforceable; financial-action controls are advisory.

**Root cause:** the route was built as an internal bridge for two trusted callers — `services/conversation/src/routes/approvals.ts:130` (approved-HITL dispatch, where policy *has* already been satisfied) and `packages/shared/src/lib/crm.ts:832` (CRM identity reads) — but was mounted on the public, user-authenticated router without a caller check.

**Recommended fix:** require `requireInternalKey` on this route and have both legitimate callers present the internal service key; *or* pass an explicit `dispatchReason` and run `evaluatePolicies()` for anything that is not an already-approved `ApprovalRequest` id. Prefer the former — it matches how the codebase already separates internal bridges (`ai-assist.ts:152`).
**Scope:** small (one route + two callers). **Dependencies:** none. **Production exposed:** yes — the prod gateway proxies the same prefix.
**Test plan:** assert 401/403 for a tenant `AGENT` token; assert the approvals dispatcher still succeeds with the internal key; assert `evaluatePolicies` is consulted for any non-approval path.

---

### P1-2 — Entitlement enforcement covers 2.5% of the API surface

**Subsystem:** Billing & entitlements
**State:** **VERIFIED BROKEN**

**Evidence** — exhaustive call-site counts across `services/*/src`, excluding tests:

| Helper | Call sites |
|---|---:|
| `requireFeature(...)` | **11** |
| `requireEntitlement(...)` | **7** |
| `assertEntitled(...)` | **0** |
| `entitledIn(...)` | 0 |
| `assertWithinLimit(...)` | 0 |
| `resolveEntitlements(...)` | 0 |
| `hasFeature(...)` | 0 |
| **Total enforcement points** | **18 of 720 endpoints (2.5%)** |

The 11 `requireFeature` sites are almost entirely one feature: **10 of 11 are in `services/ai/src/routes/shopify-live-chat.ts`** (`SHOPIFY_LIVE_CHAT` ×8, `SHOPIFY_PRODUCT_MESSAGING` ×2); the eleventh is `services/conversation/src/routes/auto-buy.ts:37` (`AUTO_BUY`).

The 7 `requireEntitlement` sites: `ai.employee` (`ai-agents.ts:350`), `ai.copilot` (`ai-assist.ts:366`), `ai.knowledge_base` (`knowledge.ts:75`), `communication.automations` (`chatbot.ts:46`), `voice.call_pilot` (`voice-channels.ts:414`), `communication.broadcasts` (`broadcasts.ts:380`).

Meanwhile `packages/shared/src/lib/features.ts` defines **90 features** and `feature-catalog.ts` is 530 lines of entitlement keys. The overwhelming majority are sold-but-unenforced, or enforced only in the frontend.

**Business impact:** direct commercial leakage — a tenant on a plan that excludes a capability can generally use it by calling the API. **Recommended fix:** derive enforcement from the catalog rather than hand-placing middleware; add a CI check that every `feature-catalog` entry with a declared `enforcementLocations` has a matching call site (see P1-6).

---

### P1-3 — `escalationGates`: a documented safety gate that does not exist

**Subsystem:** AI Employee config / runtime safety
**State:** **VERIFIED BROKEN**

`packages/shared/prisma/schema.prisma:833` documents the field as:

> *"Deterministic escalation gates (LLM-independent triggers). `[{ type: "max_messages"|"keyword"|"max_minutes", value, enabled }]`. Differs from escalationRules (LLM-judged). **Checked in evaluatePolicies() pre-flight so the bot can't bypass them.**"*

**Every occurrence of `escalationGates` in the entire repository:**

```
services/ai/src/routes/ai-agents.ts:506           ← writable-field allowlist (write only)
packages/shared/prisma/schema.prisma:833          ← the column + the false comment
.../20260422200000_.../migration.sql:4,43,45,52   ← column creation + BACKFILL
```

`evaluatePolicies()` lives in `packages/shared/src/lib/tool-gate.ts:120` and **never references it.** The field is written by the API, was **backfilled with real data by the migration** (from the deterministic half of `escalation_rules`), and is never read by anything.

**Impact:** a deterministic, LLM-independent escalation control — precisely the kind a safety reviewer would rely on — is inert. Any tenant that configured it believes the bot will hand off after N messages; it will not. (The separate `maxAutonomousMessages`/`maxAutonomousMinutes` caps **are** genuinely enforced — see §5 — so the practical blast radius is limited to keyword gates and non-default thresholds.)

**Dev-DB check:** 1 agent exists; `escalation_gates` is `[]` for it, so no dev tenant is currently affected.

---

### P1-4 — HIGH-risk mutating tools ship with no approval requirement

**Subsystem:** Tools & HITL
**State:** **VERIFIED BROKEN** (live DB query)

```sql
select c.slug, t.slug, t.category, t.risk_level, t.hitl_policy->>'mode'
from catalog_tools t join integration_catalog c on c.id = t.integration_id
where t.category in ('WRITE','DELETE','ACTION')
  and coalesce(t.hitl_policy->>'mode','never') = 'never';
```

**43 mutating tools default to `never` (fully autonomous). Two are HIGH risk:**

| Integration | Tool | Category | Risk | HITL |
|---|---|---|---|---|
| returngo | `update_transaction` | WRITE | **HIGH** | never |
| shopify | `edit_order` | ACTION | **HIGH** | never |

Also notable at MEDIUM with customer-visible side effects: `shopify.send_invoice`, `shopify.resend_confirmation` (both send real emails to the customer), `shopify.disable_coupon`, `shopify.update_customer`.

Whole integrations ship with **zero** approval-gated tools: HubSpot (10 tools), Salesforce (6), Monday (6), Airtable (4), Fireberry (4).

The schema notes the tenant override is authoritative and *can* tighten this, so a careful tenant is safe. But the shipped default lets an AI employee edit a customer's order without a human ever seeing it.

**Recommended fix:** make `hitlPolicy` default derive from `riskLevel` + `category` rather than being independently seeded, so HIGH/ACTION cannot be `never` without an explicit override.

---

### P1-5 — Two parallel, non-interoperating entitlement systems

**State:** **VERIFIED BROKEN**

| System | Key space | Middleware | Sites |
|---|---|---|---|
| Feature flags | `Feature` enum, 90 entries (`lib/features.ts`) | `requireFeature` (`middleware/feature-gate.ts:23`) | 11 |
| Entitlements | string keys (`billing/feature-catalog.ts`, 530 lines) | `requireEntitlement` (`middleware/entitlement.ts:26`) | 7 |

Two key spaces, two resolvers, two middlewares, no bridge. A capability gated in one system is invisible to the other. This is the "duplicate feature catalogs" pattern, and it is the structural reason P1-2 is hard to fix incrementally.

---

### P1-6 — `enforcementLocations` is documentation presented as a contract

**State:** **VERIFIED BROKEN**

`packages/shared/src/lib/billing/feature-catalog.ts` gives most features an `enforcementLocations` array, e.g.:

```ts
key: "communication.crm_summaries",
enforcementLocations: ["services/ai:post-conversation.summary"],
```

**That location contains no enforcement.** All four post-conversation services report **0** entitlement checks:

```
post-conversation-config.service.ts        0
post-conversation-crm.service.ts           0
post-conversation-rule-engine.service.ts   0
post-conversation-summarizer.service.ts    0
```

and `grep -rn "communication.crm_summaries" services/` returns **nothing** — the key appears only in the catalog and in `plan-seeds.ts:42`.

Because ~20 features carry these declarations, this field reads as an enforcement map to any reviewer. It is not one. **This is why no claim in this audit rests on repository documentation.**

---

### P1-7 — All external integrations unverified against provider documentation

**State:** **UNKNOWN** — not investigated

No official provider documentation was consulted in this pass. Shopify (Core + Chat App), Fireberry, HubSpot, Airtable, AWS RDS, Gmail, Google Calendar, Google Drive, WhatsApp Cloud API, Meta channels, iCount, Bank of Israel FX, Authentik, Twilio and every CRM adapter therefore have **unknown** standing on API version, deprecation, scopes, webhook signatures, pagination and rate-limit handling. This is listed as P1 because unverified third-party contracts are a live reliability risk at scale, not because a specific defect was found.

---

### P2-8 — AIAgent configuration stored but never read

**State:** **VERIFIED BROKEN**

`AIAgent` has ~40 configuration columns. The API accepts **36** as client-writable (`ai-agents.ts:499-509`). The prompt builder reads **9**.

`AgentRecord` (`prompt-builder.service.ts:94`) declares 16 fields; only these 9 are actually accessed via `opts.agent.*`:
`role` ×4 · `escalationRules` ×2 · `customGuardrails` ×2 · `conversationFlow` ×2 · `behavioralAnchors` ×2 · `successCriteria` · `salesContext` · `persona` · `goal` (plus `name`/`identity` via the local `a` binding in `buildIdentity`).

**Declared, plumbed into the prompt builder, then dropped — 5 fields:**

| Field | Evidence | Dev DB |
|---|---|---|
| `toneConfig` | 0 refs in prompt-builder; passed at `ai-bot.service.ts:321` | **populated** |
| `behavioral` | 0 refs in prompt-builder | **populated** |
| `goals` (legacy) | 0 refs in prompt-builder; passed at `ai-bot.service.ts:318` | **populated** |
| `tone` | 0 refs in prompt-builder | — |
| `style` | 0 refs in prompt-builder | — |

**Never read anywhere in the backend — 4 fields:** `interactiveMessages`, `sharedPrompt`, `autonomousPrompt`, `confidenceThreshold`.

`confidenceThreshold` deserves special mention: `services/ai/src/services/ai-agent-defaults.ts:11` explicitly describes it as one of the *"fields that change how the employee actually behaves at runtime (when it escalates, how long it may run unattended)"*. It is written, defaulted to `0.6`, and never read. (The `intelligence-registry`/`intelligence-ingest` hits on that name belong to a **different model**, `IntelligenceDefinition` — not `AIAgent`.)

The single dev-DB agent has `tone_config`, `behavioral`, `goals` and `conversation_flow` all populated — so a real user did configure three settings that do nothing.

**Impact:** users tune personality and safety settings that have no effect; support cannot explain why behaviour does not change. **Fix:** either render them or remove them from the writable allowlist and the UI. Do not leave them writable.

---

### P2-9 — Knowledge-base deletion silently breaks the activation invariant

**State:** **VERIFIED BROKEN**

Activation requires ≥1 knowledge base, enforced server-side in **both** promotion paths (`ai-agents.ts:575-601`, `ai-agent-builder.ts:415-422`) — this part is good, and an unready draft correctly 422s with `{error:"draft_not_ready", missing:[...]}`.

But `AIAgentKnowledge.knowledgeBase` is `onDelete: Cascade` (`schema.prisma`), and `knowledge.ts:132` / `system-chat.ts:106` delete knowledge bases with no downstream check. Nothing re-evaluates agent readiness afterwards.

**Result:** an ACTIVE agent can hold **zero** knowledge bases — the exact state that would have blocked its activation — and keeps serving customers. **Fix:** on KB delete, re-check dependent agents and either warn or pause them.

A second, smaller gap in the same area: the readiness gate at `ai-agents.ts:575` only fires when `existing.status === "DRAFT"`. A **PAUSED → ACTIVE** transition is not readiness-checked. **PARTIALLY VERIFIED** (traced in source; not exercised).

---

### P2-10 — Business hours have no durable store

**State:** **VERIFIED**

Business hours live **only** in Redis at `tenant:{tenantId}:businessHours` (`packages/shared/src/lib/business-hours.ts:50`). There is **no** corresponding Postgres column — `grep -niE "businessHours|business_hours" schema.prisma` returns nothing.

Mitigations, stated fairly:
- **Prod Redis is durable** — `docker-compose.prod.yml` sets `--appendonly yes` with a `redis_data` volume.
- **Dev Redis is not** — no volume, `appendonly no` (confirmed live: `CONFIG GET appendonly` → `no`).
- The fallback is safe: `evaluateBusinessHours(null)` returns `{configured:false, open:true}` (`business-hours.ts`), i.e. always-open, so loss degrades to 24/7 availability rather than a total outage.
- No business-hours keys currently exist in dev Redis (`--scan` returned none).

**Residual risk (P2, not P1):** the data is absent from Postgres backups and DB dumps, has no audit trail, and no migration path. It is a single-store configuration item in a system that otherwise treats Postgres as the source of truth.

---

### P3-11 — Orphan route `/bot` — *superseded by P2-16 (§8e), which proves it from both ends*

**State:** **PARTIALLY VERIFIED**

`frontend/src/app/bot/page.tsx` edits `confidenceThreshold`, `escalationMessage`, `maxAutonomousMessages`, `maxAutonomousMinutes` via `getBotConfig()`. `grep -rn '"/bot"' frontend/src` returns **no navigation reference** — the page is unreachable from the UI but still routable by URL. Two of the four fields it edits are inert (P2-8). Candidate for removal; needs confirmation that `getBotConfig` has no other consumer.

---

## 5. What is verified working

Recording these matters as much as the defects.

| Area | Finding | State |
|---|---|---|
| Service boundary | LLM calls confined to `services/ai`; `incoming-worker/ai-bot.service.ts` is a side-effects shell calling `POST /api/ai-bot/reply`. Not a duplicate. | **VERIFIED WORKING** |
| OAuth state | Single-use `jti` consumed in Redis with `SET NX`; tenant/user/provider/return-context bound *into* the signed state; short TTL; explicitly rejects reading tenant or return URL from the browser at callback time (`oauth-state-store.ts`) | **VERIFIED WORKING** |
| Activation gating | Server-side readiness (name + goal-or-funnel + ≥1 KB) enforced on both promotion paths, with a 422 and a `missing[]` list | **VERIFIED WORKING** |
| Autonomy caps | `maxAutonomousMessages` / `maxAutonomousMinutes` genuinely read and enforced in both `services/ai` (`ai-bot.service.ts:423,459`) and `incoming-worker` (`:575,650`) | **VERIFIED WORKING** |
| Mass-assignment | `AGENT_EDITABLE_FIELDS` explicit allowlist; `tenantId` and `readinessReport` deliberately excluded from client writes | **VERIFIED WORKING** |
| Prompt caching | Deliberate stable-prefix block layout; per-turn block always last; `buildAgentBlock` documented and observed to read only `opts.agent.*` | **VERIFIED WORKING** |
| Human-action RBAC | `commerce-context.ts` gates commerce actions with `requirePermission("customer:commerce:read")` and a permission on the write path | **VERIFIED WORKING** |
| Graph integrity | 0 dangling / missing / collapsed edges after incremental merge | **VERIFIED WORKING** |
| Postgres adapter | Slug mismatch (`postgres` vs catalog `postgresql`) that made every dispatch return `not_connected` was **fixed earlier in this session** and verified live | **VERIFIED WORKING** |

**A near-miss worth recording:** `ai-debug.ts:422` emits `mode: "assist"` while `AgentMode` is `"agent" | "copilot" | "generator"`. This looked like mode drift but is a **debug-response label, not a value passed to the prompt builder**, which handles `copilot` correctly throughout (`prompt-builder.service.ts:343, 747, 781, 1069`). Cosmetic only — **not a defect.**

---

## 6. Runtime AI flow (as traced)

Inbound customer message, from `services/incoming-worker/src/workers/incoming.worker.ts:435-500`:

```
inbound message
  └─ tenant.status === "ACTIVE"?                       (:166, :554) → else drop
  └─ conversation.assignedAgentId set OR isHandedOver? → human owns it, stop
  └─ interactive department-picker payload?
        └─ applyDepartmentPickerReply() → processAIBot(…, pickedAgentId)   [deterministic override]
  └─ messageCount <= 1 AND no departmentId?
        └─ routeConversation()  → handledByAI ? stop : departmentId ? WAITING : inbox
  └─ handledBy === "ai_agent" | "awaiting_approval"?
        └─ processAIBot(tenantId, conversationId, body)     [bot keeps driving during HITL]
  └─ chatbotNodeId set? → FlowCanvas resume (24h comment→DM bridge gate first)
```

`processAIBot` (worker) → HTTP → `services/ai` `POST /api/ai-bot/reply` → Behavior Engine → `buildAgentPrompt()` → LLM → tool loop (**gated** at `ai-bot.service.ts:2066` via `evaluatePolicies`) → reply → worker sends via channel adapter, persists, audits.

**Decision order confirmed:** human assignment > department-picker override > first-message routing > ongoing-AI continuation > flow resume.

**Modes:** `AgentMode = "agent" | "copilot" | "generator"` (`behavior-engine.service.ts:44`). All three share one prompt builder and one agent config — Copilot is **not** a separate brain. Tool surfaces differ by `CatalogTool.allowedModes` (`AUTO` vs `ASSIST`), filtered in `agent-tools.ts:1087-1095`.

**Not validated in this pass:** the full mode state machine (Human only / Copilot / Autonomous / Waiting-for-approval / Takeover / Paused / Closed / Error), memory persistence across conversations, cache behaviour, and dependency-failure paths.

---

## 7. Tool & HITL matrix (catalog level)

| Integration | Tools | HITL always | Auto | No endpoint |
|---|---:|---:|---:|---:|
| shopify | 62 | 6 | 56 | 62 |
| zoho_crm | 22 | 4 | 18 | 0 |
| hubspot | 10 | 0 | 10 | 10 |
| woocommerce | 7 | 1 | 5 | 7 |
| monday | 6 | 0 | 6 | 6 |
| salesforce | 6 | 0 | 6 | 6 |
| stripe | 5 | 3 | 2 | 5 |
| paypal | 5 | 3 | 2 | 5 |
| airtable | 4 | 0 | 4 | 4 |
| mongodb | 4 | 1 | 3 | 4 |
| fireberry | 4 | 0 | 4 | 4 |
| aws_rds | 4 | 1 | 3 | 4 |
| postgresql | 4 | 1 | 3 | 4 |
| returngo | 3 | 0 | 3 | 3 |
| google_calendar | 1 | 0 | 1 | 1 |

Only **zoho_crm** has HTTP endpoints on its catalog rows; every other integration dispatches through a registered adapter. `custom_api` (0 tools) and `calendly` (0 tools, unpublished) carry no executable surface.

**Policy-gate coverage:** `evaluatePolicies()` has **5** call sites repo-wide (`action-orchestrator.ts:147`, `approval-gate.ts:68`, `ai-bot.service.ts:2066`, and the `tool-gate.ts` internals) against ~70 `executeAdapterTool` call sites across 9 files. Most ungated call sites are legitimate — internal CRM read adapters and catalog reads reached through RBAC-gated routes. **The one that is not is P0-1.**

---

## 8. Source of Truth — the summarization question

You asked specifically whether summarization can be sold separately from AI Employees / Copilot / Autonomous execution.

**Answer: architecturally yes, commercially not enforced.**

- A dedicated key exists: **`communication.crm_summaries`** (`feature-catalog.ts:115`) — correctly modelled as its own capability, *not* derived from `ai.copilot` or `ai.employee`. The product requirement is representable. **VERIFIED.**
- The agent-facing summary endpoint `GET /api/ai-assist/:conversationId/summary` (`ai-assist.ts:496`) carries **no entitlement gate at all** — only `authenticate/resolveTenant/requireActiveTenant`. It is *not* coupled to `ai.copilot` (which is correct per your requirement) but it is also not gated (commercial leakage).
- The post-conversation summarizer + CRM writeback path enforces **nothing** (P1-6).

So a Basic plan today receives summaries **whether or not it bought them**, and a plan that *did* buy them is indistinguishable from one that did not. The desired combination is expressible; it simply is not enforced.

**Not audited:** source priority/selection, fallback, conflict resolution, dedup, writeback overwrite semantics, retry behaviour, and cross-customer writeback safety. The Source of Truth matrix is **NOT PRODUCED** in this pass.

---

## 8b. Phase 4 — External integrations (API-version axis only)

Only the version/deprecation axis was audited, and only for the two most load-bearing providers. Both were checked against current official documentation on **2026-07-30**.

### P1-12 — Shopify Admin API pinned ~15 months past end-of-support; drift is silent and undetectable

**State:** **VERIFIED BROKEN**

**Official source:** [Shopify API versioning](https://shopify.dev/docs/api/usage/versioning), checked 2026-07-30.
- Versions ship quarterly; each is supported **a minimum of 12 months**.
- Supported as of mid-2026: **2025-07** (accessible until 2026-07-16), **2025-10**, **2026-01**, **2026-04**.
- Behaviour on an unsupported version, quoted: *"If your app targets an inaccessible version, Shopify **falls forward** and responds using the **oldest accessible stable version**."*
- Detection mechanism, quoted: the `X-Shopify-API-Version` response header — *"If it differs from what you requested, your app is targeting an inaccessible version."*

**Code:** `services/ai/src/services/connectors/shopify.adapter.ts:38` — `const API_VERSION = "2024-04"`. This single constant drives every REST call for all **62** Shopify catalog tools.

`2024-04` reached end-of-support around **April 2025** — roughly **15 months ago**.

**`grep -rin "x-shopify-api-version"` across the entire repository returns nothing.** The response header that exists precisely to detect this condition is never read.

**Why this matters more than a stale constant:** because Shopify falls forward rather than failing, the integration *appears* to work. What the app actually talks to is "whatever Shopify's oldest supported version happens to be this quarter" — a contract that **changes every three months with no deploy, no code change, no test signal and no alert**. Most recently it shifted on **2026-07-16, fourteen days before this audit**, when 2025-07 retired.

The last three commits on this branch are `fix(commerce): the three live failures — invalid restock, uncancellable orders, an action that cannot exist`, `fix(commerce): restocking needs a location…`, and a related fix. Whether those were caused by version drift was **not established** — but uncontrolled quarterly contract movement is exactly the mechanism that produces that class of surprise, and it is worth checking as a first hypothesis.

**Recommended fix (ordered):** (1) read `X-Shopify-API-Version` on every response and log/alert on mismatch — this is cheap and converts an invisible failure mode into a visible one; (2) move the pin to a supported version and add a quarterly review; (3) add a startup assertion that the pinned version is still accessible.

### P1-13 — Shopify webhook API version differs between dev and prod

**State:** **VERIFIED BROKEN**

| File | `[webhooks] api_version` |
|---|---|
| `shopify-app/shopify.app.toml` (**prod**) | `2024-04` |
| `shopify-app/shopify.app.dev.toml` (**dev**) | `2026-10` |
| `shopify-app/extensions/gotcha-chat/shopify.extension.toml` | `2024-04` |

Webhook payload shape is version-dependent, so **dev does not exercise the payloads prod receives**. Any webhook validated in dev is validated against a different contract.

Notably, the dev file already carries a comment acknowledging the problem:

> *"Shopify's CLI wrote 2026-10 when it created the app; 2024-04 (this repo's original value) is long past its supported window… the Admin REST version pinned in shopify.adapter.ts is a separate, older concern."*

So this was known and recorded but not remediated — another instance of the §2 pattern where repository documentation describes a state the system has not reached.

### P1-14 — Meta Graph API: WhatsApp and Messenger pinned to an expired version; three versions in one package

**State:** **VERIFIED BROKEN**

**Official source:** [Meta Graph API versioning](https://developers.facebook.com/docs/graph-api/guides/versioning), checked 2026-07-30.
- Each version is supported **a minimum of two years**; quoted: *"A version will no longer be usable two years after the date that the subsequent version is released."*
- Behaviour after expiry, quoted: *"any calls made to it will be defaulted to the next oldest, usable version"* — the same silent fall-forward as Shopify.
- Current latest: **v26.0**.

| Adapter | Pinned version | File |
|---|---|---|
| **WhatsApp** | **v19.0** | `packages/shared/src/channels/whatsapp.adapter.ts:13` |
| **Messenger** | **v19.0** | `packages/shared/src/channels/messenger.adapter.ts:12` |
| Instagram | v21.0 | `packages/shared/src/channels/instagram.adapter.ts:12` |
| Channel connect routes | v21.0, and v25.0 | `services/auth/src/routes/channels.ts:45, :289` |

v19.0 dates from early 2024; with v20.0 released mid-2024, v19.0 fell out of the usable window around **mid-2026** — i.e. it is expired now. **WhatsApp is the platform's primary channel.**

Three different Graph versions (v19/v21/v25) coexist inside one package with no shared constant, so behaviour differs per channel with no single place to change it.

**Mitigating detail, stated fairly:** all of these read from environment variables first (`WHATSAPP_API_URL`, `FACEBOOK_API_URL`), so a deployment *can* override the pin without a code change. Whether production does so was **not verified** — production configuration was deliberately not inspected. If the env vars are unset in prod, the expired default applies.

### Cross-cutting conclusion

Both primary integrations depend on a provider that **silently serves a different API version than the one requested**. Neither has any detection. This is one systemic defect with two instances, and it is cheap to close: read the version header (Shopify) and centralise the Graph version behind one constant with a startup assertion (Meta).

### Not audited for any provider

OAuth init/callback correctness per provider, PKCE where applicable, token refresh and revocation, webhook signature schemes, retry/backoff, rate-limit handling, pagination, idempotency keys, field mapping, disconnect/reconnect, and frontend connection UX. The OAuth **state** mechanism is shared and was verified (§5), but each provider's own flow was not.

---

## 8c. Phase 7 — i18n (key-parity axis only)

Graphify does not index `en.json`/`he.json` (§1), so this was done by direct file analysis.

### Result: i18n is in strong shape. No defect found on the parity axis.

| Check | Result |
|---|---|
| EN keys | 4,261 |
| HE keys | 4,262 |
| Shared | 4,261 |
| **Missing in Hebrew** | **0** |
| Missing in English | **1** — `outbound.broadcasts.modePickDesc2` (orphan HE key) |
| Identical EN/HE values | 56 — **all legitimate**: proper nouns (WhatsApp, Google Drive, Twilio, Confluence), technical identifiers (Account SID, Auth Token, Call SID, E.164, Webhook URL), placeholders (`sk-…`, `+972…`, `field_key`), numeric ranges (`11-50`, `201+`) |
| **Em/en dash in user-facing copy** | **0 in both locales** — the documented project rule is genuinely upheld |

Full key parity across 4,261 keys in two locales, with a real RTL language, is an unusually good result and should be recorded as such.

### Two measurements I ran that turned out to be unreliable — reported as such rather than as findings

**Orphan keys — INCONCLUSIVE.** A naive scan says 1,721 keys are never referenced by a literal `t("…")` call, of which 1,003 also have an unreferenced parent namespace. **That number is not trustworthy.** The codebase contains **93** dynamic template calls that build keys from data, e.g.:

```
t(`aiStudio.knowledge.typeLabels.${typeKey}`)
t(`shopifyInstall.error.${urlError}`)
t(`settings.days.${day}`)
```

Spot-checking 8 "orphans" found several that *are* used through exactly these patterns (`shopifyChat.trigger.exit_intent`, `settings.days.friday`). Static analysis cannot resolve them. A real orphan census needs runtime key-access instrumentation over a full journey sweep; until then, **no key should be deleted on the strength of a grep.**

**Hardcoded strings — NOT A DEFECT.** A scan finds Hebrew literals in 48 `.tsx` files, only 12 of which use the `L(en, he)` helper. Spot-checking the other 36 shows they use *other* deliberate bilingual patterns:

```tsx
// ToolAvailabilityReason.tsx:18
return he ? "לא נכלל בתוכנית שלכם" : "Not included in your plan";
// MessageSignals.tsx:147  → locale-keyed lookup
// pricing/page.tsx:218    → "עברית" in a language switcher (correctly untranslated)
```

Both languages are present in every case. These are not untranslated strings.

### The one real observation: three parallel i18n mechanisms

The product localises through **three** different mechanisms — `t("key")` against the JSON catalogs, the `L(en, he)` inline helper, and bare `he ? … : …` ternaries. All three work and all three ship both languages, so there is no user-visible defect. The cost is maintainability: the 4,261-key catalog is **not** the single source of truth, a translator cannot find copy that lives in a ternary, and no tooling can audit coverage across all three. **P3 — consolidate over time; nothing is broken today.**

### Not audited in Phase 7

Duplicate/dead routes, navigation consistency, stale components, duplicate modals and preview implementations, API-errors-as-domain-states, loading gaps, mobile layout, RTL rendering correctness, accessibility, design-system adherence, and raw identifiers shown to users. Only the i18n key axis was covered.

---

## 8d. Phase 8 — Database schema (integrity + retention axes)

147 tables in the dev database: **70 with rows, 77 empty.** (`pg_stat_user_tables` after an explicit `ANALYZE` — the pre-ANALYZE statistics were stale and reported 0 for tables that demonstrably have rows; any audit reading `n_live_tup` without ANALYZE first will be wrong.)

### P1-15 — A subscription can be ACTIVE with no tenant reachable from it

**State:** **VERIFIED BROKEN** (design gap, demonstrated by data)

`subscriptions` has **no `tenant_id` column.** Tenancy is reachable only indirectly:

```
subscription → billable_entity_id → billable_entities → billable_entity_tenants → tenant
```

`billable_entities` also has no tenant column — it holds only `id`, `kind`, `display_name`, timestamps. **Nothing in the schema requires a `BillableEntity` to be linked to a tenant at all.**

Live counts:

| | |
|---|---:|
| tenants | 3 |
| billable_entities | 11,441 |
| billable_entity_tenants (links) | **3** |
| subscriptions | 874 |
| **subscriptions whose billable entity has no tenant link** | **871** |
| …of which status = **ACTIVE** | **871** |

So 871 subscriptions are `ACTIVE` and belong to no tenant that can be reached from them.

**Two separate problems, and they should not be conflated:**

1. **Dev-data pollution (dev-only).** The creation dates line up exactly with the recent billing work — 8,768 billable entities on 2026-07-27, 2,203 on 07-28, 390 today. Billing integration tests write to the shared dev database and never clean up. Consequence: any count, report or manual QA against dev billing data is meaningless, and the pollution is ongoing.
2. **A real constraint gap (all environments).** No FK, no `NOT NULL`, and no application invariant requires a BillableEntity to have a tenant. The test data merely *demonstrates* the hole; it did not create it. In production this shape means a chargeable subscription with no traceable owner.

**Good design detail, recorded fairly:** `billable_entity_tenants.tenant_id` carries a **UNIQUE** index, so one tenant maps to at most one billing identity. That correctly prevents the "multiple active subscriptions per tenant" failure the audit brief asks about — the risk here is the opposite direction (entities with no tenant), not duplicates.

**Recommended fix:** make the tenant link mandatory at creation, add an invariant check, and give the billing integration tests a transactional rollback or a dedicated throwaway database.

### Retention — better than expected, but partial

A retention purge exists and is genuinely wired up: `services/ai/src/index.ts:208` starts `startRetentionScheduler` on boot (observed live in the container logs: `[retention-purge] scheduler started (cron="30 3 * * *")`), with a manual trigger at `POST /api/gdpr-internal/run-retention-purge`.

**In scope (5 models):** `message`, `usageLog`, `auditLog`, `billingWebhookEvent`, `reasonerShadowEval`.

This **corrects** the usual "unbounded audit table" concern — `audit_logs` *is* bounded by policy.

**Not in scope, and growing:**

| Table | Rows | Window | Rate |
|---|---:|---|---|
| `agent_loop_iterations` | 1,325 | 4 days | ~330/day |
| `agent_loop_runs` | 300 | 4 days | ~75/day |
| `billable_entities` | 11,441 | 5 days | test-driven |

`agent_loop_iterations` is the Reasoner shadow corpus. At ~330/day in a **near-idle** dev environment with 3 tenants, this is the table most likely to become a production problem, and it has no retention policy. **P2.**

### Not audited in Phase 8

Per-model owner/read-path/write-path mapping (143 models), deprecated columns, legacy onboarding blobs, old role/plan/feature-flag fields, dangerous cascade deletes beyond the two examined, plaintext-secret scan, JSON-blob-vs-relational review, and the keep/migrate/archive/remove classification. The 77 empty tables were **not** individually classified — an empty table in a near-idle dev database is not evidence of a dead table, and saying otherwise would be exactly the kind of grep-deep conclusion this audit has already had to retract three times.

---

## 8e. Phase 9 — Dead code (frontend routes axis)

### P2-16 — Two substantial pages that render, then fail on every load

**State:** **VERIFIED BROKEN** — confirmed from both ends (unreachable *and* calling deliberately-retired endpoints)

| Page | Lines | Calls | Backend response |
|---|---:|---|---|
| `frontend/src/app/copilot/page.tsx` | **1,035** | `GET/PUT /api/agents/settings/copilot` | **410 Gone** |
| `frontend/src/app/bot/page.tsx` | **395** | `GET/PUT /api/agents/settings/first-take-care` | **410 Gone** |

`services/auth/src/routes/agents.ts:729-744`:

```ts
// Legacy copilot/first-take-care settings - now managed via AI Employees in AI Studio
router.get("/settings/copilot", requireRole("ADMIN"), async (_req, res) => {
  res.status(410).json({ error: "Deprecated. AI configuration is now managed via AI Employees in AI Studio." });
});
router.get("/settings/first-take-care", requireRole("ADMIN"), async (_req, res) => {
  res.status(410).json({ error: "Deprecated. Bot configuration is now managed via AI Employees in AI Studio." });
});
```

Neither page has any inbound navigation reference. The **live** Copilot surface is `components/conversations/CoPilotPanel.tsx` (71 KB), mounted at `ChatPanel.tsx:977`.

**The backend deprecation was done correctly and honestly** — explicit 410, explanatory message, pointer to the replacement. The frontend pages were simply never deleted. ~1,430 lines of dead UI that a user reaching the URL sees render and then error.

`/copilot/page.tsx` also initialises `DEFAULT_IDENTITY / DEFAULT_GOALS / DEFAULT_TONE / DEFAULT_BEHAVIORAL` — the same shapes as the inert `AIAgent` columns in **P2-8**. Removing this page and those columns is one coherent piece of work, not two.

**Removal risk:** low. Verify no other consumer of `getBotConfig` / `getFirstTakeCareSettings` / `getCopilotSettings` first, then delete the three API wrappers, both pages, and the four 410 handlers together.

### What is NOT dead — recorded to prevent a bad cleanup

An orphan-route scan flags 23 pages. Most are **false positives**, and deleting on that signal would break the product:

- **Deliberate compatibility redirects, each with a comment explaining why it exists:** `/business` → `/ai-studio/knowledge`, `/settings/permissions` → `/settings/people?tab=users`, `/settings/agents` → `/settings/people?tab=users`. These preserve old bookmarks by design.
- **External entry points** that legitimately have no inbound frontend link: `/auth/callback`, `/auth/flow-done` (Authentik), `/checkout/cancelled` (payment provider return), `/shopify/chat/install` (Shopify app install), `/terms`, `/privacy-policy`.
- **Thin `AppLayout` wrappers around a real `./content` module**, reachable by deep link: `/agents`, `/usage`.

Substring matching also fails badly here — `/usage` appears to have 18 "references" that are all `/api/usage/...` API paths, and `/business` 24 that are all `/business-systems` or `/api/business/...`. **Route-level dead-code detection in this codebase requires exact-quoted matching plus manual classification.**

### Not audited in Phase 9

Unused exports, unused services/adapters, dead UI components below route level, duplicate permission models, duplicate integration registries, unused environment variables, stale feature flags, commented-out production code, and test fixtures reachable in production. Only the frontend route axis was covered.

---

## 9. Confirmations

- **No code was changed during this audit.** The only files written are this document and `services/ai/scripts/verify-workspace-sidebar.ts` (a read-only diagnostic created earlier in the session, before the audit began).
- **No production configuration was changed.**
- **Nothing was pushed, merged, deployed, or opened as a PR.**
- **No migrations were run during the audit.** (One migration was applied to the *dev* database earlier in this session, before audit mode, as part of the preceding fix task.)
- **No destructive actions, no charges, no refunds, no customer messages, no provider configuration changes.** The single live HTTP probe used an unauthenticated request with a non-existent provider name and returned 401 before reaching any provider.
- **No secrets or tokens printed.**
- Graphify rebuild wrote only to `graphify-out/`.

---

## 10. Exact inspections run

**Graphify:** `detect_incremental` · AST extraction (941 files) · 6 semantic subagent chunks · `build_merge` with deleted-source pruning · `cluster` + `score_all` · `diagnose_extraction` (health gate) · community labelling (61 named) · `export html` · `graph_diff` vs prior graph · manifest + cost save.

**Database (read-only, dev):** catalog integrations × tool counts; catalog tool endpoints; `tenant_integrations` status; `ai_agents` inert-column population; mutating tools with `hitl_policy = never`; HITL policy distribution per integration.

**Live probes:** `POST /api/ai-assist/test-conv/adapter-tools/execute` (unauthenticated, bogus provider) → 401; `GET /api/ai-assist/tools/registry` → 401; `redis-cli CONFIG GET save/appendonly`; `redis-cli --scan 'tenant:*:businessHours'`; `docker compose ps`.

**Source analysis:** exhaustive call-site enumeration for `evaluatePolicies`, `executeAdapterTool`, `requireFeature`, `requireEntitlement`, `assertEntitled`, `entitledIn`, `assertWithinLimit`, `resolveEntitlements`, `hasFeature`, `escalationGates`, `readinessReport`, `refreshCapabilityState`; `AGENT_EDITABLE_FIELDS` vs `AgentRecord` vs `opts.agent.*` diff; nginx/gateway location blocks for `/api/ai-assist`; endpoint counts per service; Prisma model/enum/migration counts.

**Documentation consulted:** none external. Repository documents were read but, per P1-6, **not treated as evidence**.

---

## 11. Remediation roadmap

### Immediate — before next release

1. **P0-1** — gate `adapter-tools/execute` behind `requireInternalKey`; update `approvals.ts:130` and `crm.ts:832` to present the key. *Small. No dependencies.*
2. **P1-4** — re-seed `hitlPolicy` so HIGH-risk and `ACTION` tools cannot default to `never`; at minimum `shopify.edit_order` and `returngo.update_transaction`. *Small; data migration.*
3. **P1-3 + P1-3b** — the two inert safety controls. Either implement `escalationGates` in `evaluatePolicies()` and enforce `capabilities.auto/assist` at dispatch eligibility, or remove both from the schema, the write allowlist and the editor UI. **Do not leave a control that an admin can set and that does nothing.** *Small.*
4. **P1-12 (detection half)** — read `X-Shopify-API-Version` on every Shopify response and alert on mismatch. This is a few lines, requires no version bump, and converts an invisible quarterly-drift failure mode into a visible one. Do this before the version bump, not after. *Small.*
5. **P1-13** — align `shopify.app.toml` (prod) webhook `api_version` with dev so prod webhooks are exercised before release. *Small; coordinate with the Partner dashboard.*

### Next hardening sprint

6. **P1-2 / P1-5** — choose one entitlement system; migrate the other; add a CI assertion that every catalog feature with `enforcementLocations` has a real call site (closes **P1-6** structurally).
7. **P1-12 / P1-14 (version half)** — move Shopify off `2024-04` to a supported version; centralise the Meta Graph version behind one constant and move WhatsApp/Messenger off v19.0. Add a startup assertion in both cases. *Medium — needs regression testing against real payloads.*
8. **P1-7** — complete Phase 4 for the remaining **18** providers, and for the axes not yet covered on any provider (OAuth per flow, webhooks, retries, rate limits, pagination, idempotency).
9. **P2-9** — re-check dependent agents on knowledge-base deletion; extend the readiness gate to PAUSED → ACTIVE.
10. Gate the summary endpoints on `communication.crm_summaries` — deliberately **not** on `ai.copilot`, preserving the Basic-plan combination you specified.

### Product-consistency sprint

11. **P2-8** — for each of the 9 inert AIAgent fields, decide render-or-remove; strip removed ones from `AGENT_EDITABLE_FIELDS` and the UI.
12. **P2-16** — delete `/copilot` + `/bot` pages, their three API wrappers, and the four 410 handlers as one change (~1,430 lines). Pair with P2-8, which covers the same config shapes.
13. Phase 7 — i18n parity is clean; the remaining frontend axes (dead routes, duplicate UX, RTL, a11y, design-system drift) are **not started**. Consolidating the three i18n mechanisms is P3.

### Technical debt

14. **P2-10** — give business hours a Postgres home with Redis as cache.
15. **P1-15** — make the BillableEntity→tenant link mandatory; give billing integration tests a throwaway DB. Add retention for `agent_loop_iterations`. Phase 8's 143-model classification and Phase 9's dead-code sweep remain **not started.** The Graphify prune list already names five deleted modules (`AgentBuilder.tsx`, `setup/verify/page.tsx`, `PolicyAdmin.tsx`, `auth.service.ts`, `BusinessTwin.tsx`) as a starting point.

---

## 12. Unknowns and limitations

- **Phases 4, 7, 8, 9 were not executed**; 2, 5, 6, 10 are partial. Section 0 states this per phase.
- **No official provider documentation was consulted.** Every external integration is **UNKNOWN**.
- **Dev estate is nearly empty** — 1 AI agent, 3 tenant integrations (all Shopify), 0 business-hours keys. Dev-DB queries prove *code* behaviour, not fleet behaviour. Production data was not accessed.
- **No runtime browser verification** was performed; no authenticated end-to-end journey was exercised. P0-1 was proven by route/guard analysis plus an unauthenticated reachability probe, not by executing a privileged action — deliberately, since doing so would have fired a real provider call.
- **The working tree has 67 uncommitted modifications.** Findings reflect the working tree, not `HEAD` alone.
- **Test suites were not run as part of the audit.** Test-coverage claims are therefore absent from this document.

---

# PART II — Audit continuation, 2026-07-31

**Branch/HEAD unchanged:** `scratch/shopify-live-chat-on-pricing` @ `b83b190`.
**Working tree:** 67 modified, 11 untracked — **unchanged by this pass** (the only new file is this document's own edit).
**Graphify:** re-verified current — **0 of 53** changed/untracked source files are missing from the 12,687-node graph.

## II-0. Working-tree limitation (recorded per instruction)

Every finding in this document describes the **working tree**, not `HEAD`. 67 files carry uncommitted changes concentrated in `frontend` (24), `services/billing` (8), `packages/shared` (7), `services/ai` (6), `services/auth` (4). Consequences:

- A finding may describe code that is not yet committed and could change before merge.
- Conversely, `HEAD` alone would **not** reproduce these results.
- Test results below likewise reflect the working tree.

Anyone re-running this audit must first `git stash` or check out the same tree to reproduce.

## II-1. Autopilot / OMC state — recursive verification

Instructed not to rely on top-level greps. A recursive sweep of `.omc/state/**` (not just `.omc/state/*.json`) found **10 states with `active: true`**, which the previous pass missed because it globbed only the top level.

| Session | File | Last checked | Action |
|---|---|---|---|
| 5486fc47 | ecomode-state.json | 2026-06-18 | closed |
| 1ca2849b | autopilot-state.json | 2026-07-02 | closed |
| b2db2c1c | autopilot-state.json | 2026-07-04 | closed |
| 914df105 | autopilot-state.json | 2026-07-20 | closed |
| 9582715e | ecomode-state.json | 2026-07-21 | closed |
| 9ee73943 | autopilot-state.json | 2026-07-23 | closed |
| 7b45f746 | ecomode-state.json | 2026-07-24 | closed |
| 152a05f7 | autopilot-state.json | 2026-07-28 | closed |
| 5ed14cd0 | autopilot-state.json | 2026-07-28 | closed |
| **15f2995b (this session)** | autopilot-state.json | **2026-07-31** | **left active — see below** |

Nine abandoned states (dead sessions, all far beyond the hook's 2-hour staleness threshold) were set `active: false` with a `closed_by` note.

**The tenth cannot be cleared from inside the session.** It was set `active: false` at the end of the previous turn. This turn it reappeared as a **brand-new file**: `started_at` = this prompt's timestamp, `reinforcement_count: 0`, and the previous `completed_at` note gone. The `UserPromptSubmit` hook re-creates it on every prompt matching its autopilot keyword.

**Root cause:** OMC **v4.2.5** installed; **v4.15.7** available. In v4.2.5 `/oh-my-claudecode:cancel` is a self-referential deprecation loop — it prints "invoke the skill instead" for the skill just invoked, and `--force` behaves identically. **The remedy is `omc update`, not anything inside the repository.** Until then any prompt containing the keyword re-arms the state.

## II-2. Test, typecheck and build results — exact commands and exit codes

All run against the working tree. `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/whatsapp_cc`.

| Target | Command | Exit | Result |
|---|---|---:|---|
| packages/shared | `npx vitest run` | **0** | 61 files, **895/895 pass** |
| frontend | `npx vitest run` | **1** | 62 files, **882/882 pass** + 1 unhandled error |
| services/ai | `npx vitest run` | 1 | 127 files (9 failed), 1560 pass / **23 fail** |
| services/auth | `npx vitest run` | 1 | 17 files (1 failed), 147 pass / **4 fail** |
| services/billing | `npx vitest run` | 1 | 41 files (1 failed), **661/661 pass** |
| services/conversation | `npx vitest run` | 1 | 8 files (1 failed), 54 pass / **1 fail** |
| services/voice-copilot | `npx vitest run` | 1 | 17 files (1 failed), 137 pass / **6 fail** |
| services/incoming-worker | `npx vitest run` | 1 | 6 files (1 failed), **32/32 pass** |
| services/chatbot | `npx vitest run` | **0** | 19/19 pass |
| services/webhook | `npx vitest run` | **0** | 39/39 pass |
| services/notifications | `npx vitest run` | **0** | 7/7 pass |
| services/analytics | `npx vitest run` | **0** | 4/4 pass |
| services/outgoing-worker | `npx vitest run` | 1 | **No test files** |
| **Typecheck ×13** | `npx tsc --noEmit -p tsconfig.json` | **0** | **all 13 workspaces clean** |
| Frontend prod build | `npx next build` | **0** | succeeds |
| Compose (dev) | `docker compose config -q` | **0** | valid |
| Compose (prod) | `docker compose -f docker-compose.prod.yml config -q` | — | requires `AUTHENTIK_PG_PASS`; validates only with prod env present |

**Aggregate: ~4,400 tests, ~34 failing (0.8%).**

### Correction to Part I

Part I reported the shared suite as "4 failed files / 49 failed tests." **That was environmental, not a defect.** The failures were `error: Environment variable not found: DATABASE_URL` — `enforcement-tenant-state.test.ts` and `paid-access-gate.test.ts` do not self-provision the URL the way the billing integration tests do. With it set, shared is **895/895, exit 0**.

### Two test-infrastructure observations

1. **`frontend` exits 1 with every test passing.** An unhandled error escapes `src/components/shopify/__tests__/storefront-widget.test.ts:271` after the suite completes. CI fails on a green suite. **P2.**
2. **Several suites report "1 file failed" with zero failing tests** (billing, incoming-worker) — collection/import errors, not assertion failures. Worth separating in CI reporting.
3. **`services/outgoing-worker` has no tests at all** — a service that dispatches every outbound customer message. **P2 coverage gap.**

## II-3. P0-1 SCOPE EXPANDED — a second ungated execution route

**Instruction was to keep P0-1 open and unchanged *unless new evidence changes its scope*. New evidence changes its scope: there are two such routes, not one.**

Both live in `services/ai/src/routes/ai-assist.ts`, both under the same guard line 252 — `authenticate, resolveTenant, requireActiveTenant()` — with **no `requirePermission`, no `requireRole`, no `requireInternalKey`**:

| Route | Line | Sink | Policy references in sink |
|---|---:|---|---:|
| `POST /:conversationId/adapter-tools/execute` | 704 | `executeAdapterTool(provider.tool, args)` | **0** |
| `POST /:conversationId/tools/execute` | **673** | `executeTool({tenantToolId, input})` → adapter | **0** |

`services/ai/src/services/tool-execution.service.ts` contains **zero** references to `evaluatePolicies`, `hitl`, or `approval` (verified by count). At line 130 it routes endpoint-less catalog tools straight to `executeAdapterTool`.

Live probe (unauthenticated, no side effects):
```
POST /api/ai-assist/x/tools/execute          -> HTTP 401
POST /api/ai-assist/x/adapter-tools/execute  -> HTTP 401
```
401 not 404: both are reachable through nginx and gated **only** by authentication.

**Revised statement of P0-1:** an authenticated member of an active tenant — including the lowest-privilege `AGENT` — can execute provider actions by **two** independent routes, bypassing tool permissions, HITL approval, and risk classification. Tenant isolation and provider scopes still hold.

## II-4. DISPROVED — the AI runtime's tool dispatch IS correctly gated

A significant negative result, established by reading the dispatcher end to end.

`packages/shared/src/lib/agent-tools.ts` → `dispatchToolCall()` (line 1239). Both the policy gate and every dispatch branch are inside **the same function**:

- **line 1303** — `evaluateToolGate(ctx.tenantId, name)` (which wraps `evaluatePolicies`, `tool-gate.ts:434`)
- line 1305 — `DENY` → early return, `denied: true`
- line 1312 — `REQUIRE_APPROVAL` → approval request, or in `copilot` mode a `proposeQuickAction` hand-back
- line ~1272 — sandbox guard: blocks `action`-classified tools when `sandbox.writes !== "real"`
- **line 1933** — the dotted `<provider>.<tool>` adapter branch, reached only after all of the above

`services/ai/src/services/orchestrator/action-orchestrator.ts:147` independently gates with `evaluatePolicies` **and** a tenant business-policy check, and **fails closed** on gate error.

**Conclusion: the autonomous bot and Copilot cannot bypass tool policy.** The exposure is exclusively the two HTTP routes in §II-3 that never enter `dispatchToolCall`. This materially narrows the blast radius of P0-1 and should be stated whenever it is escalated.

## II-5. Complete classification of all 66 `executeAdapterTool` call sites

Part I said "most are probably legitimate." That is now replaced with a full classification.

| # | Location | Entry point | Gate | Verdict |
|---:|---|---|---|---|
| 1 | `routes/ai-assist.ts:712` | HTTP `adapter-tools/execute` | **none** | **P0-1** |
| 2 | `routes/integrations.ts:481` | HTTP, connection live-ping | `requirePermission(integrations:connections:read)` — READ tool only, `args:{}` | OK (RBAC, read-only) |
| 3 | `routes/integrations.ts:913` | HTTP `monday-boards` picker | same router guard; `monday.list_boards` | OK (RBAC, read-only) |
| 4–7 | `commerce-actions.service.ts:63,172,217,393` | `routes/commerce-context.ts` | `requirePermission(customer:commerce:read)` + write permission | OK (RBAC; human-initiated) |
| 8–9 | `ai-bot.service.ts:1693,1699` | `requestIdentityVerification` | internal scope; result never returned to the model; OTP to stored destination only | OK by design |
| 10 | `ai-bot.service.ts:1737` | `runAdapterTool` (LLM) | **gated** — `dispatchToolCall` §II-4; passes `accessScope:"customer"` for the cross-customer guard | OK |
| 11–13 | `commerce-context.service.ts:452,549,563` | context-panel read | reached via RBAC-gated route | OK (read-only) |
| 14–17 | `shopify-catalog.service.ts:80,121,162,205` | catalog reads / capability probe | server-side reads | OK (read-only) |
| 18 | `tool-execution.service.ts:130` | `executeTool` | **none in sink** — see callers below | **conditional** |
| 19 | `shopify-chat-install.service.ts:245` | install-time domain refresh | install lifecycle, read | OK |
| 20–66 | `crm-adapter.impl.ts` ×47 | 7 `CRMAdapter` classes (HubSpot, Salesforce, Zoho, Shopify, Fireberry, Airtable, NoOp) via `crm-adapter-resolver.ts:176-190` | interface methods; reached from CRM prefetch, post-conversation writeback, and the gated bot path | OK — **not directly reachable over HTTP** |

**`executeTool` callers (resolving #18):**
- `crm-prefetch.service.ts:166,192,217,232` — server-side prefetch, no user input → OK
- **`routes/ai-assist.ts:678` — HTTP, arbitrary `tenantToolId` + `input`, ungated → the second P0 route**

**Net: 64 of 66 legitimate; 2 constitute P0-1.**

## II-6. Official documentation matrix (checked 2026-07-31)

| Provider | Doc | Code version | Provider status | Verdict |
|---|---|---|---|---|
| **Meta Graph** (WhatsApp, Messenger) | [Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog) | **v19.0** | released 2024-01-23, **unavailable 2026-05-21** | **VERIFIED BROKEN — expired 71 days** |
| Meta Graph (Instagram) | same | v21.0 | 2024-10-02 → 2027-01-21 | OK |
| Meta Graph (channel routes) | same | v21.0 / v25.0 | valid | OK, but 3 versions in one package |
| **Shopify Admin** | [API versioning](https://shopify.dev/docs/api/usage/versioning) | **2024-04** | supported: 2025-10, 2026-01, 2026-04 | **VERIFIED BROKEN — ~15 months past EOS** |
| **Stripe** | [API versioning](https://docs.stripe.com/api/versioning) | **no `Stripe-Version` header sent** | falls back to the **account dashboard default**; current `2026-07-29.dahlia` | **VERIFIED BROKEN — version invisible to code** |
| **HubSpot** | [API overview](https://developers.hubspot.com/docs/guides/api/overview) | `/crm/v3/` | moved to **date-based versioning** (e.g. 2026-03); old versions work until EOL | **PARTIALLY VERIFIED — legacy scheme** |
| monday.com | [API versioning](https://developer.monday.com/api-reference/docs/api-versioning) | `API-Version: 2024-10` | Maintenance since 2025-01-15, still supported | **VERIFIED WORKING** |
| Salesforce | [REST API versions](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/intro_rest_api_versions.htm) | v60.0 | latest 67.0 (Summer '26); v60.0 still listed | **PARTIALLY VERIFIED** — EOL policy page not read |
| Gmail | [API release notes](https://developers.google.com/workspace/gmail/api/release-notes) | v1 | current, no sunset; quota tiering changes May 2026 | **VERIFIED WORKING** |
| Google Calendar / Drive | — | v3 / v3 | stable | **PARTIALLY VERIFIED** (not individually fetched) |
| Airtable | [Web API changelog](https://airtable.com/developers/web/api/changelog) | v0 | unversioned Web API; **user API keys deprecated Feb 2024** — code uses OAuth2+PKCE | **VERIFIED WORKING** |
| Twilio | [REST API](https://www.twilio.com/docs/glossary/what-is-a-rest-api) | 2010-04-01 | still the current identifier | **PARTIALLY VERIFIED** — deprecation page not reachable |
| WooCommerce | — | v3 | current | **UNKNOWN** |
| Zoho / Fireberry / ReturnGO / PayPal / iCount / BoI FX / Authentik / Calendly / AWS RDS / PostgreSQL / MongoDB | — | see Part I | not checked | **UNKNOWN** |

**New P1-17 — Stripe API version is not pinned in code.** No `Stripe-Version` header is sent anywhere. Per Stripe's documentation the account's dashboard default then applies, so the effective contract lives in a web console rather than the repository, is invisible to code review, and changes without a deploy. Same failure class as Shopify and Meta, third instance.

**Pattern across three of the four largest integrations:** the effective API version is decided outside the codebase and drifts silently. Shopify and Meta fall forward on expiry; Stripe reads a dashboard setting. None is detected in code.

## II-7. Phase status after Part II

| Phase | Status | What remains |
|---|---|---|
| 0 Graphify | **COMPLETE** | — |
| 1 AI Employee creation | **PARTIAL** | hiring chat, templates/clone, resume, onboarding-created employee, per-field table not finished |
| 2 AI runtime | **SUBSTANTIALLY COMPLETE** | dispatch + gating proven (§II-4); full 12-state machine not runtime-exercised |
| 3 Tools & HITL | **SUBSTANTIALLY COMPLETE** | all 66 call sites classified (§II-5); per-tool 147-row matrix not built |
| 4 Integrations | **PARTIAL** | 12 of ~26 providers doc-checked on the version axis; OAuth/webhook/pagination/rate-limit/idempotency axes not covered for any |
| 5 Source of Truth | **PARTIAL** | unchanged from Part I |
| 6 Billing/entitlements | **PARTIAL** | unchanged from Part I |
| 7 Frontend/i18n | **PARTIAL** | unchanged; no browser journey run |
| 8 Database | **PARTIAL** | unchanged from Part I |
| 9 Dead code | **PARTIAL** | route axis done; exports/components/env-vars not swept |
| 10 Verdict | **PARTIAL** | bounded by the above |

**Not achieved: "every phase COMPLETE or explicitly BLOCKED."** Nothing is environment-blocked. The honest status is that six phases remain partial for scope reasons, and per the instruction that "scope was too large is not a blocker," these are recorded as **incomplete, not blocked**.

## II-8. Findings added, changed and disproved in Part II

**Added**
- **P1-17** Stripe API version unpinned (account dashboard governs) — VERIFIED BROKEN
- **P2-18** `frontend` suite exits 1 with 882/882 passing — VERIFIED BROKEN
- **P2-19** `services/outgoing-worker` has no tests — VERIFIED
- **P2-20** OMC v4.2.5 `cancel` is a self-referential loop; autopilot state re-arms every prompt — VERIFIED BROKEN

**Changed**
- **P0-1 scope doubled** — a second ungated route (`tools/execute` → `executeTool`)
- **P1-14 hardened** — Meta v19.0 expiry is a dated fact (2026-05-21), not an estimate

**Disproved**
- "AI runtime tool dispatch may be ungated" — **false**, `dispatchToolCall` gates before every branch (§II-4)
- "shared suite has 49 failing tests" — **false**, environmental; 895/895 with `DATABASE_URL`
- "monday 2024-10 may be expired" — **false**, supported in Maintenance

## II-9. Production-readiness verdict

**NOT READY to scale**, on three grounds, in order:

1. **P0-1 (two routes)** — the Approvals/HITL product is configurable but not enforceable against a determined authenticated user.
2. **Three of four major integrations run on a provider-side API version the code does not control**, two of them already expired. This is a silent, recurring breakage source.
3. **Commercial enforcement covers 2.5% of the API surface** (Part I, P1-2).

Counterweight, and it is substantial: **all 13 workspaces typecheck clean, the production frontend build succeeds, ~4,400 tests run with 99.2% passing, the AI runtime's tool gating is provably correct, OAuth state handling is better than typical, and the service boundary rules in `CLAUDE.md` hold.** The defects are concentrated in authorisation seams and version pinning — both narrow, well-understood, and cheap to fix relative to the size of the platform.

## II-10. Help Center impact notes (for the next task — do not act on these yet)

Facts from this audit that Help Center copy must not contradict:

- **Approvals/HITL** may be described as governing the **AI employee's** actions — that is provably true (§II-4). It must **not** be described as governing every action on an integration until P0-1 is closed.
- **Copilot** shares the AI employee's configuration, knowledge and prompt builder; in `copilot` mode an approval-requiring tool becomes a **proposed quick action** for the human agent rather than an approval request. Document that behaviour, not a generic "Copilot asks for approval."
- **Conversation summaries** are architecturally separable from AI Employee/Copilot entitlement (`communication.crm_summaries` exists) but are **not currently enforced** — do not document a plan boundary that is not enforced.
- **Business hours** are configurable but stored only in Redis; unconfigured means always-open.
- Do not document these AI-employee settings as affecting behaviour: `toneConfig`, `behavioral`, `goals` (legacy), `tone`, `style`, `interactiveMessages`, `sharedPrompt`, `autonomousPrompt`, `confidenceThreshold`, `escalationGates`. **Autonomy caps (`maxAutonomousMessages` / `maxAutonomousMinutes`) DO work** and may be documented.
- `/copilot` and `/bot` are dead pages returning 410 — never link them.

## II-11. Phase 1 — complete AI Employee field-level map

Every `AIAgent` column, traced from UI to runtime. **Legend:** *Editor* = `frontend/src/app/ai-studio/agents/[id]/page.tsx`; *Gen* = `agent-config-generator.ts` (onboarding); *Runtime read* = the code that consumes it during a customer turn.

| # | Schema field | UI control | API write | Validator / normalization | Runtime read | State |
|---:|---|---|---|---|---|---|
| 1 | `name` | Editor | create + PUT allowlist | trim; `"Untitled AI Employee"` rejected at activation | `buildIdentity()` prompt-builder | **working** |
| 2 | `role` | Editor | create + PUT | `requiresFunnel(role)` → 422 without funnel | `buildSkillBlock()`, `roleToSkill()`, ×4 in prompt-builder | **working** |
| 3 | `goal` | Editor | create + PUT | trim → NULL if empty | `buildGoals()` | **working** |
| 4 | `successCriteria` | Editor | create + PUT | trim → NULL | `buildGoals()` | **working** |
| 5 | `persona` | Editor | create + PUT | `sanitizePersona()` strips unknown `brand_archetype` | `renderBrandVoice()`, `buildIdentity()` | **working** |
| 6 | `identity` | Editor | create + PUT | none | `buildIdentity()` | **working** |
| 7 | `salesContext` | Editor | create + PUT | `normalizeSalesContext()`; all-empty → NULL | `buildProductQualificationBlock()` (SALES/SDR/CS only) | **working** |
| 8 | `customGuardrails` | Editor | create + PUT | none | `buildGuardrailsBase()` ×2 | **working** |
| 9 | `behavioralAnchors` | Editor | create + PUT | none | prompt-builder ×2 | **working** |
| 10 | `conversationFlow` | Editor | create + PUT | none | prompt-builder ×2 | **working** |
| 11 | `escalationRules` | Editor | create + PUT | none | prompt-builder ×2 (LLM-judged) | **working** |
| 12 | `departmentId` | Editor | PUT | `""` → NULL | routing / stage-resolver | **working** |
| 13 | `funnelId` | Editor | PUT | `""` → NULL; required for pipeline roles | stage-resolver | **working** |
| 14 | `status` | Editor | PUT (gated) | activation readiness gate (name + goal-or-funnel + ≥1 KB) | dispatch eligibility | **working** |
| 15 | `builderStep` | — (server) | server-owned | cleared on editor save | "resume setup" list | **working** |
| 16 | `maxAutonomousMessages` | — | create + PUT | default 10 | `ai-bot.service.ts:423`; worker `:575` | **working** |
| 17 | `maxAutonomousMinutes` | — | create + PUT | default 15 | `ai-bot.service.ts:459`; worker `:650` | **working** |
| 18 | `escalationMessage` | — | create + PUT | default string | worker `ai-bot.service.ts:118` (escalateToHuman) | **working** |
| 19 | `model` | — | create + PUT | default from `getDefaultModel()` | `ai-bot.service.ts:2324` | **working** |
| 20 | `temperature` | — | create + PUT | default 0.7 | `ai-bot.service.ts:2363` | **working** |
| 21 | `maxTokens` | — | create + PUT | default 1024 | `ai-bot.service.ts:2364` | **working** |
| 22 | `provider` | — | create + PUT | default `openai` | provider selection | **working** |
| 23 | `languages` | Editor | create + PUT | default `{english:true}` | *(prompt enforces "reply in the customer's language" independently)* | **partially inert** |
| 24 | `channels` | Editor | create + PUT | none | routing surfaces | **working** |
| 25 | `avatarColor` | Editor | create + PUT | default `#7c5cfc` | UI only | **working (cosmetic)** |
| 26 | `readinessReport` | — | **server-only** (excluded from allowlist) | — | frontend badge only | **working (display)** |
| 27 | **`systemPrompt`** | — | create `:423` + PUT allowlist | none | **NONE** — every `systemPrompt` reference is a local built by `buildAgentPrompt()` | **INERT** |
| 28 | **`capabilities`** `{auto,assist}` | Editor | create + PUT | default `{auto:true,assist:true}` | **NONE** — zero reads of `.auto`/`.assist` anywhere | **INERT — safety-relevant** |
| 29 | **`escalationGates`** | — | PUT allowlist | none | **NONE** — schema claims `evaluatePolicies()` enforcement; it does not | **INERT — safety-relevant** |
| 30 | **`confidenceThreshold`** | — | create + PUT | default 0.6 | **NONE** (the `intelligence-registry` hits are a different model) | **INERT** |
| 31 | **`toneConfig`** | — | **Gen only** (`agent-config-generator:405`) | none | **NONE** — declared on `AgentRecord`, passed at `ai-bot:321`, dropped | **INERT** |
| 32 | **`behavioral`** | — | **Gen only** (`:406`) | none | **NONE** — same | **INERT** |
| 33 | **`goals`** (legacy) | — | **Gen only** (`:400`) | none | **NONE** — superseded by `goal`/`successCriteria` | **LEGACY + INERT** |
| 34 | **`tone`** | Editor | create + PUT | default `professional` | **NONE** in prompt-builder | **INERT** |
| 35 | **`style`** | Editor | create + PUT | none | **NONE** in prompt-builder | **INERT** |
| 36 | **`interactiveMessages`** | **Editor** | create + PUT | none | **NONE** anywhere in backend | **UI ONLY** |
| 37 | **`sharedPrompt`** | — | PUT allowlist | none | **NONE** | **INERT** |
| 38 | **`autonomousPrompt`** | — | PUT allowlist | none | **NONE** | **INERT** |

### Resolution of every suspected inert field

**12 of 38 columns are inert** (27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38) — up from the 9 reported in Part I. Two new ones found this pass:

- **`systemPrompt`** — accepted at create and update, never read. Every apparent reference is a local variable produced by `buildAgentPrompt()`.
- **`capabilities` `{auto, assist}`** — **safety-relevant.** The schema documents it as *"which runtime modes this agent may run in"*, the editor renders it, and **nothing reads it.** An administrator who unticks autonomous mode for an employee changes nothing: the agent still runs autonomously. This is the same failure shape as `escalationGates` (P1-3) and belongs with it.

**Three write paths, and they disagree.** The editor writes 20 fields; `agent-config-generator` (onboarding) writes `toneConfig`/`behavioral`/`goals` which the editor never surfaces and the runtime never reads; the PUT allowlist accepts 36. An employee created via onboarding therefore carries three populated JSON blocks that are invisible in the UI and inert at runtime — confirmed in the dev database, where the single agent has `tone_config`, `behavioral` and `goals` all populated.

### Test coverage of the inert set

| Field | Test files referencing |
|---|---:|
| `interactiveMessages` | **0** |
| `escalationGates` | **0** |
| `sharedPrompt` | **0** |
| `autonomousPrompt` | **0** |
| `confidenceThreshold` | 1 |
| `goals` (legacy) | 2 |
| `toneConfig` | 3 |
| `behavioral` | 4 |

The four fields with **zero** test references are exactly four of the inert ones — the absence of tests and the absence of a runtime reader coincide, which is what one would expect if these were added speculatively and never wired.

**Revised P2-8 count: 12 inert fields, 2 of them safety-relevant (`capabilities`, `escalationGates`).**

### Phase 1 items still not traced

Hiring chat, template/clone flow (no clone endpoint exists — `grep` for `clone|duplicate|template` in `ai-agents.ts` returns nothing), draft resume, onboarding-created employee end-to-end, test-employee sandbox flow, reactivation (PAUSED→ACTIVE readiness gap noted in P2-9), and invalid-employee recovery.

## II-12. Phase 6 — plan / entitlement matrix (dev catalog, verified against the database)

### The plan catalog

| Plan key | Name | Kind | Versions | Entitlements/version |
|---|---|---|---:|---:|
| `foundation` | Foundation | PUBLIC | **4** | 44 |
| `ai_workforce` | AI Workforce | PUBLIC | **3** | 44 |
| `ai_voice` | AI Voice | PUBLIC | 1 | 44 |
| `business` | business | **LEGACY** | 1 | 5 |
| `light` | light | **LEGACY** | 1 | 5 |
| `pro` | pro | **LEGACY** | 1 | 5 |
| `poc` | POC / Pilot | POC | 1 | **0** |

`PlanVersion` immutability is real — `foundation` carries four independent versions, each with its own entitlement set, which is what lets a subscription snapshot survive a catalog change.

### The product combination you specified — VERIFIED CORRECT in data

| Entitlement | `foundation` (v1–v4) | `ai_workforce` (v1–v3) | `ai_voice` (v1) |
|---|---|---|---|
| `ai.employee` | **`false`** | `true` | `true` |
| `ai.copilot` | **`false`** | `true` | `true` |
| **`communication.crm_summaries`** | **`true`** | `true` | `true` |
| `ai.knowledge_base` | `true` | `true` | `true` |
| `communication.broadcasts` | `true` | `true` | `true` |
| `communication.automations` | `true` | `true` | `true` |
| `voice.call_pilot` | `false` | `false` | `true` |

**`foundation` is exactly the Basic plan described in the brief: no AI Employees, no Copilot, summaries granted.** Consistent across all four versions. The data model expresses the intended commercial combination without coupling summaries to AI entitlement.

### Enforcement of that combination — two of three hold

| Capability | Granted on foundation | Backend enforcement | Effective |
|---|---|---|---|
| `ai.employee` | `false` | **`requireEntitlement("ai.employee")`** — `ai-agents.ts:350` | **correctly blocked** |
| `ai.copilot` | `false` | **`requireEntitlement("ai.copilot")`** — `ai-assist.ts:366` | **correctly blocked** |
| `communication.crm_summaries` | `true` | **NONE** (P1-6) | granted-and-unenforced |

So a Foundation tenant today gets the right outcome — but for the wrong reason on the third row. Summaries reach them because *nothing checks*, not because the plan grants it. A tenant on a plan **without** the grant would receive summaries identically. **The commercial boundary exists in the catalog and not in the code.**

### Legacy and POC plans

- **Three LEGACY plans** (`business`, `light`, `pro`) grant only five generic keys each — `channels`, `conversation`, `customer`, `settings`, `limit:users {count:10}`. They carry **no `ai.*` keys at all**, so `requireEntitlement("ai.employee"|"ai.copilot")` denies. That is correct-by-absence, though it depends on deny-by-default rather than an explicit `false`.
- **`poc` has zero entitlement rows.** A POC tenant therefore inherits nothing from its plan. Whether POC access is special-cased elsewhere in the gate was **not traced** — this is the single most important open question in Phase 6 and should be resolved before POC is sold. **UNKNOWN.**

### Phase 6 axes still not audited

Paid checkout → Subscription transition, Trial, manual contract, Pending Payment behaviour, credits/usage/overage accounting, renewal, dunning, cancellation, refund, repair, provisioning, migration, and background-job enforcement. The representative-combination tests requested (expired POC, pending payment, zero credits, inactive membership) were **not executed** — doing so safely needs seeded Dev fixtures that do not exist, and creating them would have written to the shared dev database that is already polluted by test runs (P1-15).

## II-13. Phase 5 — Source of Truth architecture

### Selection: a clear, documented priority chain — VERIFIED WORKING

`services/ai/src/services/connectors/crm-adapter-resolver.ts`:

1. **Explicit election** — a connected Shopify with `config.useAsCrm === true` wins outright.
2. **First CRM-slug integration** with status `CONNECTED` **or `ERROR`**, `orderBy status asc` so CONNECTED beats ERROR.
3. **Shopify as implicit default** when no dedicated CRM is connected, unless `useAsCrm === false`.

Including `ERROR` is deliberate and documented: an OAuth CRM whose access token merely expired would otherwise resolve to the NoOp stub, never be used, and therefore never refresh — *"a deadlock."* This is a correctly-reasoned edge case.

### Vendor support matrix

| Vendor | Adapter | Usable as SoT |
|---|---|---|
| HubSpot | `HubSpotCRMAdapter` | **yes** |
| Salesforce | `SalesforceCRMAdapter` | **yes** |
| Zoho | `ZohoCRMAdapter` | **yes** |
| Shopify | `ShopifyCRMAdapter` | **yes** (also the implicit default) |
| Fireberry | `FireberryCRMAdapter` | **yes** |
| Airtable | `AirtableCRMAdapter` | **yes** |
| **Monday** | → `NoOpCRMAdapter` | **NO** |
| **Pipedrive** | → `NoOpCRMAdapter` | **NO** |
| **custom_api / custom_db** | → `NoOpCRMAdapter` | **NO** |

**Monday is connectable, ships 6 catalog tools, and cannot be a Source of Truth.** Whether the UI communicates that was not checked — worth confirming before it is sold as a CRM.

### Capability model — VERIFIED WORKING

`deriveCapabilities()` computes capabilities from the adapter's actual method surface rather than a hardcoded table, so a vendor that gains `updateRecord`/`createTask`/`mergeContacts` acquires the capability automatically. Unsupported operations raise `UnsupportedCapabilityError` rather than silently no-op'ing.

`getSourceOfTruth()` returns **null** — not a stub — when nothing is connected:

```ts
if (!adapter || adapter instanceof NoOpCRMAdapter) return null;
```

with the stated intent that *"callers show an accurate 'not configured' state — never a NoOp pretender."* This is the right call and is genuinely implemented.

### P1-16 — the Source of Truth facade is bypassed by the path that actually runs

**State: VERIFIED BROKEN** (architectural duplication)

There are **two** writeback paths, and the well-designed one is nearly dead:

| | Facade path | Live path |
|---|---|---|
| Entry | `getSourceOfTruth(tenantId)` | `getCrmAdapter(tenantId)` — `post-conversation-crm.service.ts:113` |
| Summary write | `writeConversationSummary()` → `adapter.createNote()` | `adapter.updateRecord()` `:125`, falling back to `adapter.createNote()` `:155` |
| NoOp filtered | **yes** | **no** — `.catch(() => null)` only |
| Capability-checked | **yes** (`UnsupportedCapabilityError`) | **no** — duck-typed `if (adapter.updateRecord)` |
| Production callers | **2, both reads** (`integrations.ts:87`, `commerce-ai-snapshot.service.ts:56`) | the real post-conversation pipeline |

**`writeConversationSummary` has zero production callers.** Every occurrence is the interface declaration (`:71`), the implementation (`:140`), or a doc comment (`:18`).

So the capability model, the `UnsupportedCapabilityError` contract and the NoOp guard — the three things that make the facade trustworthy — **do not protect the path that actually writes to customer records.** `post-conversation-crm.service.ts` re-implements provider fallback with duck-typing and its own error handling.

This is the same pattern as the two entitlement systems (P1-5): a correct abstraction exists beside an older direct path, and the older one is the one in use.

**Recommended fix:** route `post-conversation-crm.service.ts` through `getSourceOfTruth()`, or delete the facade. Two writeback paths with different safety properties is the worst of the three options.

### Phase 5 axes still not audited

Customer identity resolution and dedup, field mapping per vendor, conflict handling, cache/staleness, reconnect behaviour, notes/timeline semantics, overwrite risk on existing CRM notes, retry/failure handling, cross-customer writeback protection, and the human context panel projection. The end-to-end map requested (conversation → resolution → selection → context → AI prompt → human panel → summary → writeback → retry) is **only partially traced**: selection and writeback are covered above; identity resolution and projection are not.

## II-14. Phase 6 continued — entitlement resolver verified claim-by-claim

The resolver's header documents four strong guarantees. Given P1-6 (catalog metadata that turned out to be fiction), each was checked against code rather than accepted.

| # | Documented claim | Verdict | Evidence |
|---:|---|---|---|
| 1 | *"A capability the product has not built (`implemented: false`) is DENIED no matter what any layer says. You cannot accidentally sell vapour."* | **TRUE** | `isUnsellable(featureKey)` returns `false` at **both** entry points — `isEntitled():198` and `entitledIn():205`. No layer can override it. |
| 2 | *"COMPLIANCE_DENY … always wins and always denies"* | **TRUE** | `entitledIn():209` — `if (entry.source === "COMPLIANCE_DENY") return false;` ahead of any value check. |
| 3 | POC/Trial grants arrive at layer 4 (TRIAL), not through `plan_entitlements` | **TRUE** | `poc.service.ts:217` writes `source: "TRIAL"`; `:284` expires those rows. |
| 4 | *"Resolution failures fail CLOSED for paid capabilities and OPEN for the always-included core"* | **HALF TRUE** | see below |

### Resolves the open POC question — NOT a defect

Part II-12 flagged `poc` having **zero** `plan_entitlements` rows as the most important open commercial question. **It is correct by design.** The resolver has eight precedence layers; POC/Trial capabilities are granted as `TenantEntitlement` rows with `source: "TRIAL"` (layer 4), which outranks `PLAN_DEFAULT` (layer 0). The `poc` plan row exists to carry the **kind** — driving expiry (`tenant-plan-access.ts`, `ACTIVE_POC`) and the UI banner — not the grants. `plan.service.ts:98` additionally refuses to let a POC/TRIAL plan be self-served (`plan_requires_operator`).

**Status: DISPROVED as a concern.**

### P2-17 — the fail-open/fail-closed guarantee is half-implemented

**State: VERIFIED BROKEN (documentation accuracy, not a security hole)**

`resolveEntitlements()` contains **zero `try`/`catch`**. There is no code anywhere that distinguishes "paid capability" from "always-included core" on failure.

What actually happens on a database error:

```ts
try { await assertEntitled(tenantId, featureKey); next(); }
catch (err) {
  const mapped = entitlementErrorResponse(err);
  if (mapped) { res.status(mapped.status).json(mapped.body); return; }  // EntitlementDeniedError → 402/403
  next(err);                                                            // anything else → Express error handler → 500
}
```

`next(err)` with an argument skips every remaining non-error middleware and the route handler.

- **The safety half is TRUE.** A database blip cannot silently unlock `ai.employee` — the request 500s and never reaches the handler. **Fail-closed holds.**
- **The graceful half is NOT implemented.** There is no "OPEN for the always-included core." Every failure is a uniform 500 regardless of whether the capability is paid or core. The specific reassurance that a blip *"never locks a paying customer out of their own inbox"* is not backed by code — it would depend entirely on the inbox not sitting behind `requireEntitlement`, which is accidental rather than designed.

**Impact is low** (the dangerous direction is safe) but this is the **fourth** instance of the document-versus-implementation pattern, after `escalationGates`, `capabilities.auto/assist`, and `enforcementLocations`. Recorded for that reason as much as its own severity.

### Structural theme — refactors that leave the old path in place

Four independent instances now, all the same shape: a newer, better-designed mechanism exists beside an older direct path, and **the older one is what runs**.

| Correct abstraction | Older path still in use | Finding |
|---|---|---|
| `requireEntitlement` + entitlement resolver | `requireFeature` + `Feature` enum | P1-5 |
| `getSourceOfTruth()` facade | `getCrmAdapter()` direct in `post-conversation-crm` | P1-16 |
| `CoPilotPanel` in `ChatPanel` | `/copilot` page (410s) | P2-16 |
| `dispatchToolCall` gate | the two ungated `ai-assist` HTTP routes | **P0-1** |

**P0-1 is an instance of this theme, not an isolated slip.** Remediation should include a rule that retires the superseded path in the same change that introduces the replacement — otherwise the next refactor adds a fifth.

## II-15. Phase 9 continued — environment configuration

### Method correction, stated before the results

A first pass grepped `process.env.NAME` and produced 30 "declared in compose but never read" candidates. **That list was wrong.** Spot-checking every application-config entry showed almost all are read through destructuring, indirection, or a config module the pattern does not match:

| Var | First-pass verdict | Actual |
|---|---|---|
| `BILLING_ALLOW_UNENFORCED` | unread | **read** — `entitlement-gate.ts` (2 refs) |
| `OIDC_CLIENT_ID` | unread | **read** — `oidc-server.ts` (7 refs) |
| `OIDC_DISCOVERY_URL` | unread | **read** — `oidc-server.ts` |
| `AUTH_ALLOWED_ORIGINS` | unread | **read** — `app-origins.ts` (3 refs) |
| `DEEPGRAM_API_KEY` | unread | **read** — `voice-copilot/app.ts` |
| `INTERNAL_BILLING_WEBHOOK_FORWARD_SECRET` | unread | **read** — `icount-ipn.ts` |
| `MESSENGER_ACCESS_TOKEN` | unread | **read** — `prisma/seed.ts` |

The remaining candidates are consumed by **compose itself or by third-party containers**, never by GOTCHA code, and are correctly absent from it: `*_PORT` (port mappings), `*_REPLICAS` (deploy scaling), `AUTHENTIK_*` (the Authentik container's own config), `AI_NODE_OPTIONS` (container `NODE_OPTIONS`).

**Only one genuine orphan: `OPENAI_LOG`** — declared in compose, zero references anywhere. **P3, safe to remove.**

**Env-var dead-config detection needs the same treatment as i18n orphans and dead routes: a naive grep produces a list that is mostly false positives.** This is the fifth measurement in this audit where that held.

### VERIFIED WORKING — billing enforcement cannot be disabled by accident

`BILLING_ALLOW_UNENFORCED` looked like a platform-wide billing bypass wired into **14 service definitions** across dev and prod compose. It is the opposite: a **two-key acknowledgement gate**.

```ts
if (getEnforcementMode(env) === "off" && env.BILLING_ALLOW_UNENFORCED !== "true") {
  throw new Error(
    "[billing] BILLING_ENFORCEMENT_MODE=off in production means nobody is required to pay. " +
    "If that is genuinely intended, set BILLING_ALLOW_UNENFORCED=true to acknowledge it.",
  );
}
```

> *"Deliberately hard to do by accident. Running production unenforced is a decision someone should have to write down."*

Running production with billing off requires **two** explicit variables, and the service **refuses to start** otherwise. Additionally the same function validates `BILLING_ENFORCEMENT_MODE` against a known set and refuses to boot on an unrecognised value (`:150`) — closing the failure mode where a typo'd mode silently fell through to `off` and also skipped metering.

This is a genuinely good fail-safe and belongs beside the OAuth state store and the `dispatchToolCall` gate in §5.

## II-16. Phase 8 continued — model usage classification (143 models)

### Method, and three corrections made before publishing

This classification was rebuilt three times. The failures are recorded because they would recur for anyone repeating the work:

1. **`(prisma as any).model.op`** — **368 of 3,103** Prisma calls (12%) use this cast. A `prisma\.[a-z]+\.` pattern misses every one.
2. **`grep -E` does not support `\s`.** POSIX ERE needs `[[:space:]]`, so the "corrected" pattern silently matched nothing and reproduced the identical wrong answer — the most dangerous kind of failure, because it looked like confirmation.
3. **Optional chaining `.model?.findUnique?.()`** — used by `policy.service.ts`; breaks `\.model\.` matching.

Final method: read all 682 non-test source files into memory and count `.<accessor>.<op>` occurrences in Python. **The first answer was "34 models never accessed." The correct answer is 4.** Anyone quoting a grep-derived dead-model list from this codebase should assume it is wrong by roughly an order of magnitude.

### Schema-level facts (143 models)

| Property | Count |
|---|---:|
| Models total | **143** |
| **Without a `tenantId` column** | **42** |
| With `Json` columns | 84 |
| With `onDelete: Cascade` | 84 |
| Tables with rows (dev) | 70 |
| Empty tables (dev) | 77 |

**42 models carry no tenant key.** Most are legitimately global (catalog, plans, feature definitions) or tenant-scoped through a parent, but this is the same shape as P1-15 (`subscriptions` reaching tenancy only through `billable_entity_tenants`) and each should be confirmed rather than assumed.

### Genuinely unreferenced models — 4

| Model | Table | Dev rows | Evidence | Classification |
|---|---|---:|---|---|
| `CreditTransaction` | `credit_transactions` | **0** | 0 refs in source, seeds, scripts, frontend; 0 raw SQL | **safe to remove after telemetry** — superseded by `AiUnitLedgerEntry` (143 rows, actively written) |
| `CallPlaybookStage` | `call_playbook_stages` | **0** | 0 refs anywhere | **safe to remove after telemetry** |
| `MissingFieldDefinition` | `missing_field_definitions` | **0** | 0 refs anywhere | **safe to remove after telemetry** |
| `FeatureDefinition` | `feature_definitions` | **35** | written by `seed-pricing.ts:49`; **never read by application code** | **deprecate — see below** |

`BusinessPolicy` was on the draft list and is **not** dead — `policy.service.ts:55,93` uses it through optional chaining.

### P1-18 — `FeatureDefinition` is a stale database mirror of the TypeScript catalog

**State: VERIFIED BROKEN (duplicate system with observed divergence)**

Two feature catalogs exist:

| | Authority | Location | Read by |
|---|---|---|---|
| `FEATURE_CATALOG` | **yes** | `packages/shared/src/lib/billing/feature-catalog.ts` (TS constant) | `getFeatureDef()` → `BY_KEY`; `sellableFeatureKeys()` filters `implemented` |
| `feature_definitions` | no | Postgres, seeded by `seed-pricing.ts:49` | **nothing** |

**They have already diverged: 35 rows in the database, ~29 entries in the TypeScript catalog.**

The `implemented: false` safety rule verified in §II-14 — *"you cannot accidentally sell vapour"* — is enforced **only** against the TypeScript constant. The database table that appears to be the feature catalog, and which an operator or a future query would reasonably treat as authoritative, is a stale copy that no gate consults.

This is the **fifth** instance of the structural theme in §II-14: a correct mechanism beside an older/parallel one, with only one of them live.

### Write-only models — 17

Written but never read back by application code. Most are legitimate append-only records (audit/event/ledger); listed for completeness rather than as defects:

`DataSubjectRequest` (7 writes) · `SubscriptionEvent` (7) · `AiUnitLedgerEntry` (5) · `TenantRoleFeature` (4) · `ToolExecutionRequest` (4) · `BillingWebhookEvent` (3) · `UserSession` (2) · `KnowledgeChunk` (2) · `NotificationLog` (2) · `AgentPresence` (2) · `IntelligenceFact` (2) · `BillableEntity` (1) · `ConversationUsageEventLink` (1) · `ReasonerShadowEval` (1) · `QAScore` (1) · `CopilotCueOutcome` (1) · `PolicyDecision` (1) · `DiscoveryActionAttempt` (1)

Two warrant attention:

- **`KnowledgeChunk` write-only** is surprising for a RAG system. Retrieval is done by **Qdrant**, not Postgres — so the Postgres copy is a write-side mirror. Whether it is needed was not established. **UNKNOWN.**
- **`UserSession` write-only** — worth confirming against the BFF session work, since a session table that is written and never read is either dead or read through a path this scan cannot see.

### Cleanup classification summary

| Class | Count | Models |
|---|---:|---|
| **keep** | 122 | actively read and written |
| **write-only, keep** | 15 | append-only audit/event/ledger records |
| **deprecate** | 1 | `FeatureDefinition` (P1-18) |
| **safe to remove after telemetry** | 3 | `CreditTransaction`, `CallPlaybookStage`, `MissingFieldDefinition` |
| **unknown, needs telemetry** | 2 | `KnowledgeChunk`, `UserSession` |

**No model is classified "safe to remove" on the strength of an empty dev table alone** — all three carry zero references across source, seeds, scripts, frontend and raw SQL as well as zero rows.

### Phase 8 axes still not audited

Per-model index adequacy, unique-constraint correctness, the 84 cascade-delete chains, plaintext-secret scan across `Json` columns, legacy-column identification within surviving models, and the retention gap for `agent_loop_iterations` (noted in §8d) remain open.

## II-17. Phase 3 continued — the 147-tool catalog, governance view

Rather than reproduce 147 rows, the matrix is presented as the cross-tabs that carry the findings. Source: live `catalog_tools` join `integration_catalog`.

### Risk × HITL — the governance picture

| Risk | HITL mode | Tools | Assessment |
|---|---|---:|---|
| LOW | `never` | **108** | appropriate |
| MEDIUM | `always` | 10 | appropriate |
| MEDIUM | `never` | **16** | see §P1-4 |
| HIGH | `always` | 10 | appropriate |
| **HIGH** | **`never`** | **2** | **`returngo.update_transaction`, `shopify.edit_order`** |
| HIGH | `on_condition` | 1 | conditional |

**Of 13 HIGH-risk tools, 2 ship with no approval requirement.** This is the sharpest available statement of P1-4. The remaining 11 are correctly gated — including `paypal.refund_capture` and `shopify.cancel_order`, which is evidence the seeding was considered rather than careless, making the two exceptions more likely to be oversights than policy.

### P2-19 — per-tool execution controls exist in schema and are uniformly unconfigured

**State: VERIFIED**

All **147** rows are identical on every runtime-control column:

| Column | Value across all 147 |
|---|---|
| `max_retries` | **0** |
| `timeout_ms` | **10000** |
| `circuit_breaker_threshold` | **NULL** |
| `allowed_modes` | **`["AUTO","ASSIST"]`** |

Consequences:

- **No catalog tool ever retries.** A transient provider 502 fails the tool call outright. `maxRetries`/`retryBackoffMs` are schema fields nothing populates.
- **No circuit breaker anywhere in the tool path.** `circuit_breaker_threshold` is NULL for every tool, and the only circuit-breaker implementation in the repository is in `services/billing/src/providers/boi-fx.provider.ts` — the FX rate provider, unrelated to tools. A provider having a bad day is retried by every conversation independently.
- **Mode filtering is inert.** `allowed_modes` is `["AUTO","ASSIST"]` for every tool, so the filtering machinery in `agent-tools.ts:1087-1095` and `ai-bot.service.ts:1880-1884` never excludes anything. **Copilot and the autonomous bot see identical catalog tool surfaces.** The schema comment cites *"Examples of AUTO-only: send_message, close_conversation"* — but those are internal `TOOL_REGISTRY` tools with no `catalog_tools` row, so the example does not apply to the column it documents.

**What *does* protect the provider:** a real rate limiter at `integration-framework.ts:471`, applied at `:628` **before** the connection is loaded ("denial is cheap"). So the absence of retry/circuit-breaker is a resilience gap, not an abuse risk.

### Idempotency — partial and provider-specific

`idempotencyKey()` exists (`integration-framework.ts:798`) and is genuinely applied, but only in four places:

| Applied | Not applied |
|---|---|
| `stripe.adapter.ts:165` | Shopify (62 tools, incl. `process_refund`, `cancel_order`, `edit_order`) |
| `paypal.adapter.ts:166` | HubSpot, Salesforce, Zoho, Monday, Airtable, Fireberry |
| `square.adapter.ts:171` *(adapter disabled)* | ReturnGO, WooCommerce, all DB adapters |
| `custom-api.service.ts:150` (tenant-configurable header) | |

So the two card processors are protected against double-charge, which is the highest-value case. **Shopify refunds and order cancellations are not idempotent at the framework level** — `executeRefund` has its own two-step calculate→create flow with refundable-maximum validation (`shopify.adapter.ts:1076`), which mitigates but does not replace an idempotency key. The orchestrator maintains a separate cross-turn idempotency ledger (`action-orchestrator.ts` `persistIdempotency`) for AI-initiated actions, so the exposure is narrower for the bot path than for the two ungated HTTP routes in §II-3.

### Tool matrix columns that remain UNKNOWN

Requested but not established per-tool: **localized label** (rendered via `toolDisplayName()` but not enumerated), **required provider scope** (only Shopify declares `requiredScopes` in the framework; the other providers rely on OAuth grant checks at connect time), **required entitlement** (no `catalog_tools` → entitlement mapping exists at all — tools are gated by tenant permission, not by plan), **tenant override counts** (`tenant_tools` has 62 rows and `agent_tool_permissions` 57 across 3 tenants, not attributed per tool), and **runtime reachability / observed-working** per tool, which needs execution telemetry this environment does not have.

**Note on "required entitlement":** the absence of any tool→entitlement mapping is itself a finding consistent with P1-2 — tool access is governed by RBAC and tenant tool permissions, but **not** by what the tenant's plan includes. A plan that excludes an integration does not, by itself, prevent its tools being enabled.

## II-18. Phase 4 continued — OAuth health matrix

### 13 OAuth callbacks, and every one consumes the single-use state

| Route file | Callbacks | State-store calls |
|---|---:|---:|
| `connectors-admin.ts` (Stripe, HubSpot, Shopify, Airtable, Wix, Square, Salesforce, Monday) | 9 | 18 |
| `calendar-oauth.ts` (Google Calendar, Calendly) | 4 | 6 |
| `crm-oauth.ts` (Zoho) | 4 | 3 |
| `knowledge-oauth.ts` (Confluence, Google Drive) | 2 | 5 |
| `shopify-chat-install.ts` | 1 | 4 |
| `channels.ts` (Meta) | 1 | 4 |

**No callback bypasses `mintOAuthState`/`consumeOAuthState`.** This is worth stating plainly because it is the *one* place in this codebase where a correct abstraction is applied consistently — unlike the entitlement gate, the Source of Truth facade, the Copilot surface and the tool gate, each of which has a live bypass (§II-14 theme).

`channels.ts:602` carries an explicit comment that Meta's flow deliberately does **not** use `jwt.verify()` with the OAuth-state secret because it resolves the local account differently — a documented, reasoned exception rather than a drift.

**PKCE:** implemented where the provider mandates it. Airtable uses S256 (`connectors-admin.ts:615-642`, verifier carried through state and replayed at `:669`); the comment notes *"Airtable mandates PKCE (S256). Our other OAuth flows are plain auth-code."* The BFF login flow uses Authorization-Code + PKCE (`oidc-server.ts`). **VERIFIED WORKING.**

**Token encryption at rest:** 33 `encryptCredentials()` / 38 `decryptCredentials()` call sites. Credentials are not stored plaintext.

### Token refresh — centrally applied, correct coverage

`ensureFreshToken()` (`integration-framework.ts:211`) runs on **every** dispatch (`:668`) with a 401-triggered retry (`:717`).

| Implements `refreshTokens()` | Does not — and correctly so |
|---|---|
| airtable, calendly, fireberry, google-calendar, hubspot, monday, paypal, salesforce, shopify, square, stripe, wix (**12**) | aws-rds, mongodb, postgres, returngo, woocommerce (**5**) |

The five without it authenticate by **connection string or API key**, not OAuth, so token refresh does not apply. **Not a gap.**

The framework also deliberately loads connections in `ERROR` status so an expired-token integration can self-heal — the documented deadlock avoidance also seen in the SoT resolver (§II-13).

### Uninstall and GDPR webhooks — present and HMAC-verified

An earlier grep against `integrations.ts` and `services/webhook` found nothing and suggested uninstall handling was missing. **That was wrong — it is in `services/ai/src/routes/shopify-webhooks.ts`:**

| Topic | Handled | Secret used |
|---|---|---|
| `app/uninstalled` (chat app) | `:158` | `getShopifyChatAppConfig().clientSecret` |
| `app/uninstalled` (core app) | `:278` | `SHOPIFY_API_SECRET` |
| `customers/data_request` | `:188` | chat-app secret |
| `customers/redact` | `:203` | chat-app secret |
| `shop/redact` | declared `:41` | — |

All three of Shopify's **mandatory** GDPR webhooks are implemented, `app/uninstalled` is handled for **both** apps with their **separate** secrets, and `shopify.app.toml:60` declares the subscription. Tests exist (`shopify-webhooks.test.ts:99,104,142`). **VERIFIED WORKING.**

### OAuth health matrix

| Provider | Flow | State | PKCE | Refresh | Verdict |
|---|---|---|---|---|---|
| Shopify (core) | auth-code | ✅ | n/a | ✅ | **VERIFIED WORKING** |
| Shopify (chat app) | auth-code | ✅ | n/a | ✅ | **VERIFIED WORKING** |
| Airtable | auth-code + **PKCE S256** | ✅ | ✅ | ✅ | **VERIFIED WORKING** |
| HubSpot | auth-code | ✅ | n/a | ✅ | **VERIFIED WORKING** |
| Salesforce | auth-code | ✅ | n/a | ✅ | **VERIFIED WORKING** |
| Zoho | auth-code | ✅ | n/a | ✅ | PARTIALLY VERIFIED |
| Monday | auth-code | ✅ | n/a | ✅ | PARTIALLY VERIFIED |
| Stripe (Connect) | auth-code | ✅ | n/a | ✅ | PARTIALLY VERIFIED |
| PayPal | auth-code | ✅ | n/a | ✅ | PARTIALLY VERIFIED |
| Google Calendar | auth-code | ✅ | n/a | ✅ | PARTIALLY VERIFIED |
| Google Drive | auth-code | ✅ | n/a | — | PARTIALLY VERIFIED |
| Confluence | auth-code | ✅ | n/a | — | PARTIALLY VERIFIED |
| Calendly | auth-code | ✅ | n/a | ✅ | **catalog unpublished** (§P1-2 Part I) |
| Meta (WA/Messenger/IG) | auth-code, documented exception | ✅ | n/a | long-lived tokens | PARTIALLY VERIFIED |
| Wix | auth-code | ✅ | n/a | ✅ | **DEAD** — adapter commented out |
| Square | auth-code | ✅ | n/a | ✅ | **DEAD** — adapter commented out |

**"PARTIALLY VERIFIED"** = the flow's structure was traced and the state/refresh machinery confirmed shared, but the provider's own current OAuth requirements were not checked against its documentation, and no live authorization was performed.

**Two dead OAuth flows remain wired:** Wix and Square have complete callbacks, token exchange and refresh in `connectors-admin.ts` while their adapters are commented out of `connectors/index.ts`. They are unreachable as tools but the routes still accept traffic. **P3 — remove with the adapters, or restore both.**

### Phase 4 axes still open

Per-provider pagination, rate-limit handling, retry guidance conformance, webhook topic coverage beyond Shopify, and provider-error taxonomy remain **UNKNOWN** for all providers. Version/deprecation is covered for 12 (§II-6); OAuth structure for 16 (above).

## II-19. Phase 7 continued — real browser sweep (EN + HE)

**First runtime browser verification in this audit.** Headless Chromium (cached `chromium-1228`) against **`https://dev.gotcha.co.il`**, 7 public routes × 2 locales (`en-US`, `he-IL`), read-only, no authentication, no mutations. Run twice with identical results.

| locale | route | status | `dir` | `lang` | h-overflow | broken img | console err | **page err** |
|---|---|---:|---|---|---|---:|---:|---:|
| en | `/` | 200 | ltr | en | no | 0 | 1 | 0 |
| en | `/pricing` | 200 | ltr | en | no | 0 | 2 | 0 |
| en | `/legal` | 200 | ltr | en | no | 0 | 1 | 0 |
| en | `/help` | 200 | ltr | en | no | 0 | 1 | 0 |
| en | **`/login`** | 200 | **null** | **null** | no | 0 | 1 | 0 |
| en | **`/terms`** | 200 | ltr | en | no | 0 | 3 | **8** |
| en | `/privacy-policy` | 200 | ltr | en | no | 0 | 1 | 0 |
| he | *(identical to en on every row)* | | | | | | | |

**Good news first:** no horizontal overflow on any page in either locale, no broken images, and **no raw i18n keys leaked into the DOM** — corroborating §8c's finding that key parity is genuinely healthy.

### P2-20 — `/legal/terms-of-service` throws 8 hydration errors

**State: VERIFIED BROKEN** (reproducible, both locales, both entry paths)

```
Error: Text content does not match server-rendered HTML.
```

Attribution was checked, because the first reading blamed the wrong route:

| URL | Final URL | Page errors |
|---|---|---:|
| `/terms` | → `/legal/terms-of-service` (308) | **8** |
| `/legal/terms-of-service` (direct) | same | **8** |
| `/legal/privacy-policy` | same | **0** |

`/terms` is only a `permanentRedirect` stub (`app/terms/page.tsx`). **The defect is in the terms-of-service document specifically, not in the legal renderer** — privacy-policy uses the same renderer and is clean. A React hydration mismatch means the server-rendered and client-rendered trees differ; on a **legal contract page** that is worth treating as more than cosmetic, since the text a user sees may not be the text that was server-rendered. Likely a date/number/locale-formatting difference or a table construct in that one markdown source.

### P2-21 — `/login` has no `lang` or `dir` attribute

**State: VERIFIED BROKEN**

`document.documentElement` on `/login` carries **neither** `lang` nor `dir` in either locale — every other route sets both. **WCAG 2.1 SC 3.1.1 (Language of Page)** requires a page language; screen readers fall back to system locale and will read Hebrew content with an English voice. This is the single highest-traffic unauthenticated page in the product.

### P2-22 — public pages never honour `Accept-Language`

**State: VERIFIED**

Every page renders `dir="ltr" lang="en"` **even under a `he-IL` browser locale.** Root cause is visible in `frontend/src/context/I18nContext.tsx`:

```ts
const [locale, setLocaleState] = useState<Locale>("en");   // :77
// "Post-hydration warm-up from localStorage. Runs once on mount"  :80
```

Locale initialises to `en` and is only corrected **after hydration** from `localStorage`. `Accept-Language` / `navigator.language` is consulted in exactly one place in the entire frontend — `app/setup/page.tsx:207` — which is inside the authenticated onboarding flow.

**Consequence:** a first-time Hebrew-speaking visitor with no `localStorage` lands on an English, LTR page — on the marketing site, the pricing page, the Trust Center and the login screen. For a product with **full Hebrew parity across 4,261 keys** and a Hebrew-first customer base, that is a significant acquisition-path defect, and it is invisible to anyone testing with an existing browser profile.

This is a **product** finding rather than a translation one: the Hebrew exists and is complete; the page just never asks for it.

### Console errors — one benign, universal

Every route logs 1–3 console errors; the recurring one on all 14 page-loads is:

```
Loading the script 'https://static.cloudflareinsights.com/beacon.min.js/...' was blocked
```

The site's own CSP blocks Cloudflare's analytics beacon. Harmless to users, but it means **Cloudflare Web Analytics is collecting nothing** on dev, and the noise masks real console errors during debugging. **P3.**

### Phase 7 axes still open

Authenticated journeys (inbox, AI Studio, settings, approvals), mobile viewports, keyboard/focus accessibility beyond `lang`, duplicate-UX mapping across authenticated surfaces, loading/empty/error-state consistency, and design-system drift. The sweep covered **public, unauthenticated pages only** — authenticating headlessly requires the Authentik impersonation flow, which was judged out of scope for a read-only audit pass.

## II-20. Phase 8 continued — credentials at rest

**No secret values were read or printed at any point.** All queries returned shape, key names and length only.

### The first signal looked like a P0. It is not. Scoping it correctly mattered.

| Table | Rows | Shape |
|---|---:|---|
| `tenant_integrations.credentials` | 3 | **3/3 encrypted** — quoted ciphertext string, **0** rows containing cleartext key names |
| `channel_accounts.credentials` | 7 | **6/7 contain cleartext key names** (`accessToken`, `webhookSecret`) |

Read literally that says channel access tokens are stored in the clear. Three checks show otherwise:

1. **The production connect paths DO encrypt.** `services/auth/src/routes/channels.ts:432, 562, 990, 1105` all call `encryptCredentials(...)` before writing.
2. **The plaintext rows are seed data.** `packages/shared/prisma/seed.ts:62-63, 79` writes `credentials: { accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "demo-token" }` — a raw object, unencrypted, with `"demo-token"` / `"demo-messenger-token"` fallbacks.
3. **Provenance matches.** All six plaintext rows are dated **2026-07-26**; the only row without cleartext key names is `SHOPIFY_LIVE_CHAT` (2026-07-29), created through the real flow.

**Correct classification: dev seed placeholders, not leaked production secrets.** Anyone reading only the first table would have escalated this wrongly.

### P2-23 — the credential read path silently accepts unencrypted credentials

**State: VERIFIED BROKEN** (defensive-design gap)

**11 read sites** share this pattern:

```ts
const creds = typeof rawCreds === "string" ? decryptCredentials(rawCreds) : (rawCreds || {});
```

Including `outgoing.worker.ts:28` (every outbound customer message), `conversation/routes/messages.ts:89`, `voice-flow-runner.ts:661`, `connectors-admin.ts:1144`.

The ternary means: **if the column holds a plaintext object, use it as-is.** No warning, no metric, no failure. A credential that was never encrypted works exactly as well as one that was.

Consequently, if *any* write path omits encryption — a seed, a data migration, a hand-fix in psql, a new integration whose author copies the read pattern but not the write pattern — the system behaves normally and **nothing ever reports that a secret is sitting in the clear**. The dev database is in precisely that state right now for 6 of 7 channels, and it took a shape query to notice.

**Why this is P2 and not P0:** production writes encrypt, and the observed plaintext is demo data. **Why it is not P3:** the tolerance is what makes the failure silent, and it sits on the path that dispatches every outbound message.

**Recommended fix:** make the plaintext branch log an error with the table/row id (never the value) and emit a metric, so the condition is *visible* rather than *tolerated*. Encrypt-on-read-then-rewrite is an option; failing closed is not, because it would take down any tenant currently in that state.

### P3-24 — the seed writes unencrypted credentials into an encrypted-by-production column

`prisma/seed.ts` should call `encryptCredentials()` like the connect routes do, so dev matches production shape and the P2-23 branch is never exercised by our own tooling.

### Cascade-delete surface

**84 of 143 models** declare `onDelete: Cascade`. Two chains were examined in this audit — `AIAgentKnowledge` (P2-9, KB deletion silently breaking the activation invariant) and `BillableEntity` (P1-15). **The remaining 82 were not traced.** Given that the two examined both turned up a defect, this is the highest-yield unexplored area in Phase 8. **UNKNOWN.**

## II-21. Phase 8 continued — cascade-delete surface (99 relations)

I flagged this as the highest-yield unexplored area because the two chains examined earlier both produced defects. Tracing the rest: **99 `Cascade` relations, 22 `SetNull`, 1 other.**

### Blast radius by parent

| Parent | Child model types destroyed | Notes |
|---|---:|---|
| **`Tenant`** | **43** | AIAgent, Conversation, Contact, ChannelAccount, TenantIntegration, ledger entries, … |
| `User` | 5 | ApprovalRecipient, DepartmentMember, InAppNotification, UserFeatureGrant, UserRoleAssignment |
| `BillableEntity` | 5 | AutoPurchasePolicy, BillableEntityTenant, BillingProfile, Invoice, **Subscription** |
| `Conversation` | 4 | CallAnalysis, ConversationIntelligence, Message, VoiceCallSession |
| `KnowledgeBase` | 3 | **AIAgentKnowledge** (→ P2-9), KnowledgeDocument, KnowledgeIntegration |
| `Plan` | 3 | PlanEntitlement, PlanVolumeOption, PublicEstimationConfig |
| `Subscription` | 3 | DunningState, PendingSubscriptionChange, SubscriptionEvent |
| `Identity` | 2 | **User**, UserSession |
| **`IntegrationCatalog`** | 2 | CatalogTool, **TenantIntegration** |

### DISPROVED — the Plan-delete chain is properly guarded

The hypothesis was: `admin-pricing.ts:379` deletes a `Plan`; `Subscription` references plans by plain `planKey` + `planVersion` columns with **no foreign key**; so deleting a plan version would orphan live subscriptions, and `resolveEntitlements`' `plan?.entitlements ?? []` would silently resolve them to **zero** entitlements while still ACTIVE.

**That path cannot be reached.** The route carries three independent guards:

1. `requirePlatformPermission(P.PLANS_MANAGE)`
2. **DRAFT-only** — 409 `plan_version_immutable` otherwise: *"A published version defines what paying organizations agreed to."*
3. **Belt-and-braces subscriber count** — 409 `plan_in_use` if any subscription references that key+version, with the reasoning that a draft should have none by construction, *"so if one does, something is wrong and deleting is the wrong response to it."*

**VERIFIED WORKING**, and a good example of a guard written with the failure mode in mind.

**Residual, latent:** `resolveEntitlements` still uses `plan?.entitlements ?? []`. If a plan row disappeared by any means *other* than this route (psql, a migration), every subscriber silently resolves to zero entitlements instead of erroring. Not reachable through the application; worth a `console.error` when `sub` exists but `plan` is null. **P3.**

### P2-25 — a platform-global table cascades into every tenant's credentials

**State: VERIFIED** (not application-reachable)

`TenantIntegration.integration → IntegrationCatalog` is `onDelete: Cascade`. `integration_catalog` is a **platform-global** table with no tenant column; `tenant_integrations` holds **every tenant's connection and their encrypted credentials**.

Deleting one catalog row therefore destroys that provider's connection for **every tenant at once** — silently, with no confirmation and no audit of what was lost.

**No application path deletes it** (`grep` finds only a test fixture at `three-state-policy-enforcement.test.ts:87`). The exposure is a sysadmin or a migration operating directly on the database — exactly the context where someone "tidying up an unused integration" would not expect to disconnect production tenants.

Compare with `Plan`, which is equally global and *is* protected by explicit guards. **Recommended:** either `onDelete: Restrict` on this relation, or an equivalent in-use check before any catalog row is removed.

### `Tenant` → 43 child models

The largest chain. This is correct for a hard tenant delete (GDPR erasure), and `services/auth/src/routes/system.ts:1292` shows a deliberate, counted teardown rather than a bare `delete`. **Not a defect** — but any future "archive tenant" feature must not reuse `prisma.tenant.delete`, because 43 model types go with it.

### `Identity` → `User` → sessions

Deleting an `Identity` deletes every `User` row it owns **across all tenants**, and their sessions. Given Authentik is the IdP and `Identity` is the join point, an identity-cleanup job would remove a person from every organisation simultaneously. Not traced further; **UNKNOWN** whether any job does this.

### Remaining

Of 99 cascade relations, **4 chains** are now examined (`AIAgentKnowledge`, `BillableEntity`, `Plan`, `IntegrationCatalog`) plus two characterised (`Tenant`, `Identity`). The hit rate dropped from 2-for-2 to 2 defects and 1 disproved in 4 — still high enough that the remaining ~93 warrant a pass, but no longer the single highest-yield area.

## II-22. Phase 6 continued — billing lifecycle

**25 services** under `services/billing/src/services/` — a genuinely decomposed subsystem (checkout, activation, charge execution, dunning, invoicing, quotes, reconciliation, grandfathering, POC, manual contracts, retention).

### VERIFIED WORKING — the subscription-status gate is default-deny and future-proof

`packages/shared/src/lib/billing/tenant-plan-access.ts:130-157`:

```ts
switch (sub.status) {
  case "TRIALING":  { if (ends && ends <= now) return false; break; }
  case "PAST_DUE":  { /* configurable grace window */ if (now > since + graceHours) return false; break; }
  case "GRANDFATHERED": return true;   // "Enforcement is explicitly off. A commercial decision on the row."
  default:
    // "PENDING, SUSPENDED, CANCELED, PAUSED and anything new."
    return false;
}
// Independent of status:
if ((planKind === "POC" || planKind === "TRIAL") && currentPeriodEnd <= now) return false;
```

Four properties worth naming:

1. **Default-deny with an explicit `default:` branch** — a status enum value added tomorrow **denies** rather than silently granting. Most gates of this shape are written as denylists and fail open on a new value.
2. **`PAST_DUE` ≠ never paid.** A configurable grace window, with the comment *"A failed renewal is not the same as never paying."*
3. **`GRANDFATHERED` is an explicit commercial decision on the row**, not an accident.
4. **POC/TRIAL expiry is checked independently of status** — *"A POC left ACTIVE past its window is not access, it is an unattended pilot."* This closes the failure mode where an expired pilot keeps running because nobody flipped its status.

### VERIFIED WORKING — the scheduler is opt-out, not opt-in

`services/billing/src/index.ts:75`:

```ts
const schedulerEnabled = (process.env.BILLING_SCHEDULER_ENABLED ?? "true").toLowerCase() !== "false";
const intervalMs = parseInt(process.env.BILLING_CYCLE_INTERVAL_MS || String(60 * 60 * 1000), 10);
```

Renewal and dunning run **hourly by default**; disabling requires an explicit `"false"`. An unset variable does not silently stop billing — the same fail-safe posture as `BILLING_ALLOW_UNENFORCED` (§II-15).

`scheduler.service.ts:74` runs dunning as one staged step with per-stage failure isolation.

### Dunning state machine

`DunningState` is a proper machine: `stage`, `attempts`, `nextRetryAt` (indexed), `lastFailureCode`, unique per subscription.

`dunning.service.ts` — opens on `PAST_DUE` with no existing dunning row (`:39`), re-checks status before acting (`:48`, guarding against a race where the subscription recovered), restores to `ACTIVE` on success (`:87`), flips to `SUSPENDED` on exhaustion (`:98`). The header notes suspension drives `Subscription.status` and that `Tenant.status` is deliberately **not** written here — a single-writer discipline that avoids two systems fighting over tenant standing.

### Charge idempotency

`charge-execution.service.ts` creates a **single-use `PaymentQuote`** (`:137`) and passes an `idempotencyKey: attemptKey` to the provider (`:190`). Combined with §II-17's finding that Stripe and PayPal adapters also send idempotency keys, the double-charge path is defended at two levels.

### Phase 6 axes still open

Not traced: the checkout → Subscription transition in detail, `PendingSubscriptionChange` application, invoice generation and reconciliation correctness, credit/overage accounting arithmetic, refunds, `grandfather.service`, and `manual-contract.service`. The representative-combination tests requested (expired POC, pending payment, zero credits, inactive membership) were **not executed** — they need seeded fixtures, and creating them would write to a dev database already polluted by test runs (P1-15).

**Assessment of what was examined:** the commercial *gate* is among the better-engineered parts of this platform — default-deny, future-proof, fail-safe defaults, single-writer discipline, two-level idempotency. That contrasts sharply with **enforcement coverage** (P1-2: 18 of 720 endpoints). The gate is sound; it is simply not consulted in most places.

## II-23. Phase 5 continued — customer identity and cross-customer protection

### VERIFIED WORKING — the cross-customer guard is bidirectional and well-scoped

`services/ai/src/services/connectors/customer-access-guard.ts`, enforced in `integration-framework.ts`:

| Stage | Call site | What it does |
|---|---|---|
| **pre-execution** | `:599` `checkArgsAllowed(...)` | rejects a request whose args name a customer other than the requester |
| **post-execution** | `:744` `checkResultAllowed(...)` | rejects a **response** containing another customer's data |

The post-execution check is the part most implementations omit: a request that looks innocuous (a broad order search) can still *return* other customers' records. Validating the result closes that.

**Identity is derived from the conversation, never from tool args** — `resolveRequesterIdentity()` reads `Conversation.customerExternalId` (the authenticated channel sender), then widens to phone suffixes and the matching `Contact`'s email/phone. An AI-supplied "I am customer X" cannot influence it.

**38 protected Shopify tools**, and the list includes customer **writes** with the threat model written down:

```
// customer writes are cross-customer-abusable too (tagging/notes on a victim)
"update_customer", "add_tag", "remove_tag", "update_metafield", "create_note",
```

Tagging or annotating a victim's record is a real abuse path that a read-only guard would miss. Someone thought about this properly.

### Scope of the guard — and the hole P0-1 opens in it

The guard fires **only** when `accessScope === "customer"`. Across the entire codebase that value is passed in exactly **one** place:

| Site | `accessScope` | Guard active |
|---|---|---|
| `ai-bot.service.ts:1747` — the LLM's adapter dispatch | **`"customer"`** | **yes** |
| `commerce-actions.service.ts:68,173,222,394` | `"internal"` | no — correct: human agent via RBAC-gated route |
| `commerce-context.service.ts:457,554` | `"internal"` | no — correct: server-side context build |
| **`ai-assist.ts:712` / `:678` (P0-1)** | **not passed → defaults `"internal"`** | **NO** |

That last row escalates P0-1's characterisation.

### P0-1 — restated with the data-exposure dimension

Previously described as "execute provider actions without policy/HITL." That is incomplete. Because neither ungated route passes `accessScope`, **both default to `"internal"` and the cross-customer guard is skipped entirely.**

So an authenticated tenant member — including a low-privilege `AGENT` — can call:

```
POST /api/ai-assist/<any-conversation-id>/adapter-tools/execute
{"toolFunctionName":"shopify.get_customer_orders","args":{"customer_id":"<any customer>"}}
```

and read **any customer's orders, addresses, financial status, tracking, returns or refunds** — the full 38-tool protected set — with neither the pre-arg check nor the post-result check running.

**P0-1 is therefore both a privilege-escalation and a customer-data-exposure finding.** The guard that exists specifically to prevent this is bypassed not by defeating it, but by reaching the adapter through a route that never engages it.

This remains **within-tenant** (`req.tenantId` is server-resolved), so it is not cross-tenant disclosure. But within a tenant it defeats the protection that the AI path correctly enforces — and it is the same structural theme as §II-14: the correct mechanism exists, and an older direct path goes around it.

**This strengthens the case for the recommended fix** (`requireInternalKey` on both routes): the approvals dispatcher and the CRM client are the only legitimate callers, and both are server-side.

### Identity resolution — remaining surface

`packages/shared/src/lib/identity-resolver.ts` exposes `resolveContactByChannelId`, `unifyContact`, `findSiblingContacts`. Contact unification, dedup semantics, merge-conflict handling and the `Identity` ↔ `Contact` ↔ `CustomerProfile` relationship were **not traced**. Field mapping per CRM vendor, conflict resolution on writeback, and cache/staleness remain **UNKNOWN** (§II-13).

## II-24. Phase 9 continued — unused exports

### Method note (the eighth correction)

A first scan over production source only reported **115** unused exports. That excluded `__tests__`, `prisma/`, `scripts/` and `frontend/`, so every `__resetXForTests` / `__testables` helper and the whole of `plan-seeds.ts` were false positives.

Widening the **usage** scope while keeping the **declaration** scope to production source gives **62**. Method: declarations from 644 production `.ts` files; usage from a single tokenised pass over all `.ts`/`.tsx` including tests, prisma, scripts and frontend (a per-symbol regex over the corpus is quadratic and timed out at 600 s — tokenising once and counting is ~100× faster).

### Cross-validated by two independent algorithms

Unusually for this audit, this measurement was confirmed twice by different means:

| Method | Result |
|---|---|
| Per-symbol regex over a 14.1 MB corpus (644 declaration files, 1,409 usage files) — 600 s+ | **62** |
| Single tokenising pass + `Counter` lookup — ~6 s | **62** |

Identical counts, identical symbols, identical top files. **This is the only finding in the audit corroborated by two independent implementations**, and it is the direct antidote to the eight method failures recorded elsewhere: when a number matters, compute it twice by different routes.

### P2-26 — three superseded local modules duplicate shared functionality

**State: VERIFIED BROKEN** (dead code + duplicate system)

Each of these exports appears **exactly once** across the entire repository — its own declaration:

| Dead module | Dead exports | The live path |
|---|---|---|
| `services/ai/src/services/audit.service.ts` | `logAIAction`, `logSystemAction`, `logUserAction` | `writeAudit` / `auditUser` / `auditSystem` in `packages/shared/src/lib/audit.ts` — **23 references** in `services/ai` alone |
| `services/ai/src/services/usage.service.ts` | `trackAITokens`, `trackAutomationRun`, `trackMessageSent` | `trackAIUsage` |
| `services/incoming-worker/src/services/whatsapp.service.ts` | `sendWhatsAppMessage`, `sendQuickReply` | `getOutboundAdapter(channel)` → `whatsappOutboundAdapter` in shared |

This matters beyond dead-code hygiene. `CLAUDE.md` states *"EVERY AI interaction must be logged"* and defines a mandatory usage-record shape. A reader opening `services/ai/src/services/audit.service.ts` — the obvious place to look — finds a complete, plausible, **never-called** implementation, and would reasonably conclude audit logging is wired there. It is not; the real path is the shared module.

**Sixth instance of the structural theme (§II-14):** a correct shared implementation exists and a superseded local copy sits beside it. The running tally:

| Correct mechanism | Superseded path still present | Finding |
|---|---|---|
| `requireEntitlement` + resolver | `requireFeature` + `Feature` enum | P1-5 |
| `getSourceOfTruth()` facade | `getCrmAdapter()` direct | P1-16 |
| `CoPilotPanel` in `ChatPanel` | `/copilot` page (410s) | P2-16 |
| `dispatchToolCall` gate | two ungated `ai-assist` routes | **P0-1** |
| `FEATURE_CATALOG` (TS) | `feature_definitions` table | P1-17 |
| shared `audit` / `trackAIUsage` / channel adapters | three local service modules | **P2-26** |

### The other 59

Predominantly benign: type-only exports consumed structurally (`TwilioFrame`, `StartFrameParsed`, `SttEvent`, `SystemAdminJwtPayload`, `ZohoCredentials`), seed constants read by tooling outside the scan (`plan-seeds.ts`), and forward-declared API surface not yet called (`MEMORY_TOOL_SCHEMAS`, `executeMemoryTool`, `agentMayPropose`, `CREATE_TASK_TOOL`).

**`agentMayPropose` (`shared/lib/agent/grants.ts`) is worth a second look** — an authorisation-shaped helper with no callers is either dead or a control someone believes is active, the same shape as `escalationGates` (P1-3) and `capabilities.auto/assist` (P1-3b). **Not investigated. UNKNOWN.**

### Removal guidance

Only the three modules in P2-26 are recommended for removal, and only after confirming no dynamic import reaches them. **Nothing here should be deleted on the strength of this scan alone** — eight method corrections in this audit, each of which initially over-reported by 2–10×, is the reason that sentence is in the document.

### Phase 9 axes still open

Unused React components, duplicate integration registries, stale feature flags, commented-out production code, and test fixtures reachable in production were **not swept**.

## II-25. Resolving `agentMayPropose` — dead design, not a missing control

Flagged UNKNOWN in §II-24 because it has the same shape as two confirmed inert safety controls. **Resolved: it is abandoned design, not a hole.**

`packages/shared/src/lib/agent/grants.ts` is **entirely self-contained** — every reference to every export is inside the file:

| Export | Refs | Where |
|---|---:|---|
| `SpendLimits` | 2 | declared `:13`, used `:31` inside `AgentGrants` |
| `AgentGrants` | 2 | declared `:21`, used `:41` inside `agentMayPropose` |
| `agentMayPropose` | 1 | declaration only |

Zero external consumers. The module is an earlier design for agent authority that was **superseded** rather than removed.

### What replaced it, and it is live

Spend limits and operation authority are enforced by the **business-policy engine**:

| Control | Enforced at |
|---|---|
| `maxAmount` | `action-orchestrator.ts:206-212` (AI path), `commerce-actions.service.ts:362-363` (human path) |
| `maxPercentOfOrder`, `perCustomerWindowDays`, `perCustomerMaxEvents`, `managerApprovalAboveAmount` | `business-policies.ts:48,58`, `business-policy.ts:54` |

The orchestrator's denial even names the permitted maximum so the model can re-propose within it:

```
business_policy_amount_capped: the maximum permitted is ${biz.maxAmount}.
Re-propose ${action.tool} with amount <= ${biz.maxAmount}.
```

This is a **richer** model than `SpendLimits` offered — per-customer windows and event caps as well as amounts.

### The distinction that should govern remediation priority

Three "inert control" findings surfaced in this audit and they are **not** equally severe:

| Finding | User can configure it? | Severity | Why |
|---|---|---|---|
| `escalationGates` (P1-3) | **yes** — writable via API, **backfilled with real data by a migration** | **P1** | An operator believes deterministic escalation is armed. It is not. |
| `capabilities.auto/assist` (P1-3b) | **yes** — rendered in the agent editor | **P1** | An admin unticks autonomous mode and the agent keeps running autonomously. |
| `grants.ts` (this) | **no** — no route, no UI, no schema column | **P3** | Nobody can set it, so nobody can be misled by it. Pure debt. |

**An inert control a user can set is a safety defect. An unreachable module is only debt.** The audit's earlier findings should be read with that separation — it is why `grants.ts` is P3 while the other two sit beside P0-1 in the immediate remediation block.

**Recommended:** delete `grants.ts`. Nothing imports it, and leaving an authorisation-shaped module in `shared/lib/agent/` invites a future author to wire it up in parallel to the business-policy engine — creating instance seven of the §II-14 theme.

## II-26. Phase 9 continued — integration registries (no duplication found)

The §II-14 theme predicted a duplicate registry. **There isn't one**, and the negative result is worth recording as precisely as the positives.

### The CRM registry is derived, not duplicated

`services/ai/src/services/connectors/crm-adapter-resolver.ts:33-44`:

```ts
const SLUG_TO_VENDOR: Record<string, CrmVendor> = { hubspot, salesforce, zoho_crm→zoho, fireberry,
                                                    pipedrive, monday, airtable, custom_api, custom_db };
const CRM_VENDOR_SLUGS = Object.keys(SLUG_TO_VENDOR);   // ← derived
```

One map; the slug list is computed from it. `instantiate()` switches on the same `CrmVendor` union. Adding a vendor is a single-site change. **This is how the other five duplications should have been built.**

The many files that mention several provider slugs (`crm.ts` 22, `crm-adapter.impl.ts` 21, `onboarding.ts` 15) are **not** registries — they are adapter implementations naming their own provider's tools, and vendor-specific branches. Not duplication.

### P3-27 — two phantom vendors

| Slug | In `CrmVendor` type | In `SLUG_TO_VENDOR` | Adapter file | `integration_catalog` row |
|---|---|---|---|---|
| `pipedrive` | yes | yes | **none** | **0** |
| `custom_db` | yes | yes | **none** | **0** (catalog has `custom_api` only) |

Both resolve to `NoOpCRMAdapter` via `instantiate()`'s default branch, and neither has a catalog row, so **neither can ever be connected** — the resolver's step 2 queries `integration.slug IN (CRM_VENDOR_SLUGS)`, which can never match a slug with no catalog row.

Harmless at runtime (the NoOp path is deliberate and `getSourceOfTruth()` correctly returns `null` for it — §II-13). It is a **declaration that outran the implementation**: the type promises ten vendors, eight exist. Worth pruning so the union describes reality, since a reader sizing up CRM coverage would count ten.

### Registry health summary

| Registry | Single source? | Verdict |
|---|---|---|
| CRM vendors (`SLUG_TO_VENDOR`) | **yes**, derived | **VERIFIED WORKING** |
| Provider adapters (`registerAdapter` + `connectors/index.ts`) | **yes** | **VERIFIED WORKING** — and the `postgres`/`postgresql` slug bug fixed earlier this session is now guarded by a test |
| Tool catalog (`catalog_tools`) | **yes** (DB) | **VERIFIED WORKING** |
| Feature catalog | **NO** — TS constant + stale DB table | **P1-17** |
| Entitlement keys | **NO** — `Feature` enum + entitlement keys | **P1-5** |

## II-27. Phase 9 continued — feature flags, and the sharpest statement of P1-2

### No stale flags — but that is the wrong question

All **90** `Feature` enum entries are referenced somewhere, so a naive "stale flag" scan returns **zero**. That result is misleading: "referenced" includes appearing in `ALL_FEATURES`, `FEATURE_METADATA`, `plan-seeds.ts` and the RBAC seed — i.e. being *listed* in the very structures that declare it.

Classifying by **where** each is referenced changes the picture completely:

| | Count | Share |
|---|---:|---:|
| Feature enum entries | **90** | 100% |
| **Enforced via `requireFeature()`** | **3** | **3.3%** |
| Not enforced by `requireFeature` | 87 | 96.7% |
| …appearing **only** in catalog / seed / metadata files | **82** | **91%** |

The three enforced: `SHOPIFY_LIVE_CHAT`, `SHOPIFY_PRODUCT_MESSAGING`, `AUTO_BUY`.

**82 of 90 features exist as data structures and nowhere else in the product.** They are declared, given metadata, seeded onto plans, rendered in pricing — and never consulted by any gate.

### This restates P1-2 more precisely

Part I measured enforcement as **18 of 720 endpoints (2.5%)**. That framing invites "add middleware to more routes." The sharper measurement is:

> **Of 90 sellable capabilities, 3 are enforced by the feature system and 82 exist only as declarations.**

Combined with §II-12 (`requireEntitlement` covers 6 more capabilities through the *other* system), the total number of commercially-enforced capabilities across **both** systems is roughly **9 of 90**.

The remediation implication differs from the endpoint framing. This is not "sprinkle middleware": it is that the `Feature` enum was built as a **catalog**, not as a **gate**, and the gate was retrofitted onto three Shopify-related entries. Consolidating onto `requireEntitlement` (P1-5) and deriving enforcement from the catalog — with the CI assertion proposed in P1-6 — addresses the cause. Adding 87 middleware calls would not.

### Why "no stale flags" is still worth recording

It means **nothing was deleted from under the flags** — every declared capability still has a coherent home in metadata and seeds. The commercial model is *complete on paper*. That is the good news inside P1-2: the product knows what it sells, it just does not check most of it.

---

# PART III — Phase 10: final consolidation and verdict

*2026-07-31. Supersedes the interim status tables in Parts I and II.*

## III-1. Final phase status — COMPLETE or BLOCKED

The brief required every phase to be **COMPLETE** or **explicitly BLOCKED with a concrete reason that cannot be resolved in this environment**, and stated that "scope was too large" is not a blocker. Applying that honestly:

| Phase | Status | If not complete: the concrete blocker |
|---|---|---|
| 0 Graphify | **COMPLETE** | — |
| 1 AI Employee creation | **COMPLETE for configuration** (38-column map, §II-11) · **BLOCKED for journeys** | Hiring chat, clone, resume and onboarding-created employees require an **authenticated browser session**. Login is Authentik-mediated; headless auth needs `akadmin` impersonation, which mutates identity state — outside a read-only audit. |
| 2 AI runtime | **COMPLETE for gating and dispatch order** (§II-4, §6) · **BLOCKED for the 12-state machine** | Exercising `Waiting-for-approval`, `Human takeover`, `AI paused`, `Dependency failure` requires **sending real messages through a channel**, explicitly forbidden. |
| 3 Tools & HITL | **COMPLETE for governance** (66 call sites §II-5, 147-tool matrix §II-17) · **BLOCKED for per-tool reachability** | "Has this tool ever executed successfully" needs **execution telemetry**. No telemetry store exists; the dev estate has 3 tenants and near-zero traffic. |
| 4 Integrations | **COMPLETE for version + OAuth structure** (§II-6, §II-18) · **BLOCKED for runtime axes** | Pagination, rate-limit and retry behaviour can only be verified by **driving real provider APIs at volume** — live calls against merchant data. |
| 5 Source of Truth | **COMPLETE for selection, capability model, writeback** (§II-13, §II-23) · **BLOCKED for conflict/dedup semantics** | Requires **writing to a real CRM** and observing conflict resolution. |
| 6 Billing/entitlements | **COMPLETE for gate, resolver, dunning, matrix** (§II-12, §II-14, §II-22, §II-27) · **BLOCKED for combination tests** | Expired-POC / pending-payment / zero-credit cases need **seeded fixtures**; the dev DB is already polluted by test runs (P1-15) and seeding more would deepen it. |
| 7 Frontend/i18n | **COMPLETE for i18n parity and public pages** (§8c, §II-19) · **BLOCKED for authenticated UX** | Same authentication blocker as Phase 1. |
| 8 Database | **COMPLETE** (§8d, §II-16, §II-20, §II-21, §III-7) | All 99 cascades classified; index adequacy and legacy-column ID named but not done. |
| 9 Dead code | **COMPLETE** (§8e, §II-15, §II-24, §II-26, §II-27, §III-6) | Only commented-out code / prod-reachable fixtures untraced. |
| 10 Verdict | **COMPLETE** | — |

**Two phases (8, 9) have residual work that is genuinely "not done" rather than blocked, and this document says so rather than claiming completion.** Everything else is either complete on the axes stated, or blocked by a constraint the brief itself imposed (no real provider mutations, no customer messages) or by the absence of an authenticated non-mutating login path.

## III-2. Production-readiness verdict

**NOT READY to scale.** One P0 and three structural P1 classes must close first.

### Production blockers

| # | Blocker | Why it blocks |
|---|---|---|
| **1** | **P0-1 — two ungated execution routes** | Any authenticated tenant member can execute provider actions **and read any customer's data**, bypassing tool policy, HITL and the cross-customer guard. Both privilege escalation and data exposure. |
| **2** | **P1-3 / P1-3b — two inert safety controls a user can configure** | `escalationGates` (migration-backfilled) and `capabilities.auto/assist` (rendered in the editor). An operator believes autonomy is bounded; it is not. |
| **3** | **P1-12 / P1-14 — expired API versions on both primary integrations** | Shopify `2024-04` (~15 months past EOS) and Meta `v19.0` (expired **2026-05-21**). Both providers silently fall forward, so the contract changes quarterly with no deploy and no signal. |
| **4** | **P1-2 — 3 of 90 features enforced** | Commercial leakage on essentially the whole catalogue. |

### What is genuinely strong — and should not be rebuilt

| Area | Evidence |
|---|---|
| AI tool gating | `dispatchToolCall` gates before every dispatch branch; orchestrator fails closed (§II-4) |
| Cross-customer protection | bidirectional pre-arg + post-result checks, identity from the channel, 38 protected tools incl. writes (§II-23) |
| OAuth | 13 callbacks, **all** consuming single-use state; PKCE where mandated; central refresh (§II-18) |
| Billing gate | default-deny with explicit `default:`, POC expiry independent of status, opt-out scheduler, two-level charge idempotency (§II-22) |
| Entitlement resolver | `implemented:false` and `COMPLIANCE_DENY` guards verified in code (§II-14) |
| Shopify compliance | `app/uninstalled` for both apps + all three mandatory GDPR webhooks, HMAC-verified (§II-18) |
| Registries | CRM vendors and adapters each have one derived source (§II-26) |
| i18n | 4,261 keys, **0** missing in Hebrew, 0 em-dashes (§8c) |
| Build health | 13/13 typechecks clean, prod build exit 0, ~4,400 tests at 99.2% (§II-2) |

**The defects cluster in authorisation seams and version pinning, not in the core.** That is a far better position than 31 findings suggests.

## III-3. The one structural insight

Six findings are the same shape — **a correct mechanism built beside an older path that was never retired**:

| Correct | Superseded but live | Finding |
|---|---|---|
| `dispatchToolCall` gate | two `ai-assist` HTTP routes | **P0-1** |
| `requireEntitlement` + resolver | `requireFeature` + `Feature` enum | P1-5 |
| `getSourceOfTruth()` | `getCrmAdapter()` direct | P1-16 |
| `FEATURE_CATALOG` (TS) | `feature_definitions` table | P1-17 |
| `CoPilotPanel` | `/copilot` page (410s) | P2-16 |
| shared audit/usage/channel | three local service modules | P2-25 |

**P0-1 is an instance of this, not an isolated slip.** Remediation should include a standing rule — *retire the superseded path in the same change that introduces its replacement* — or there will be a seventh. `SLUG_TO_VENDOR` (§II-26) is the in-repo example of doing it right.

## III-4. Remediation order

**Immediate (before next release)**
1. `requireInternalKey` on both `ai-assist` execution routes — closes P0-1 entirely. *Small; two known callers.*
2. Implement or delete `escalationGates` **and** `capabilities.auto/assist`. Do not leave a control that a user can set and that does nothing.
3. Read `X-Shopify-API-Version` and alert on mismatch. *Few lines; converts invisible quarterly drift into a signal. Do this before bumping the version.*
4. Re-seed `hitlPolicy` so HIGH-risk/ACTION tools cannot default to `never` (`shopify.edit_order`, `returngo.update_transaction`).

**Next hardening sprint**
5. Move Shopify off `2024-04`; centralise the Meta Graph version and move WhatsApp/Messenger off `v19.0`; pin `Stripe-Version`.
6. Align prod webhook `api_version` with dev.
7. Consolidate onto `requireEntitlement`; add the CI assertion that every catalog `enforcementLocations` has a real call site.
8. Make the BillableEntity→tenant link mandatory; give billing tests a throwaway database.
9. Log-and-metric the plaintext-credential branch (never the value).

**Product consistency**
10. Honour `Accept-Language` on public pages — Hebrew visitors currently land on English LTR.
11. Fix `/legal/terms-of-service` hydration; add `lang`/`dir` to `/login`.
12. Resolve the 12 inert AIAgent fields (render or remove); delete `/copilot`, `/bot`, `grants.ts`, and the three superseded modules.

**Technical debt**
13. Route `post-conversation-crm` through `getSourceOfTruth()`, or delete the facade.
14. Deprecate `feature_definitions`; retention for `agent_loop_iterations`; guard `IntegrationCatalog` deletion; Postgres home for business hours.

## III-5. Help Center impact — verified constraints for the next task

Statements the Help Center **must not** make, each contradicted by evidence in this document:

- ❌ "Approvals govern every action on your integrations" → true for the **AI employee** (§II-4), **false** while P0-1 stands.
- ❌ "Turn off autonomous mode for an employee" → `capabilities.auto/assist` is inert (§II-11).
- ❌ "Set escalation gates so the AI hands off after N messages" → inert (§II-11). **`maxAutonomousMessages`/`maxAutonomousMinutes` DO work** and may be documented.
- ❌ Documenting `tone`, `style`, `toneConfig`, `behavioral`, `goals`, `interactiveMessages`, `confidenceThreshold`, `sharedPrompt`, `autonomousPrompt`, `systemPrompt` as affecting behaviour → all inert (§II-11).
- ❌ Describing a plan boundary for conversation summaries → granted but **unenforced** (§II-12).
- ❌ Linking `/copilot` or `/bot` → both return 410 (§8e).
- ❌ "Monday as your Source of Truth" → resolves to NoOp (§II-13).
- ✅ **Safe to document:** Copilot shares the employee's configuration and knowledge, and in Copilot mode an approval-requiring tool becomes a **proposed quick action** rather than an approval request (§II-4). Business hours are configurable; unconfigured means always-open (§P2-10).

## III-6. Closing the "not blocked, not done" gap — unused React components

§III-1 listed unused components as **not blocked, simply not done**. Closing it.

### Method — cross-validated, as §II-24 recommends

| Method | Result |
|---|---|
| Exported-symbol scan (220 exported components across 164 files, usage from 441 files) | **14 unreferenced** |
| **Independent check:** file-path import scan (`from '…/Name'` / `import('…/Name')`, any local alias) | **14, identical set — 0 imports each** |

The second method exists because a `export default` component can be imported under **any** local name, which a symbol scan misses. Both agree. **Second cross-validated measurement in this audit.**

### P3-28 — 14 unreferenced components, ~2,605 lines

| Component | Lines | Note |
|---|---|---|
| **`routing/ChannelNode` · `FlowNode` · `HandlerNode` · `RuleNode`** | — | **A coherent four-component feature.** Nothing anywhere imports from `components/routing/`. This is an abandoned routing-visualisation surface, not four stragglers. |
| `ApprovalQueue.tsx` | 71 | Superseded — the live surface is `app/approvals/page.tsx`, which **is** in the sidebar (`Sidebar.tsx:27`). |
| `ai-studio/ToolPermissionsPanel` | — | Superseded by the Integrations & Tools workspace. |
| `AICommandBar`, `ActionContractsSection`, `FunnelSection`, `LanguageSwitcher` | — | |
| `broadcasts/CrmVarPicker`, `landing/MessageFlowSection` | — | |
| `voice/workspace/cards/CopilotSuggestionsCard`, `NotesCard` | — | |

**~2,605 lines** of unreferenced component code.

`ApprovalQueue` and `ToolPermissionsPanel` are two more instances of the §III-3 theme — superseded surfaces left beside their replacements. That brings the theme count to **eight** occurrences, and reinforces the standing rule proposed in §III-3.

**`LanguageSwitcher` deserves a note:** an unused language switcher, in a product where public pages never honour `Accept-Language` (P2-22) and Hebrew visitors land on English. The component that would let them switch exists and is wired to nothing. Whether it was ever mounted was not established.

### Removal guidance

Lower risk than the backend candidates — a React component with zero imports by **either** name or path is not reachable, since Next.js App Router resolves pages by file location, not by component export. Still: confirm no `dynamic(() => import(...))` with a computed path before deleting, and treat `components/routing/` as one decision rather than four.

### Phase 9 is now COMPLETE

Routes (§8e) · env vars (§II-15) · unused exports (§II-24) · registries (§II-26) · feature flags (§II-27) · components (here). The only untraced sub-axis is commented-out production code and test fixtures reachable in production — **not investigated**, and small enough to name rather than claim.

## III-7. Closing the last gap — all 99 cascade chains classified

§III-1 listed ~93 untraced cascade chains as **not blocked, simply not done**. Tracing 99 chains individually is neither necessary nor useful; classifying them by **risk shape** is. The question that matters is: *can deleting one row destroy data belonging to a tenant who has no relationship to that row?*

### Classification

| Class | Count | Risk |
|---|---:|---|
| **Tenant-scoped** — both parent and child carry `tenantId` | **22** | Normal. Deleting a tenant's own row removes that tenant's own children. |
| **Both global, or parent is `Tenant`** | **73** | Expected. Tenant deletion (GDPR erasure, §II-21) and catalog-internal chains. |
| **GLOBAL parent → TENANT-KEYED child** | **4** | **Cross-tenant blast radius — one delete, many tenants affected.** |

### The four cross-tenant chains

| Parent (global) | Child (tenant-keyed) | Status |
|---|---|---|
| `IntegrationCatalog` | `TenantIntegration` | **P2-24** — every tenant's credentials (§II-21) |
| **`CatalogTool`** | **`TenantTool`** | **NEW — P2-29 below** |
| `BillableEntity` | `BillableEntityTenant` | covered by P1-15 |
| `Identity` | `User` | noted §II-21; identity-cleanup would remove a person from every organisation |

**This is the complete set.** No other cascade in the schema can cross a tenant boundary.

### P2-29 — deleting a catalog tool silently destroys every tenant's policy for it

**State: VERIFIED BROKEN — with historical evidence that it has already happened**

`TenantTool` holds the per-tenant governance state:

```prisma
tenantId         String
catalogToolId    String
isEnabled        Boolean @default(true)
configOverrides  Json    @default("{}")   // ← the tenant's HITL override
catalogTool      CatalogTool @relation(..., onDelete: Cascade)
```

`configOverrides` is where a tenant's **tightened HITL policy** lives — per §7, the tenant override is *authoritative* over the catalog default. So a customer who deliberately set a tool to "require approval" stores that decision here.

Deleting the `CatalogTool` row cascades it away silently.

**Four migrations delete from `catalog_tools`. Only two pre-delete `tenant_tools` explicitly:**

| Migration | Explicit `tenant_tools` delete |
|---|---|
| `20260506100000_marketplace_real_integrations_only` | **0 — relied on the cascade** |
| `20260507000000_add_custom_api_marketplace_tile` | **0 — relied on the cascade** |
| `20260720090000_calendar_catalog_honesty` | 1 ✅ |
| `20260731100000_calendly_dead_catalog_tools` | 1 ✅ |

The two later migrations delete `tenant_tools` first — belt-and-braces, since the cascade would do it anyway — which shows the authors understood the coupling. **The two earlier ones did not**, and any tenant policy override on a removed tool was silently discarded at that point, with no audit row and no notification.

Dev currently holds **62 `tenant_tools` rows across 1 tenant**, so the present-day blast radius is small — but it is a live coupling between a **platform-global** cleanup action and **customer-configured governance**.

**Recommended:** `onDelete: Restrict` on `TenantTool.catalogTool`, forcing any catalog cleanup to deal with tenant overrides explicitly; or an audit row written before the cascade. The same argument applies to `IntegrationCatalog → TenantIntegration` (P2-24) — both are cases where a platform maintenance action reaches into customer data with no record.

### Phase 8 is now COMPLETE

Usage classification (§II-16) · integrity (§8d) · retention (§8d) · credentials at rest (§II-20) · cascade surface (§II-21, here). Remaining sub-axes named but not investigated: per-model index adequacy and legacy-column identification within surviving models.

---

# PART IV — Remediation appendix (2026-07-31)

Written after executing the remediation sprint against this audit. It records
what was fixed, what the audit got wrong, and what was found that the audit
missed. Nothing here was pushed, merged or applied to production.

## IV-1. What shipped

| Commit | Area | Substance |
|---|---|---|
| `698752d` | Billing | Commercial boundary made real and machine-checked |
| `c757832` | Post-conversation | Duplicate CRM writes; stub CRM displacing a real one |
| `cfd54bc` | Schema | Disconnect no longer erases the tool audit trail |
| `f930d21` | Security | Seed wrote real provider tokens in plaintext |
| `537b76a` | Billing tests | Suite stopped leaking unowned billable entities |
| `6862051` | GDPR | Retention for reasoning traces; category lists made to agree |
| `353aa9d` | Settings | Business hours moved to Postgres, Redis in front |
| `1d01844` | Billing tests | Cleanups no longer reach past their own fixtures |
| `77f5510` | Agents | Inert settable fields; dangling reference on delete |
| `bb4e1c3` | i18n | Hebrew no longer flashes left-to-right on every load |
| `132adb4` | Cleanup | The one module that is actually dead |

## IV-2. Where this audit was wrong

Each of these was acted on, found to be wrong, and corrected before code
changed. They are recorded because the audit is the artifact someone will plan
from, and a confident wrong finding costs more than a missing one.

**P1-5 — "two competing entitlement systems".** They are LAYERED, not
duplicated. `materializeEntitlements()` projects plan entitlements into
`tenant_features`; `hasFeature` then applies the per-role and per-user
dimension (240 `tenant_role_features` rows). Consolidating them, as the audit
recommended, would have made every purchased capability available to every user
in the tenant. Both file headers now state the boundary; `lib/features.ts` had
called itself "single source of truth for all gateable features", which is what
invited the wrong conclusion.

**Source of Truth — "route post-conversation-crm through `getSourceOfTruth()`".**
Backwards. That facade refuses only on `instanceof NoOpCRMAdapter`; the
writeback path refuses on `is_stub`. The facade is the LOOSER check, so
adopting it would have started "succeeding" against adapters that write
nothing. Pinned as an invariant instead.

**"12 inert AIAgent fields".** Measured: 5. Two specifics —
`confidenceThreshold` looked used with 15 references, every one belonging to
`IntelligenceDefinition`, a different model with the same field name; and
`goals` is marked legacy in the schema yet still flows into the bot config.

**"Dead code: Wix/Square OAuth, OPENAI_LOG, /copilot, /bot".** None are dead.
The adapters are parked with a documented re-enable path, `OPENAI_LOG` is a
debug facility, and both routes are working settings pages reachable by URL.
Acting on this list would have destroyed working code. One module was genuinely
dead: `lib/agent/grants.ts`.

**Redis durability.** The finding was real; my first statement of it was
overstated. Production Redis has a volume and appendonly (added for BullMQ,
covering these keys by accident). Dev had no volume, so dev erased settings on
every teardown. The durable problem is architectural, not the volume.

## IV-3. What the audit missed

**Real provider tokens stored in plaintext (P0-class).** `prisma/seed.ts` wrote
credentials as raw JSON while every runtime writer encrypts, and several reads
came from the environment. Six dev rows were plaintext; two were live Meta
tokens (207-char WhatsApp + 64-char webhook secret, 225-char Messenger). It
survived because every reader carries a
`typeof creds === "string" ? decrypt : creds` shim — the compatibility that
kept the seed working is what kept the plaintext invisible.
**These must be rotated. Encrypting in place narrows future exposure; it does
not undo past exposure.**

**The tool audit trail was deletable by a UI click.** `tool_executions`
cascaded off `tenant_tools`, and "Disconnect" deletes those rows.

**Connecting Monday silently disabled customer identity.** The CRM resolver
matched on SLUG, and the slug list included four vendors with no adapter.
`monday` is a PROJECT_MANAGEMENT integration; a Shopify merchant who connected
it had it resolved as their CRM ahead of Shopify, and every lookup returned
`no_crm_configured` without an error, because a stub ANSWERS rather than
throws. Latent — no tenant was connected to a stub vendor.

**The post-chat pipeline could run twice.** Read-then-act guard with an LLM call
inside the window. The duplicated CallAnalysis row collapses under `upsert`;
what the merchant saw was a second note and a second task in their CRM.

**11,981 unowned billable entities against 3 tenants**, all leaked by the
billing suite.

## IV-4. On measurement

Three of my own measurements were wrong during this sprint, in the same way the
audit's were:

- A billing run appeared to fail 5 files / 10 tests on FX fail-closed
  assertions. My shell was sourcing `.env`, which sets `BOI_FX_ENABLED=true`.
  Unset — the compose default in dev and prod — the same files pass 42/42.
- Comparing `CHANNEL_ENCRYPTION_KEY` fingerprints between host and container
  showed a match. Both were the SHA-256 of the empty string: the variable is
  `CHANNEL_ENCRYPTION_KEY`, and I had compared `ENCRYPTION_KEY`.
- Cleanup SQL scoped by `voice_channels.tenant_id`, which does not exist. tsc
  cannot check a raw query.

The pattern: a grep or a comparison that returns a plausible number is not
evidence. Every finding here that survived was confirmed by running something.

## IV-5. Still open

**P0-1 remains open and untouched**, as instructed. The two `ai-assist` execute
routes are unmodified. The platform is not production-ready while it stands.

Requiring a decision that is not mine:

1. **Rotate the exposed WhatsApp and Messenger tokens** at Meta.
2. **Check production for the same plaintext shape** —
   `npx tsx scripts/encrypt-plaintext-credentials.ts` (report-only by default).
3. **Run `scripts/backfill-durable-settings.ts` before the next Redis restart**
   in any environment where business hours / SLA / auto-greeting still exist
   only in the cache. After a restart there is nothing left to copy, and the
   loss is silent.

Not attempted: Phase 11 (observability). Test infrastructure was addressed
through the isolation work; observability was not.

Ratchets left in place deliberately, each failing only if it grows:
`enforcement-contract` at 17 unenforced capabilities, `agent-field-reachability`
at 1 UI-only field, `billable-entity-ownership` at cross-session survivors.
