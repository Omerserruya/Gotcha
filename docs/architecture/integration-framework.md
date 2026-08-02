# GOTCHA Integration Framework - Deterministic Process for Every Future Integration

> Status: **DESIGN - approved process, no code changes yet** (2026-07-04)
> Companion files: `docs/architecture/integration-checklist.md` (per-integration checklist),
> `~/.claude/skills/new-integration/SKILL.md` (the "New Integration" Claude Code skill).
>
> Goal: "Create a Shopify integration" / "Create a Zendesk integration" always produces the
> same shape, in the same places, with the same guarantees. **Extend the current
> architecture; never replace it.**

---

## 1. Architecture Review (what exists today - authoritative)

GOTCHA has **three integration planes**. They are complementary, not competing, and the
framework's first rule is knowing which plane(s) a new integration touches.

### Plane A - Connector plane (mandatory for every integration)

The tool-based marketplace plane. This is where **every** new integration starts.

| Piece | Where | What it does |
|---|---|---|
| `ProviderAdapter` | `services/ai/src/services/connectors/integration-framework.ts:44` | The connector contract: `slug`, `tools(): ToolDefinition[]`, `execute({ctx, toolName, args, credentials, config})`, optional `refreshTokens(credentials)` |
| `ToolDefinition` | `integration-framework.ts:14` | Per-operation contract: `name` (dotted `<slug>.<tool>`), `description`, `whenToUse`, `whenNotToUse`, `parameters` (JSON schema), `sideEffects`, `idempotencyNotes`, `category` (READ/WRITE/DELETE/ACTION), `riskLevel` (LOW/MEDIUM/HIGH) |
| Registry | `integration-framework.ts:298-310` | `registerAdapter()` at module bottom; `services/ai/src/services/connectors/index.ts` imports every adapter once at startup |
| Dispatcher | `executeAdapterTool()` `integration-framework.ts:320` | Parses `<slug>.<tool>` → rate-limit → `loadConnection` (decrypt, accepts CONNECTED **and** recoverable ERROR) → `ensureFreshToken` (proactive, 60s buffer, self-heals ERROR→CONNECTED) → execute → **401-retry-once** → audit log (secrets scrubbed) → `{ok, result|reason}` |
| Rate limiter | `integration-framework.ts:212-246` | In-process token bucket per `(tenantId, slug)` - burst 10, 1/s sustained, env-tunable |
| Idempotency | `idempotencyKey()` `integration-framework.ts:458` | Deterministic key over `(tenantId, conversationId, toolName, args)` - adapters attach it to provider write calls (Stripe `Idempotency-Key` header is the reference use, `stripe.adapter.ts:165`) |
| Status machine | `setConnectionStatus()` | `PENDING/TESTING/CONNECTED/ERROR/DISCONNECTED` on `TenantIntegration`; auth failures latch ERROR; successful refresh or call self-heals back to CONNECTED |

**Data model** (`packages/shared/prisma/schema.prisma`):
- `IntegrationCatalog` (:971) - slug, category (`IntegrationCategory` :949), `authType`
  (`AuthType` :963 = API_KEY/OAUTH2/BASIC_AUTH/WEBHOOK/CUSTOM), `authSchema`, `configSchema`,
  `canActAsCrm`, publishing/sort.
- `CatalogTool` (:1018) - DB mirror of the tool contract: `whenToUse`, `exampleUsage`,
  `allowedModes`, and the **HITL policy seed** (`{mode: never|always|on_condition, condition,
  approverRole, notifyChannels}`).
- `TenantIntegration` (:1084) - per-tenant connection: `status`, **encrypted** `credentials`
  JSON, `config` JSON, `lastError/lastTestedAt/lastTestResult`, unique `(tenantId, integrationId)`.
- `TenantTool` (:1110) + `AgentToolPermission` - per-tenant/per-agent tool activation.

**Tool surface**: adapter tools reach the LLM in `ai-bot.service.ts:1665` (iterates
`listAdapters()`), gated by the **AND-rule**: integration CONNECTED **and** tool permitted.
Dispatch: `ai-bot.service.ts:1515` and `tool-execution.service.ts:129`.

