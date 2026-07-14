# Connector Checklist - copy per integration into `docs/integrations/<slug>-checklist.md`

> Normative reference: `docs/architecture/integration-framework.md` (§3).
> Every box is checked or explicitly N/A with a one-line reason. No silent skips.

## 0. Intake (decided before any code)
- [ ] Slug chosen (lowercase, underscores; becomes tool prefix `<slug>.<tool>`)
- [ ] `IntegrationCategory` chosen (ECOMMERCE/CRM/PAYMENTS/HELPDESK/…)
- [ ] Auth type identified (OAuth2 / OAuth2+PKCE / API key / PAT / JWT / service account / basic / custom)
- [ ] Tier decision recorded: Tier 1 only, or Tier 1 + capability promotion (which domain?)
- [ ] CRM bridge needed? (`canActAsCrm` - only if the provider can be a customer system of record)
- [ ] Webhooks needed now? Sync needed now? (default: NO for v1 unless the use-case demands events/freshness)
- [ ] Tool list drafted: ≤ 6 highest-frequency operations, each with category READ/WRITE/DELETE/ACTION + risk LOW/MED/HIGH

## 1. Provider research (evidence in `docs/integrations/<slug>.md`)
- [ ] API base URL + version + auth header format
- [ ] Token endpoint + refresh semantics (rotation? expiry?) - or N/A for non-expiring keys
- [ ] Rate limits documented (and whether 429 returns Retry-After)
- [ ] Native idempotency support (header? upsert key?) for every WRITE tool
- [ ] Pagination scheme (page token / cursor / offset)
- [ ] Webhook signature scheme (header, algorithm, secret source) - if webhooks in scope
- [ ] Required scopes - minimal set for the drafted tools, nothing more

## 2. Catalog seed
- [ ] `IntegrationCatalog` row: slug, name, descriptions, category, `authType`, `authSchema`, logo, docsUrl, `canActAsCrm`
- [ ] `CatalogTool` row PER TOOL (⚠️ the tool-gate silently DENIES dotted tools without a CatalogTool row)
- [ ] `hitlPolicy` seed per tool: HIGH risk ⇒ `always` or `on_condition`; money/irreversible/external ⇒ approval by default
- [ ] `whenToUse` + `exampleUsage` filled on every CatalogTool

## 3. Connector (`services/ai/src/services/connectors/<slug>.adapter.ts`)
- [ ] `TOOLS: ToolDefinition[]` - every field populated (description, whenToUse, whenNotToUse, parameters schema, sideEffects, idempotencyNotes, category, riskLevel)
- [ ] `execute()` switch - outputs are trimmed/mapped JSON, never raw provider dumps
- [ ] Private HTTP helper - errors thrown as `<slug>_<status>: <trimmed body>` (401/expiry text must be matchable by the dispatcher's `isAuthError`)
- [ ] Every WRITE uses `idempotencyKey(...)` (native header, or dedup-lookup-before-create)
- [ ] `refreshTokens()` implemented (OAuth/service-account) - or N/A
- [ ] `testConnection()` implemented (cheapest authenticated read) - or noted as pending Phase 1 hook
- [ ] `registerAdapter(...)` at module bottom + import line in `connectors/index.ts`
- [ ] No new npm dependencies (pipeline rule 3); LLM calls only in `services/ai` (rule 2)

## 4. Auth wiring
- [ ] OAuth2: init route (ADMIN-gated, JWT state 10m `{tenantId, provider, flow, …extras}`) + public callback (verify state → exchange → `upsertConnection` + `encryptCredentials`) - via shared engine when available
- [ ] PKCE: verifier carried inside the state JWT (Airtable pattern) - or N/A
- [ ] API key/PAT/basic: generic `POST /connectors/:slug/connect` suffices - or documented why not
- [ ] Env vars named `<PROVIDER>_CLIENT_ID`, `<PROVIDER>_CLIENT_SECRET`, `<PROVIDER>_REDIRECT_URI` and added to docker-compose env for `ai`
- [ ] Connect ends with a live credential probe; failure ⇒ ERROR + `lastError` (not silent CONNECTED)
- [ ] Meta selectors added ONLY if a config wizard needs them (Airtable/Monday pattern)
- [ ] Provider account identity persisted to `config` at connect (shop domain, account id…) - required later for webhook tenant resolution

## 5. Gates & permissions
- [ ] Tool surfaces obey the AND-rule (integration CONNECTED ∧ tool permitted) - verified in a live turn
- [ ] Dotted-name check: tool callable end-to-end (no tool-gate denial, post-tool reply works)
- [ ] Default `TenantTool` rows created on connect + backfilled on reconnect

## 6. Webhooks (if in scope, else N/A)
- [ ] Verifier spec (header, algorithm, secret source, timestamp tolerance)
- [ ] Tenant resolution mapping from payload → `TenantIntegration`
- [ ] Event persisted with `(slug, providerEventId)` dedup before processing
- [ ] Fast-2xx always; processing via queue with bounded retries
- [ ] `handleEvent` updates the domain's runtime home (the store `describeWorld` reads) - never calls the LLM directly

## 7. Sync (if in scope, else N/A)
- [ ] Incremental cursor defined + persisted (`config.syncCursor`)
- [ ] Full-sync path (first connect / admin resync) chunked
- [ ] Change-aware upsert (unchanged items skipped)
- [ ] 429/5xx bounded backoff; failures latch ERROR + `lastError`, never kill the tick

## 8. Capability promotion (Tier 2 - if in scope, else N/A)
- [ ] `<domain>.contracts.ts` - business language only; success + MUST invariants describe world-state (leak test passes)
- [ ] `<domain>.port.ts` + `.port.prod.ts` - port does I/O only, zero business rules
- [ ] `<domain>.runtime.ts` - every MUST invariant has a RUNTIME_VERIFIED verifier; trace emitted
- [ ] `<domain>.capability.ts` - `describeWorld` world-gates operations (not connected ⇒ `[]`); `registerCapability` called
- [ ] Approval mapped through `kernelApprovalGate` (op → policy tool)
- [ ] Loop policy set (tighten-only) if writes are external-facing
- [ ] Mode lifecycle respected: OFF → SHADOW (fire-and-forget under real traffic) → AUTONOMOUS

## 9. Tests
- [ ] Unit: every tool happy path + error shape + auth header + idempotency key (fetch mocked)
- [ ] Simulation: `executeAdapterTool` paths - not_connected, rate_limited, 401-retry, ERROR self-heal
- [ ] Routes: connect/status/disconnect + forged-state OAuth rejection
- [ ] Runtime/loop tests (Tier 2 only): every invariant outcome + menu gating
- [ ] Full suites green: `tsc` clean, shared + ai suites (no NEW failures vs baseline)

## 10. Live verification (the gate - nothing ships without it)
- [ ] `services/ai/scripts/pilot-<slug>.ts` run against real dev credentials: real READ arc + real WRITE arc + persistence check
- [ ] Rebuilt image: `docker compose up -d --build ai` (`--no-cache` if `packages/shared` changed)
- [ ] Live chat turn exercising one tool end-to-end (persist inbound Message row first - `/api/ai-bot/reply` ignores `incomingMessage`)
- [ ] Frontend arc verified if user-facing (marketplace connect → tool use) - no-half-work rule

## 11. Documentation
- [ ] `docs/integrations/<slug>.md` written (auth, env, tool table, quirks, test evidence)
- [ ] This checklist committed, all boxes ✓ or N/A'd
- [ ] Marketplace copy (catalog description/longDescription) reviewed
