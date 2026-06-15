# 02 - Migration Plan

Zero-downtime rollout. Each phase is independently deployable, reversible, and guarded. No phase requires a coordinated service restart across all containers.

Phases 0–3 are additive (schema expansion + dual-write). Phases 4–7 flip readers. Phase 8 drops the deprecated shapes.

**Do not skip phases.** Each one leaves the system in a working state.

---

## Phase 0 - Pre-flight (no DB change)

Owner: `packages/shared`

- [ ] Merge `docs/architecture/*` into main.
- [ ] Tag a release (`arch-lock-v1`).
- [ ] Add `ARCHITECTURE_PHASE=0` env var to every service (observability only).
- [ ] Instrument existing `RouterRule` evaluation to log `priority` value in use (so we see if anyone's relying on it post-rollout).
- [ ] Instrument `CopilotConfig` reads - log every caller for Phase 3 cleanup audit.

Rollback: none required (no code change that affects behavior).

---

## Phase 1 - Additive schema (forward-compatible, no drops yet)

Single Prisma migration. All columns added as nullable or with safe defaults.

```sql
-- 1. AIAgent: add copilot fields (nullable) + capabilities/behavioralAnchors/escalationGates/assistPrompt
ALTER TABLE ai_agents
  ADD COLUMN capabilities           jsonb NOT NULL DEFAULT '{"auto":true,"assist":true}',
  ADD COLUMN suggestion_style       text,
  ADD COLUMN max_suggestions        int  NOT NULL DEFAULT 3,
  ADD COLUMN summary_enabled        bool NOT NULL DEFAULT true,
  ADD COLUMN assist_prompt          text,
  ADD COLUMN behavioral_anchors     jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN escalation_gates       jsonb NOT NULL DEFAULT '[]';

-- 2. CatalogTool: add full tool contract + hitl policy + limits
ALTER TABLE catalog_tools
  ADD COLUMN when_to_use               text,
  ADD COLUMN example_usage             jsonb,
  ADD COLUMN allowed_modes             jsonb NOT NULL DEFAULT '["AUTO","ASSIST"]',
  ADD COLUMN hitl_policy               jsonb NOT NULL DEFAULT '{"mode":"never"}',
  ADD COLUMN timeout_ms                int  NOT NULL DEFAULT 10000,
  ADD COLUMN max_retries               int  NOT NULL DEFAULT 0,
  ADD COLUMN retry_backoff_ms          int  NOT NULL DEFAULT 1000,
  ADD COLUMN circuit_breaker_threshold int,
  ADD COLUMN schema_version            int  NOT NULL DEFAULT 1;

-- 3. RouterRule: add `position`, keep `priority` for now
ALTER TABLE router_rules
  ADD COLUMN position      int  NOT NULL DEFAULT 0,
  ADD COLUMN ai_agent_id   text,
  ADD COLUMN routine_id    text,
  ADD COLUMN department_id text;

-- Data migration: position = priority (preserve order)
UPDATE router_rules SET position = priority;

-- 4. Tenant: add fallback fields
ALTER TABLE tenants
  ADD COLUMN default_agent_id                      text,
  ADD COLUMN default_routine_id                    text,
  ADD COLUMN default_queue                         text,
  ADD COLUMN auto_resume_after_unclaim_minutes     int;

-- 5. Conversation: add mode, snapshot, intake
ALTER TABLE conversations
  ADD COLUMN mode                 text,              -- AUTO | ASSIST
  ADD COLUMN mode_reason          text,
  ADD COLUMN prompt_version_id    text,
  ADD COLUMN intake_facts         jsonb NOT NULL DEFAULT '{}';

-- 6. ApprovalRequest: policy snapshot
ALTER TABLE approval_requests
  ADD COLUMN policy_snapshot jsonb NOT NULL DEFAULT '{}';

-- 7. NEW tables (shadow - not yet used)
CREATE TABLE ai_agent_prompt_versions (
  id              text PRIMARY KEY,
  tenant_id       text NOT NULL,
  ai_agent_id     text NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  prompt_hash     text NOT NULL,
  fragments       jsonb NOT NULL,
  schema_version  int  NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ai_agent_id, prompt_hash)
);
CREATE INDEX ON ai_agent_prompt_versions (tenant_id, ai_agent_id);

CREATE TABLE agent_turn_logs (...);
CREATE TABLE proposed_tool_calls (...);

-- Routines: CREATE as NEW table - do NOT rename chatbot_flows yet.
-- We'll dual-write in phase 2, swap readers in phase 4, drop chatbot_flows in phase 8.
CREATE TABLE routines (
  id                text PRIMARY KEY,
  tenant_id         text NOT NULL,
  name              text NOT NULL,
  flow_type         text NOT NULL DEFAULT 'MAIN',
  parent_routine_id text REFERENCES routines(id) ON DELETE SET NULL,
  nodes             jsonb NOT NULL DEFAULT '[]',
  edges             jsonb NOT NULL DEFAULT '[]',
  is_active         bool NOT NULL DEFAULT true,
  run_count         int  NOT NULL DEFAULT 0,
  triggers          jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON routines (tenant_id, flow_type, is_active);
```

**Deployment:** Single Prisma `migrate deploy`. No service restart required - readers still use old shape.

Rollback: `DROP` all new columns + new tables. No data loss.

---

## Phase 2 - Dual-write (read old, write both)

Owner: `services/ai`

For every write path that touches deprecated state, also write the new shape:

1. **CopilotConfig writes** (tenant settings → copilot config endpoints):
   - Also upsert a corresponding `AIAgent` row with `capabilities={assist:true, auto:false}` and populate suggestion fields.
   - Upsert key: `(tenantId, departmentId=null)` → the tenant's default assist agent.

2. **ChatbotFlow writes** (flow builder save):
   - Mirror to `routines` with `flowType="MAIN"` and same nodes JSON.
   - Log any node type that isn't in the new allowlist - lint-only, don't block.

3. **TenantToolPermission writes**:
   - Mirror to `TenantTool.configOverrides.hitlPolicy` using strictest-wins composition.

4. **RouterRule writes**:
   - Set both `priority` AND `position` to the same value.

5. **AIAgent.conversationFlow / customGuardrails**:
   - Migrate into `behavioralAnchors` on every save. Retain the old field.

6. **Prompt regeneration**:
   - On every `generateAndSavePrompts` call, also snapshot to `ai_agent_prompt_versions` (idempotent on `promptHash`).

No reader changes in this phase. Deploy to **ai service only**.

Rollback: revert the code; new-shape rows remain orphaned but harmless.

---

## Phase 3 - Backfill (one-shot job)

Owner: ops / scripts team

Run once after Phase 2 is stable for ≥ 24h. All scripts idempotent.

```bash
npm run migrate:backfill:copilot-to-agent
npm run migrate:backfill:chatbotflows-to-routines
npm run migrate:backfill:tenant-tool-permissions
npm run migrate:backfill:ai-agent-anchors
npm run migrate:backfill:prompt-snapshots
npm run migrate:backfill:tenant-defaults
```

### 3a. `copilot-to-agent`

For every tenant:
1. Find all `CopilotConfig` rows (per-tenant + per-department variants).
2. Deterministic rule:
   - **Tenant-level default** → upsert `AIAgent` with `name="Default Assistant"`, `capabilities={auto:false, assist:true}`, `departmentId=null`.
   - **Per-department overrides** → upsert `AIAgent` with the department ID. Populate suggestion fields from the config.
3. Set `Tenant.defaultAgentId = <tenant-level default agent id>`.
4. Preserve existing `AIAgent` rows - only create agents for tenants that had a `CopilotConfig` but no matching agent.

### 3b. `chatbotflows-to-routines`

For every `ChatbotFlow`:
1. Copy to `routines` with `flowType="MAIN"` if it has a `triggers` array, else `SUB`.
2. Do NOT translate non-compliant nodes. Log warnings for each. Phase 5 linting handles it.

### 3c. `tenant-tool-permissions`

For every `TenantToolPermission`:
1. Find matching `TenantTool(tenantId, tool)`.
2. Merge into `TenantTool.configOverrides.hitlPolicy` with strictest-wins against any existing value.

### 3d. `ai-agent-anchors`

For every `AIAgent` with non-empty `conversationFlow` or `customGuardrails`:
1. Convert each item into an `Anchor { condition, intent, guidance }`.
2. Append to `behavioralAnchors`.
3. Leave old fields in place (cleared in Phase 8).

### 3e. `prompt-snapshots`

For every active `AIAgent`:
1. Assemble prompt once.
2. Hash fragments.
3. Insert into `ai_agent_prompt_versions` if new hash.

### 3f. `tenant-defaults`

For every tenant:
1. If `defaultAgentId` still null, pick the oldest `AIAgent` where `status='ACTIVE'` and `departmentId IS NULL`. Set as default.
2. If none, create a stub agent from `Tenant.onboardingAnswers` if available; otherwise leave null and emit a warning (support review).

**Acceptance:** all scripts complete with `warnings=0` or a triaged warnings list.

Rollback: the backfill is additive - rerun is safe.

---

## Phase 4 - Flip readers to new shape (behind feature flag)

Owner: `services/ai`, `services/incoming-worker`, `services/conversation`, `frontend`

Add env-flag `ARCHITECTURE_READ_NEW=true`. When true:

1. **Copilot resolution** reads `AIAgent` where `capabilities.assist=true` instead of `CopilotConfig`.
2. **Bot engine** reads agent tools via `AgentToolPermission` (already does after recent work).
3. **HITL evaluator** reads `CatalogTool.hitlPolicy` + `TenantTool.configOverrides` + `AgentToolPermission.requireApproval` via `evaluatePolicies()`. Stops reading `TenantToolPermission`.
4. **Routing** sorts by `position` ASC (with `isDefault=true` moved to end automatically by evaluator). Stops using `priority`.
5. **Flow engine** reads `routines` instead of `chatbot_flows`.
6. **Frontend**: AI Studio's Skills panel reads real `integrations`/`tenantTool.isEnabled` (already done). Copilot settings UI deleted.

Flip is done **per-service**, canary to 5% tenants, then 50%, then 100% within 48 hours. Tenant allowlist via Redis SET `arch:read-new:tenants`.

Rollback: flip `ARCHITECTURE_READ_NEW=false`. Deprecated tables are still live.

---

## Phase 5 - Lint-only routine enforcement (48-72h observation window)

Owner: `services/ai` + flow builder UI

- Save-time validator on `routines` runs in **warn mode**. Reject-looking responses are actually `200 {data, warnings: [...]}`.
- Frontend surfaces warnings as amber banners: "This node type is deprecated. It will stop working on 2026-MM-DD."
- Engine still executes old-style nodes.
- Track warning count per tenant in `AgentTurnLog.toolsOffered` metadata.
- Email / in-app notification to tenants with >0 warning count.

Exit criteria: <1% of production tenants have outstanding warnings. Extend window if needed.

Rollback: trivially disable the validator.

---

## Phase 6 - Stop dual-writes

Owner: `services/ai`

Once Phase 4 is at 100% and Phase 5 is clean:

1. Remove all dual-write code paths (Phase 2).
2. Deprecated tables stop receiving new rows.
3. Services log a one-line warning if ever written to via raw SQL (should never happen; flag for audit).

Rollback window closes here. If reverting is needed after this, do so by restoring a backup - not by switching flags.

---

## Phase 7 - Hard routine enforcement

Owner: `services/ai` + flow builder UI

1. Save-time validator returns `400` on non-compliant nodes.
2. Engine refuses to execute non-compliant nodes - returns an auto-escalation to human with reason `"routine_node_type_not_supported"` and logs the offending flow id.
3. Support runbook: how to rewrite an old flow into the new allowed node set (link from the error surface).

Rollback: not supported.

---

## Phase 8 - Drop deprecated tables + columns

Owner: `packages/shared`

Single final migration:

```sql
-- Tables
DROP TABLE copilot_configs;
DROP TABLE tenant_tool_permissions;
DROP TABLE chatbot_flows;              -- data already mirrored to `routines`
DROP TABLE chatbot_flow_runs;          -- replace with routine_runs if still needed

-- Columns
ALTER TABLE router_rules            DROP COLUMN priority;
ALTER TABLE ai_agents               DROP COLUMN autonomous_enabled;
ALTER TABLE ai_agents               DROP COLUMN conversation_flow;
ALTER TABLE ai_agents               DROP COLUMN custom_guardrails;
```

Remove `ARCHITECTURE_READ_NEW` flag. Remove all phase-1 dual-write code. Remove compatibility shims in `prompt-assembler.service.ts`.

Rollback: not possible. This is the point of no return.

---

## Go / no-go gate between each phase

Before advancing:

- [ ] Phase error rate ≤ pre-phase baseline.
- [ ] No tenant-isolation violations in `AuditLog` (`TenantGuard` triggers count = 0).
- [ ] P95 agent-turn latency within 10% of pre-phase baseline.
- [ ] Backfill warnings (if any) triaged by support.
- [ ] Dashboards green for 24h.

Any one NO = halt, fix, re-test. Do not advance the next tenant cohort.

---

## Timeline (calendar days)

| Phase | Length | Dependencies |
|---|---|---|
| 0 | 1 | - |
| 1 | 1 | 0 |
| 2 | 3 (code + review) | 1 deployed |
| 3 | 1 (off-hours run) | 2 stable |
| 4 | 5 (canary rollout) | 3 complete |
| 5 | 5 (observation) | 4 at 100% |
| 6 | 2 | 5 exit criteria met |
| 7 | 2 | 6 deployed |
| 8 | 1 | 7 stable |

Total calendar: **~21 days** minimum, with proper canaries and observation windows.

---

## Service restart order per phase

| Phase | Services to redeploy |
|---|---|
| 0 | none (env only) |
| 1 | db migration only |
| 2 | `ai` |
| 3 | none (script run) |
| 4 | `ai`, `incoming-worker`, `conversation`, `frontend` (in that order; flag-gated) |
| 5 | `ai` (validator-only change) |
| 6 | `ai` |
| 7 | `ai`, `incoming-worker` |
| 8 | db migration, then `ai`, then `incoming-worker`, then `frontend` |
