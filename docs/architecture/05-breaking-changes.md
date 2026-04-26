# 05 — Breaking Changes Summary

Explicit list for changelog, migration scripts, and PR descriptions. Every item below is permanent after Phase 8.

---

## REMOVED (tables / columns dropped)

| Removed | Replaces with | Phase |
|---|---|---|
| Table `copilot_configs` | Fields absorbed into `ai_agents` | 8 |
| Table `tenant_tool_permissions` | `tenant_tools.config_overrides.hitlPolicy` | 8 |
| Table `chatbot_flows` | `routines` | 8 |
| Table `chatbot_flow_runs` | `routine_runs` | 8 |
| Column `router_rules.priority` | `router_rules.position` | 8 |
| Column `ai_agents.autonomous_enabled` | `ai_agents.capabilities.auto` | 8 |
| Column `ai_agents.conversation_flow` | `ai_agents.behavioral_anchors` | 8 |
| Column `ai_agents.custom_guardrails` | `ai_agents.behavioral_anchors` / `escalation_gates` | 8 |
| Constant `HIGH_RISK_TOOLS` (code) | `evaluatePolicies()` uses `CatalogTool.hitlPolicy` | 4 |
| Function `evaluateToolGate` (code) | `evaluatePolicies()` | 4 |
| Function `buildAgentTools` (code) | `buildToolSurface({mode})` | 4 |
| Function `buildAgentToolsForAIAgent` (code) | merged into `buildToolSurface({mode})` | 4 |
| Function `dispatchToolCall` (code) | `dispatchTool(mode, call, ctx)` | 4 |
| Function `processAIBot` (code) | `executeAgentTurn({mode:"AUTO"})` | 4 |
| Endpoint `POST /api/system-chat/*` (non-admin copilot config paths) | `ai_agents` endpoints | 8 |

---

## MERGED (multiple things → one)

| Merged | Into | Notes |
|---|---|---|
| `CopilotConfig` + `AIAgent` | `AIAgent` | Per-tenant + per-department copilot configs become AIAgent rows. `capabilities.assist=true` flag. |
| `TenantToolPermission` + `AgentToolPermission` + `CatalogTool.hitlPolicy` | `evaluatePolicies()` composition | Strictest-wins composition. Catalog is floor; tenant/agent can only tighten. |
| `buildAgentTools` + `buildAgentToolsForAIAgent` + (planner) `TOOL_REGISTRY` reads | `buildToolSurface({mode})` | One function, mode-filtered. |
| Bot engine (`processAIBot`) + Copilot assist (`getSuggestionsForConversation`) | `executeAgentTurn({mode})` | Single engine, mode flag chooses output shape. |
| `AIAgent.conversationFlow` + `AIAgent.customGuardrails` | `AIAgent.behavioralAnchors` | Guidance, not executable. |
| Bot-side escalation heuristics + `AIAgent.escalationRules` (deterministic half) | `AIAgent.escalationGates` | Run in `evaluatePolicies()` / pre-flight. |

---

## RENAMED