**Registered adapters today** (`connectors/index.ts`): stripe, hubspot, shopify, returngo,
fireberry, airtable, postgres, mongodb, woocommerce, paypal, salesforce, monday, aws_rds,
google-calendar (+ wix/square disabled). Reference adapter: `stripe.adapter.ts` -
~300 LOC, tools table + `execute` switch + private HTTP helper + `refreshTokens`.

### Plane B - CRM semantic plane (only when the provider can act as a CRM)

`CRMAdapter` (`connectors/crm-adapter.types.ts:246`) - vendor-neutral semantic operations
(`findCustomer`, `createLead`, `updateLead`, `createTask`…) implemented per vendor in
`crm-adapter.impl.ts` and resolved by the tenant's source-of-truth CRM
(`crm-adapter-resolver.ts:71`, honors `IntegrationCatalog.canActAsCrm` +
`TenantIntegration.config.useAsCrm`). Surfaces as the unified `integration_create_lead` /
`integration_create_contact` tools. A vendor like HubSpot legitimately exists in **both**
Plane A (vendor-specific dotted tools) and Plane B (semantic CRM bridge).

### Plane C - Capability plane (the agent-loop / pure-reasoning target)

The operation-centric plane the Agent Loop uses. Fully generic kernel; domains plug in:

- **Registry** (`services/ai/src/services/capability-plane/registry.ts:33`):
  `CapabilityRegistration = {name, ownsOperation(opId), describeWorld(ctx) →
  CapabilityWorldView, execute?(ExecutionRequest), loopPolicy?}`. One
  `registerCapability()` call; the loop/Oracle/Reasoner are untouched. Unowned operations
  return observable `BLOCKED` (never throw) (`registry.ts:86-96`).
- **Oracle** (`packages/shared/src/lib/agent/oracle.ts:64`): pure `assembleFacts(kernel
  signals + world views)`; derives the operation **menu** = union of every capability's
  live operations ∩ RBAC allow-list. Knows no domain.
- **Facts** (`agent/facts.ts`): kernel facts (customer identity, entitlements, billing,
  permissions, menu, `asOf`) + opaque `CapabilityWorldView[]` (`{capability, summary,
  facts, operations, observations?}`).
- **Guardrails** (`agent/guardrails.ts:27`): pure DENY plane between DECIDE and EXECUTE -
  billing suspended → deny, budget exhausted → deny, not on allow-list → deny, not on live
  menu → deny.
- **Contracts as data** (`packages/shared/src/lib/capability-runtime/contract.ts`):
  `OperationContract` = business-language only (meaning, params, outcome, success
  predicate, PRE/POST invariants MUST/SHOULD with `satisfierOperation`, failureModes,
  recoveryPosture, approval, dedupKey, destructive). Reference: `calendar.contracts.ts`.
- **Resolver** (`capability-runtime/resolver.ts:99`): pure pipeline - PRE invariants
  (probe-first, auto-satisfy via READ operations) → advisory-mode short-circuit
  (`RECOMMENDED`) → approval gate (`AWAITING_APPROVAL`) → strategy → POST invariants +
  success verification. Emits `ExecutionTrace` on every terminal return.
- **Ports** (`calendar.port.ts` etc.): pure provider I/O; **business rules live only in
  runtime verifiers** (`calendar.runtime.ts` Constraint 1).
- **Approval** (`capability-runtime/approval-gate.ts:39`): reuses production
  `evaluatePolicies` + `createApprovalRequest`; idempotent across turns (reuses pending
  request for the same tool+conversation).
- **Loop** (`agent/loop.ts`): pure control - EXECUTE re-enters, everything else
  terminates; resource ceilings only; capability `loopPolicy` tighten-only.
  Mode lifecycle per capability: **OFF → SHADOW → AUTONOMOUS**.

### Auth today

Eleven hand-rolled OAuth flows sharing one unwritten pattern
(`connectors-admin.ts` - stripe, hubspot, shopify per-shop, airtable **PKCE**, wix
install-flow, square, salesforce, monday; plus `crm-oauth.ts` Zoho, `calendar-oauth.ts`
Google, `knowledge-oauth.ts` Drive/Confluence):

1. `GET /connectors/:slug/oauth/init` (ADMIN-gated) - env `<PROVIDER>_CLIENT_ID` +
   `<PROVIDER>_REDIRECT_URI`, **state = signed JWT** `{tenantId, provider, flow, …extras}`
   10-minute expiry - the sole trust anchor.
2. Public `GET /connectors/:slug/oauth/callback` - verify state → exchange code →
   `findCatalog(slug)` → `upsertConnection()` with `encryptCredentials()` → 302 to
   marketplace (or `/setup` when `flow=onboarding`).

API-key/PAT/connection-string: generic `POST /connectors/:slug/connect`
(`connectors-admin.ts:161`) - stores encrypted credentials and flips CONNECTED
(**without testing them** - see Gap G2). Provider-specific meta selectors exist for
config wizards (Airtable bases/tables/fields, Monday boards, Postgres/Mongo/RDS
introspection).

Token refresh: centralized for Plane A (`ensureFreshToken`), but **separately hand-rolled**
in `google-drive.service.ts`, `confluence.service.ts`, Zoho/HubSpot/Salesforce paths in
`crm-adapter.impl.ts`, and calendar OAuth.

### Webhooks today

**Channel-plane only.** `services/webhook/src/routes/webhook.ts` handles messaging
providers (WhatsApp/Meta, Instagram, Gmail, Outlook, Slack) via `detectInboundAdapter` +
per-provider signature verification + fast-200 + queue handoff (`incomingMessageQueue` →
`services/incoming-worker`). Tenant resolved by ChannelAccount lookup (cross-tenant
middleware, safe because signatures are verified first). **No third-party integration
(Stripe/Shopify/CRM) webhook receiver exists.** The idempotency pattern to generalize
already exists: `BillingWebhookEvent` (`schema.prisma:2254`) - unique provider event id +
`processed_at` marker.

### Sync today

**Knowledge only.** `knowledge-sync.service.ts` - repeatable BullMQ cron tick (hourly),
per-integration change-aware re-sync (version markers skip unchanged docs),
`config.autoSync` opt-out, cross-tenant worker, concurrency 1. Drive/Confluence own their
pagination + token refresh. No generic sync framework for CRM/commerce; CRM context is
fetched on demand per turn (`crm-prefetch.service.ts`).

---

## 2. Gap Analysis

| # | Gap | Evidence | Severity |
|---|---|---|---|
| G1 | **OAuth is copy-paste**: every provider = ~80 duplicated lines (init/callback/exchange). PKCE exists only for Airtable. No shared `OAuthProviderSpec` helper. | `connectors-admin.ts:185-901`, 3 more route files | High (velocity + drift) |
| G2 | **No credential validation at connect**: API-key connect stores CONNECTED without a live test call; `ProviderAdapter` has no `testConnection()` hook (`lastTestedAt` is set but nothing was tested). | `connectors-admin.ts:161-183` | High (silent broken connections) |
| G3 | **Args are NOT schema-validated at dispatch** despite the contract comment claiming "args are validated … (best-effort)". `executeAdapterTool` performs no JSON-schema check. | `integration-framework.ts:53` vs `:320-450` | Medium |
| G4 | **No integration webhooks**: no generic receiver, verifier registry, event persistence/dedup, or Observation generation for Shopify/Stripe/CRM events. Billing's dedup table is a one-off. | `services/webhook/src/routes/*`, `schema.prisma:2254` | High (blocks event-driven integrations) |
| G5 | **No generic sync framework**: knowledge-sync is provider-specific; no shared cursor store, retry/backoff, pagination, or rate-limit convention for background sync. | `knowledge-sync.service.ts` | Medium |
| G6 | **Tool contract duplication**: `ToolDefinition` in code AND `CatalogTool` rows in DB must both exist - the tool-gate **DENIES dotted tools with no CatalogTool row** (learned incident). No generator keeps them in sync. | tool-gate static-policy trap; seed scripts | High (recurring silent-denial bug class) |
| G7 | **Retry/backoff**: only the auth 401-retry exists; 429/5xx transient failures are surfaced raw with no bounded-retry helper (each adapter would hand-roll). | `integration-framework.ts:396-421` | Medium |
| G8 | **Rate limiter is in-process** - documented as single-process-correct; must move to Redis before multi-instance. | `integration-framework.ts:219-221` | Low (known, documented) |
| G9 | **Disconnect doesn't revoke** tokens at the provider; no scope-diff detection on reconnect; permission changes surface only as runtime 403s. | `connectors-admin.ts:129-141` | Medium |
| G10 | **Token refresh is fragmented**: Plane A centralized, but Drive/Confluence/Zoho/Google-Calendar each hand-roll refresh. | `google-drive.service.ts:45`, `confluence.service.ts:57` | Medium |
| G11 | **AuthType enum too coarse**: no PKCE/JWT/SERVICE_ACCOUNT/PAT distinction (everything non-OAuth collapses to API_KEY/CUSTOM); `authSchema` JSON is free-form per integration. | `schema.prisma:963` | Low |
| G12 | **The process is tribal knowledge**: the 5-step comment in `connectors/index.ts:9-15` is the only "guide"; capability-plane promotion (contracts+port+runtime+capability) is undocumented as a procedure. | - | High (the reason for this framework) |