| From | To |
|---|---|
| Table `chatbot_flows` | `routines` |
| Table `chatbot_flow_runs` | `routine_runs` |
| Model `ChatbotFlow` | `Routine` |
| Field `ChatbotFlow.isDefault` (N/A — didn't exist) | n/a |
| Field `RouterRule.priority` | `RouterRule.position` (semantic unchanged: smaller = earlier) |
| Field `AIAgent.conversationFlow` | `AIAgent.behavioralAnchors` (semantic narrowed: guidance only) |
| Field `AIAgent.autonomousEnabled` | `AIAgent.capabilities.auto` (bool → bool inside JSON) |
| Enum `RouteType` values: kept | kept: `AGENT | ROUTINE | HUMAN`; removed `FLOW` in favor of `ROUTINE` |

---

## DEPRECATED (kept operating, use discouraged)

During Phases 2–7, these continue to function but emit warning logs. They are eliminated in Phase 8.

| Deprecated | Warning message | Remove phase |
|---|---|---|
| Writing to `CopilotConfig` | `[DEPRECATED] CopilotConfig writes will stop working on {date}. Use AIAgent.` | 6 (stop writes) → 8 (drop table) |
| Writing to `TenantToolPermission` | `[DEPRECATED] Use TenantTool.configOverrides.hitlPolicy` | 6 → 8 |
| `ChatbotFlow` with non-allowlist node types | `[DEPRECATED] Node type {X} not supported in the Routine engine. Must be migrated by {date}.` | 7 (reject saves) → 8 (engine refuses execution) |
| Reading `RouterRule.priority` in application code | `[DEPRECATED] RouterRule.priority is gone; use position.` | 4 (readers flipped) → 8 (column dropped) |
| `AIAgent.conversationFlow` reads | `[DEPRECATED] Use behavioralAnchors.` | 4 → 8 |
| `send_message` static tool called for interactive payloads | `[DEPRECATED] Use interactive_reply for button / list content.` | 5 → 8 |

---

## NEW (added)

### Tables

| Table | Purpose |
|---|---|
| `ai_agent_prompt_versions` | Snapshot per assemble; enables replay |
| `agent_turn_logs` | Unified per-turn audit row |
| `proposed_tool_calls` | Assist-mode staging (server-authoritative args) |
| `routines` | Deterministic intake / menu flows |

### Columns

| Table | Column | Purpose |
|---|---|---|
| `ai_agents` | `capabilities`, `behavioral_anchors`, `escalation_gates`, `assist_prompt`, `suggestion_style`, `max_suggestions`, `summary_enabled` | Absorb CopilotConfig + split old fields |
| `catalog_tools` | `when_to_use`, `example_usage`, `allowed_modes`, `hitl_policy`, `timeout_ms`, `max_retries`, `retry_backoff_ms`, `circuit_breaker_threshold`, `schema_version` | Complete tool contract |
| `router_rules` | `position`, `ai_agent_id`, `routine_id`, `department_id` | List-ordered routing |
| `tenants` | `default_agent_id`, `default_routine_id`, `default_queue`, `auto_resume_after_unclaim_minutes` | Fallback ladder + handoff |
| `conversations` | `mode`, `mode_reason`, `prompt_version_id`, `intake_facts` | Per-conversation mode + snapshot |
| `approval_requests` | `policy_snapshot` | Self-contained HITL record |

### Functions / endpoints

| New | Location |
|---|---|
| `executeAgentTurn({mode})` | `packages/shared/src/engine/execute-agent-turn.ts` |
| `buildToolSurface({mode})` | `packages/shared/src/engine/tool-surface.ts` |
| `dispatchTool(mode, call, ctx)` | `packages/shared/src/engine/tool-dispatch.ts` |
| `evaluatePolicies({tenant, agent, tool, args})` | `packages/shared/src/engine/evaluate-policies.ts` |
| `evaluateRouting({...})` | `packages/shared/src/engine/evaluate-routing.ts` |
| `POST /api/router-rules/test` | `services/ai/src/routes/router-rules.ts` |
| `POST /api/ai-assist/:convId/proposed-tool-calls/:id/accept` | `services/ai/src/routes/proposed-tool-calls.ts` |
| `POST /api/ai-assist/:convId/proposed-tool-calls/:id/reject` | `services/ai/src/routes/proposed-tool-calls.ts` |
| `GET /api/ai-assist/:convId/proposed-tool-calls` | same file |
| Static tool `close_conversation` | `packages/shared/src/engine/static-tools/close-conversation.ts` |
| Static tool `interactive_reply` | `packages/shared/src/engine/static-tools/interactive-reply.ts` |

---

## Behavior changes (user-observable)

| Before | After |
|---|---|
| Enabling a tool in AI Studio → Integrations made it available to every agent tenant-wide. | Enabling tenant-wide is only step 1. Each agent also needs an `AgentToolPermission` row (edited in the agent's Skills panel). |
| Routing relied on numeric `priority` with ties broken implicitly. | Routing is list-ordered; admins drag-to-reorder. First match wins. Default rules always last. |
| Bot engine saw a hardcoded 2-tool list; copilot saw a different list. | Both modes see the same tool set filtered by `allowedModes`. |
| HITL lived in two places (TenantToolPermission + AgentToolPermission), plus a hardcoded high-risk list. | One evaluator. Strictest rule wins. No hidden lists. |
| Chatbot flows could do almost anything (API calls, conditional branching on arbitrary state, tool invocations). | Routines restricted to intake UX (`Start`, `Stop`, `Condition`, `Route To`, `Send Message`, `Quick Reply`). Main workflows can route to Agent or Sub. Subs can't route out. |
| Conversations routed to welcome flow always went through flow even if message was a clear sales intent. | With list-ordered routing, intent-based rules are placed above channel-catch-all rules. Welcome flow becomes a fallback, not a ceiling. |
| Suggestions computed on every inbound message (eager). | Suggestions computed only when an agent opens the conversation (lazy, 60s cache). |
| Bot couldn't close conversations. | Bot can call `close_conversation` after server verifies no pending approvals/proposals/followups. |
| Interactive WhatsApp buttons were generated by the flow engine. | Buttons are generated by the Agent via `interactive_reply`. Flow engine cannot produce interactive payloads. |
| Approvals were created only by the bot in AUTO mode. | Approvals staged as `ProposedToolCall` in ASSIST mode too — human must accept in UI. Server re-evaluates policy at accept time. |
| When a human unclaimed, conversation sat idle in WAITING. | Tenant opt-in `autoResumeAfterUnclaimMinutes`: bot resumes AUTO after N idle minutes (default OFF). |
| No prompt version history. | Every assemble snapshots to `ai_agent_prompt_versions`. Conversations reference the snapshot. |

---

## Frontend breaking changes

| Page | Change |
|---|---|
| AI Studio → "Copilot Settings" | **Removed.** Copilot config is now per-`AIAgent`. |
| AI Studio → Skills tab | Reads real `TenantIntegration`+`TenantTool` state (not mock). Tool toggles here are tenant-wide; per-agent allowlist is in the Agent editor. |
| AI Studio → Agent editor → Skills | Backed by `AgentToolPermission` (not tenant-wide tool enable). Fixed drawer-close bug. |
| Inbox → Assist side panel | Shows suggestions (lazy, cached 60s), summary, intelligence. Adds **Proposed Tool Calls** section with Accept/Reject buttons. |
| Inbox → Approval banner | Wired to `ApprovalRequest.policySnapshot` for details; role-gated (`approverRole`). |
| Settings → Router Rules | List view with drag-to-reorder (`position` column). No priority field. Adds "Test" panel that runs a sample message through the evaluator and shows the trace. |
| Settings → Flows (renamed to "Routines") | Save-time validation returns warnings (Phase 5) or errors (Phase 7+) on disallowed node types. Main vs Sub toggle added. |
| Settings → Tenant | New fields: Default Agent, Default Routine, Default Queue, Auto-Resume Minutes. |

---

## API stability statement

The **public API surface** for integrations and third parties is limited to:

- `GET/POST/PUT/DELETE /api/ai-agents*`
- `GET/POST/PUT/DELETE /api/integrations*`
- `GET /api/integrations/oauth/:provider/init`
- `GET /api/integrations/oauth/:provider/callback`
- `GET/POST/PATCH/DELETE /api/router-rules*`
- `GET/POST/PATCH/DELETE /api/routines*`

These are versioned via `schema_version` fields where applicable. Any field removal from a public endpoint is a breaking change and requires:
1. Field deprecation announcement 30+ days ahead.
2. Dual-read / dual-write phase.
3. Final removal in a new API major version.

Everything else in this document is internal and may change without notice between phases.

---

## Migration dry-run command

Before kicking off Phase 3 backfill on production, every tenant's migration is dry-runnable:

```bash
npm run migrate:dry-run -- --tenant <tenantId>
```

Outputs: expected AIAgent inserts, TenantTool override merges, Routine mirrors, AnchorConversions. No writes. CI runs this on every PR against a seeded fixture.