Non-gaps (deliberate, keep as-is): dotted tool naming, JWT-state OAuth (stateless, safe),
ERROR-latch + self-heal, approval reuse via `evaluatePolicies`, contracts-as-data,
port/verifier split, loop policy tighten-only.

---

## 3. Final Framework (the deterministic model)

### 3.0 The two-tier rule (decide once per integration)

Every integration is built at **Tier 1 (Connector)**. **Tier 2 (Capability)** is a separate,
optional promotion:

- **Tier 1 - Connector**: dotted tools for the legacy brain + copilot. ALWAYS built.
  Provider-specific vocabulary is fine (`shopify.get_order`).
- **Tier 2 - Capability promotion**: only when the domain earns a place in the Agent Loop
  (business-language operations, invariants, world self-description). Never build Tier 2
  first; never skip Tier 1. Promotion of a *domain* (e.g. COMMERCE) can be shared by many
  Tier-1 connectors behind one port (exactly like CALENDAR ports Google today, Outlook
  tomorrow).
- **CRM bridge**: additionally implement `CRMAdapter` **iff** the provider can be a
  tenant's customer system of record (`canActAsCrm`).

### 3.1 Authentication - one engine, seven types

All auth flows normalize into an `AuthSpec` (data, not code) carried by
`IntegrationCatalog.authSchema`; a **single shared OAuth engine** replaces per-provider
copies (new file, e.g. `services/ai/src/services/connectors/oauth-engine.ts`, mounted as the
generic `/connectors/:slug/oauth/init|callback` in `connectors-admin.ts` - existing
provider routes stay grandfathered until migrated):

| Type | Spec fields | Storage (`credentials` JSON, always `encryptCredentials`ed) | Refresh |
|---|---|---|---|
| **OAuth2 (auth-code)** | `authorizeUrl`, `tokenUrl`, `scopes`, `extraAuthParams`, `clientIdEnv`, `clientSecretEnv`, `redirectUriEnv`, `tokenAuthStyle` (body/basic/bearer-secret), `stateExtras` (e.g. `shop`, `loginHost`) | `{accessToken, refreshToken, expiresAt, scope, …providerExtras}` | framework `ensureFreshToken` + adapter `refreshTokens()` |
| **OAuth2 + PKCE** | same + `pkce: "S256"` - verifier rides inside the signed state JWT (Airtable pattern, `connectors-admin.ts:447-526`) | same | same |
| **API Key** | `fields: [{key, label, secret}]` | `{apiKey, …}` | none |
| **PAT** | same as API key, `docsUrl` for token creation | `{pat}` | none (expiry surfaces via testConnection) |
| **JWT (app-signed)** | `signingKeyEnv`, `claims`, `ttl` | `{issuerConfig}` - short-lived JWT minted per call in the adapter, never stored | mint-per-call |
| **Service Account** | `fields: [{key: "serviceAccountJson", secret: true}]`, `tokenUrl` (e.g. Google JWT-bearer grant) | `{serviceAccountJson}` + cached `{accessToken, expiresAt}` | `refreshTokens()` re-mints via signed assertion |
| **Basic / Custom** | `fields` (username/password or bespoke) | `{username, password}` / bespoke | none / adapter-defined |

Invariants that hold for every type:
1. Credentials are stored **only** on `TenantIntegration.credentials`, encrypted, never logged
   (`scrubSecrets` guards audit args).
2. OAuth state = signed 10-min JWT `{tenantId, provider, flow, …extras}`; callback is public
   and trusts only the state.
3. Connect (any type) ends with a **`testConnection()` probe** (new optional
   `ProviderAdapter` hook, closes G2): cheapest authenticated read; success → CONNECTED,
   failure → ERROR + `lastError`. `lastTestedAt/lastTestResult` become honest.
4. Refresh is owned by the framework (`ensureFreshToken`): proactive 60s buffer, force-on-ERROR
   self-heal, persist-after-refresh, 401-retry-once. Adapters only implement the provider
   token exchange in `refreshTokens()`. (G10: Drive/Confluence/Zoho migrate onto this over time.)

### 3.2 Connector structure - the exact deterministic layout

For integration `<slug>` (e.g. `zendesk`):

```
services/ai/src/services/connectors/<slug>.adapter.ts   # Connector + Operations (ONE file)
  ├─ const TOOLS: ToolDefinition[]                      # complete tool contracts
  ├─ const <Slug>Adapter: ProviderAdapter               # slug, tools(), execute(), refreshTokens?(), testConnection?()
  ├─ private HTTP helper (<slug>Request)                # auth header, error shape `<slug>_<status>: body`
  └─ registerAdapter(<Slug>Adapter)                     # module bottom

services/ai/src/services/connectors/index.ts            # + one import line

services/ai/src/routes/connectors-admin.ts              # auth wiring:
  • OAuth2 → spec entry for the shared engine (or grandfathered explicit routes)
  • API key/PAT/basic → generic POST /connectors/:slug/connect (already exists)
  • meta selectors ONLY if a config wizard needs them

packages/shared/prisma/ (seed)                          # IntegrationCatalog row (slug, category,
                                                        # authType, authSchema, canActAsCrm)
                                                        # + CatalogTool row PER TOOL (generated
                                                        # from TOOLS - closes G6) incl. hitlPolicy seed

services/webhook/src/routes/integration-events.ts       # (only if provider pushes events)
  └─ per-provider verifier + IntegrationEvent persistence + queue handoff   [NEW, §3.6]

services/ai/src/services/integration-sync/<slug>.sync.ts # (only if background sync needed) [NEW, §3.7]

services/ai/src/__tests__/<slug>.adapter.test.ts        # unit tests (fetch mocked)
services/ai/scripts/pilot-<slug>.ts                     # live-verification harness (pilot-calendar-loop.ts pattern)

frontend: marketplace card renders from IntegrationCatalog automatically;
          add a config wizard page ONLY for mapping-style config (Airtable pattern).
```

**Capability promotion (Tier 2) adds exactly five files** (the CALENDAR template):

```
services/ai/src/services/capability-runtime/<domain>.contracts.ts  # OperationContracts (business language ONLY)
services/ai/src/services/capability-runtime/<domain>.port.ts       # pure I/O interface
services/ai/src/services/capability-runtime/<domain>.port.prod.ts  # prod port (may call Tier-1 adapters/executeAdapterTool)
services/ai/src/services/capability-runtime/<domain>.runtime.ts    # verifiers (business rules) + bindings + resolver call
services/ai/src/services/capability-plane/<domain>.capability.ts   # registerCapability({name, ownsOperation, describeWorld, execute, loopPolicy})
```

### 3.3 Runtime - how operations become available and execute

**Tier 1 (Connector → legacy brain/copilot):**
1. Adapter self-registers at import (`connectors/index.ts`).
2. Surface: tool appears IFF (TenantIntegration CONNECTED) AND (tool permitted for the
   agent) - the AND-rule; policy pre-filter drops DENYs before the LLM round.
3. Dispatch: LLM emits `<slug>.<tool>` → `executeAdapterTool` → rate limit → connection →
   fresh token → (NEW, G3) validate args against `parameters` schema → `adapter.execute` →
   401-retry-once → audit → `{ok:true,result} | {ok:false,reason}`. Errors never throw
   into the turn; the model reads the structured failure and adapts.
4. Guardrails at this tier = HITL policy (`evaluatePolicies` on CatalogTool floor + tenant
   override) + AgentToolPermission + rate limit + billing metering at `generateResponse()`.

**Tier 2 (Capability → Agent Loop):**
1. `registerCapability()` - the loop/Oracle/Reasoner never change.
2. Each tick, `describeAllWorlds()` collects every capability's `CapabilityWorldView`
   (parallel, throw-degrades-to-empty - never blocks the Oracle).
3. Oracle `assembleFacts()` derives the menu = union of live operations ∩ RBAC.
4. Reasoner proposes ONE operation from the menu.
5. **Guardrails** (`authorizeOperation`) - deterministic DENY between decide and execute:
   billing suspended / budget exhausted / not permitted / not on live menu.
6. `executeOperation()` routes to the owning capability → contracts + verifiers +
   resolver pipeline (PRE → mode → approval → strategy → POST/success) → observable
   `ExecutionResult` + `ExecutionTrace` re-enters the loop as an Observation.
7. Loop policies compose tighten-only (`engagedLoopPolicies`).

### 3.4 Oracle - describeWorld discipline

`describeWorld(ctx)` must be: **fast** (parallel reads, memoized within a turn), **honest**
(read the mutated home - e.g. active bookings - never a cache the runtime just invalidated),
and **fail-soft** (throw → degraded empty view).

| Belongs in | Content | Example (CALENDAR) |
|---|---|---|
| `facts` | Deterministic, current-world booleans/values the Reasoner may rely on but never contradict | `{calendarConnected, bookable, activeBooking, agentTimezone}` |
| `summary` | ONE LLM-readable sentence of the domain state | "A meeting is booked for 2026-07-05T14:00Z." |
| `operations` | Only operations genuinely available RIGHT NOW (world-gated: not connected → `[]`) | 4 contracts only when connected |
| `observations` | Salient, transient, this-tick notes (recent external event, degraded provider, unusual state worth attention) | "Provider returned 429s in the last hour" |
| **Nowhere** | Vendor/tool/endpoint names, credentials, raw provider payloads, business *judgments* (intent, sentiment), stale caches, anything the kernel would have to interpret | - |

Kernel truth (identity, billing, permissions) is NOT a capability - the Oracle assembler
reads it directly. Facts are authoritative; Observations are ephemeral inputs to reasoning;
judgment lives only in the Reasoner.

### 3.5 Operations - the contract every operation implements

**Tier 1 (`ToolDefinition`)** - required for every tool, no field skipped:
- **Inputs**: `parameters` JSON schema; customer-supplied params (when/who/amount) must be
  asked for, never invented (hard-rule discipline in `whenToUse`/`whenNotToUse`).
- **Outputs**: small JSON the LLM can narrate - mapped/trimmed fields, never raw provider dumps.
- **Approval**: `riskLevel` HIGH ⇒ CatalogTool `hitlPolicy` seed `always` (or `on_condition`);
  tenant override is authoritative. Money/irreversible/external-broadcast ⇒ approval by default.
- **Idempotency**: every WRITE computes `idempotencyKey(...)` and passes it to the provider
  (native header where supported; else dedup-lookup-before-create, the Airtable
  `idempotencyField` pattern); `idempotencyNotes` states the key contract.
- **Validation**: schema-validated at dispatch (G3 fix); adapter re-checks semantic
  requirements and throws typed errors.
- **Policies**: category READ/WRITE/DELETE/ACTION drives permission filtering; the
  CatalogTool row MUST exist or the tool-gate silently denies (G6).
- **Errors**: throw `Error("<slug>_<status>: <trimmed body>")` - the dispatcher's
  `isAuthError` regex catches 401/expiry variants for the retry path; everything else
  surfaces as `{ok:false, reason}`.
- **Observation generation**: the returned JSON *is* the model-visible observation;
  the audit row (`adapter.ok.<tool>`) is the system-visible one.

**Tier 2 (`OperationContract`)** - business language only (the leak test: `success` and
every MUST invariant describe **world-state**, never a tool result):
- `meaning`/`params`/`outcome` = the planner-visible face.
- `success` predicate + PRE/POST invariants (MUST ⇒ RUNTIME_VERIFIED; satisfiable PRE deps
  name a `satisfierOperation`); `onUnsatisfied` → NEEDS_INPUT/FAILED.
- `recoveryPosture` (retries/alternatives/askCustomer/escalate), `approval`
  (none/configurable/always → kernelApprovalGate → existing Approvals inbox),
  `dedupKey` (business identity of a no-op repeat), `destructive` (no blind retries).
- Every business rule = a **verifier** in `<domain>.runtime.ts` bound by predicate id -
  one rule, one place; a missing RUNTIME_VERIFIED verifier fails loud at execution.

### 3.6 Webhooks (NEW generic layer - the one real addition)

Generalize the channel-webhook + billing-dedup patterns into ONE integration-events path:

1. **Endpoint**: `POST /webhooks/integrations/:slug` in `services/webhook` (public, raw-body
   preserved).
2. **Verify**: per-provider `WebhookVerifierSpec` registered beside the adapter -
   `{signatureHeader, algorithm (hmac-sha256/hmac-base64/provider-jwt), secretSource (env |
   TenantIntegration.credentials.webhookSecret), timestampTolerance}`. Unverifiable ⇒ drop
   (2xx to the provider, warn log) - same posture as Meta today.
3. **Resolve tenant**: from the provider payload's account identity mapped via
   `TenantIntegration` (e.g. Shopify shop domain, Stripe account id - stored in `config`
   at connect time). Cross-tenant lookup is safe *after* signature verification (existing
   precedent, `webhook.ts:18-24`).
4. **Persist + dedup**: new `IntegrationEvent` table generalizing `BillingWebhookEvent`:
   `(slug, providerEventId)` unique, payload, `receivedAt`, `processedAt`, `status`,
   `attempts`. Duplicate delivery = ack + skip.
5. **Queue**: BullMQ handoff (fast-200 always); worker executes the adapter's
   `handleEvent(event)` (new optional `ProviderAdapter` hook) with bounded retries.
6. **Update Oracle / create Observations**: `handleEvent` writes to the domain's
   **runtime home** (the same store `describeWorld` reads - e.g. MeetingBooking, CRM
   flags, order state). The next tick's `describeWorld` picks it up as fresh facts, and
   may surface it in `observations` ("order 1042 was refunded 4 minutes ago"). Webhooks
   NEVER inject prompts or call the LLM directly - they update world-state only.

### 3.7 Sync (NEW generic layer, generalizing knowledge-sync)

`integration-sync.service.ts` - one repeatable BullMQ tick (cron, env-tunable) iterating
CONNECTED TenantIntegrations whose adapter registers a `sync` module:

- **Contract**: `sync({connection, cursor, mode}) → {cursor', counts, done}`.
- **Incremental**: cursor (provider `updated_since` timestamp / page token / version
  marker) persisted in `TenantIntegration.config.syncCursor`; change-aware upsert
  (knowledge-sync's skip-unchanged discipline).
- **Full**: `mode: "full"` ignores the cursor (first connect, admin-triggered resync,
  cursor-corruption recovery); chunked so one tenant can't starve the tick.
- **Retries**: per-integration try/catch (one failure never kills the tick - existing
  pattern); bounded exponential backoff on 429/5xx via a shared `withBackoff` helper
  (also fixes G7 for adapters); repeated failure latches `TenantIntegration` ERROR +
  `lastError`.
- **Rate limiting**: sync calls pass through the same per-`(tenant, slug)` token bucket as
  tool calls - one budget per provider, no double accounting.
- **Pagination**: adapters expose `paginate(fetchPage)` - an async iterator honoring
  provider page tokens; the framework owns loop bounds (max pages per tick).

### 3.8 OAuth lifecycle (states and transitions)

| Event | Handling |
|---|---|
| **Install** | init → provider consent → callback → upsert CONNECTED + `testConnection` probe + default TenantTool rows + backfill missing tool rows (Zoho pattern, `crm-oauth.ts:167-184`) |
| **Refresh** | proactive (60s buffer) on use; force-refresh when latched ERROR; refreshed blob persisted; refresh FAILURE (revoked) ⇒ ERROR + `token_refresh_failed:…` |
| **Expired token** | never a dead end: ERROR rows still load (`loadConnection` includes ERROR), self-heal on first successful refresh/call |
| **Reconnect** | re-run init/callback; upsert over the same row; compare granted `scope` vs requested - narrower ⇒ `lastError: "scopes_reduced:<missing>"` + keep ERROR (G9 partial fix) |
| **Permission changes** | runtime 403 on a specific call ⇒ NOT an auth error - surface to the model as `{ok:false, reason}`; adapter maps known scope-403s to actionable reasons (HubSpot strip-and-retry precedent) |
| **Disconnect** | status DISCONNECTED (tools vanish next turn via the AND-rule); call the provider's revoke endpoint when one exists (G9); credentials retained encrypted for audit until purge |

### 3.9 Testing ladder (every integration climbs all rungs)

1. **Unit**: adapter tests with mocked `fetch` - each tool happy path, error shape, auth
   header, idempotency key attached on writes, `refreshTokens` exchange.
2. **Connector simulation**: dispatcher-level test through `executeAdapterTool` with a
   seeded fake TenantIntegration - rate-limit path, not_connected path, 401-retry path,
   ERROR self-heal (the `oauth-refresh.test.ts` pattern).
3. **Integration**: route tests for connect/status/disconnect (+ OAuth callback with a
   forged-state rejection case).
4. **Runtime tests** (Tier 2 only): contracts through `resolveExecution` with a fake port -
   every invariant outcome (`capability-runtime.e2e.test.ts` pattern).
5. **Loop tests** (Tier 2 only): capability registered in a test registry; Oracle menu
   gating (connected/disconnected), guardrail denials, observation re-entry.
6. **Live verification**: `services/ai/scripts/pilot-<slug>.ts` harness against real
   credentials on dev (the `pilot-calendar-loop.ts` precedent) - real read arc, real write
   arc, persistence check. **Gate**: no integration is announced done without this
   (no-half-work rule: user-facing tickets also need the frontend arc + E2E).

Known environment gotchas the process bakes in: backend images are baked - `docker compose
up -d --build ai` after code changes, `--no-cache` when `packages/shared` changed; dev-DB
migration drift (prefer `select` over `include`); token-budget exhaustion mimics bugs in
E2E (raise cap, clean usage_logs after).

### 3.10 Documentation outputs (per integration, generated by the skill)

1. `docs/integrations/<slug>.md` - auth type + env vars, tool table, webhook/sync notes,
   test evidence, known provider quirks.
2. A ticked copy of the **Connector Checklist** (`docs/architecture/integration-checklist.md`).
3. Marketplace copy (catalog `description`/`longDescription`).

---

## 4. Claude Skill - see `~/.claude/skills/new-integration/SKILL.md`

The skill turns "Create a Zendesk integration" into the deterministic 10-phase procedure:
intake → provider research → catalog seed → connector scaffold → auth wiring → gates &
HITL → (webhooks) → (sync) → tests → live verification + docs. Full spec lives in the
skill file; §3 above is its normative reference.

---

## 5. Implementation roadmap

**Phase 0 - Docs only (this change)**
Framework doc + checklist + skill. No code. New integrations already become deterministic
by following §3 against the existing architecture.

**Phase 1 - Framework hardening (small, high-leverage, no behavior change for existing adapters)**
1. `testConnection?()` hook on ProviderAdapter + wire into `POST /connectors/:slug/connect`
   and OAuth callbacks (G2).
2. JSON-schema arg validation in `executeAdapterTool` (G3) - log-only first, then enforce.
3. `seed-catalog-tools.ts` generator: `CatalogTool` rows derived from each adapter's
   `TOOLS` (G6 - kills the silent-denial bug class).
4. Shared `withBackoff` helper for 429/5xx (G7).

**Phase 2 - OAuth engine (G1, G11)**
Data-driven `OAuthProviderSpec` + generic init/callback; migrate ONE provider (Monday -
simplest) as proof; new providers use the engine; grandfathered routes migrate
opportunistically. Add PKCE + service-account grant support to the engine.

**Phase 3 - Integration webhooks (G4)**
`IntegrationEvent` table (generalize BillingWebhookEvent) + `/webhooks/integrations/:slug`
+ verifier registry + `handleEvent` hook + BullMQ worker. Pilot: Shopify order events
(pairs with the existing Shopify adapter + commerce use-cases).

**Phase 4 - Generic sync (G5, G10)**
`integration-sync.service.ts` scheduler + cursor convention; migrate knowledge-sync onto it
last (it already works - lowest urgency); move Drive/Confluence/Zoho refresh onto
`ensureFreshToken`.

**Phase 5 - First skill-driven integration (the proof)**
Run `/new-integration` for a real target (Zendesk or Outlook). Fix whatever the skill got
wrong; freeze v1. Every subsequent integration is skill-driven.

**Ordering rationale**: 0→1 unblock determinism immediately; 2-4 remove the three biggest
copy-paste surfaces before the integration count grows; 5 validates the loop end-to-end.
Redis rate limiter (G8) and provider token revocation (G9) ride along whenever their files
are next touched.
