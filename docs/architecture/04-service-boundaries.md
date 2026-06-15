# 04 - Service Boundaries

The convergence does **not** fork services. Keep the existing container topology; change the internal contracts.

Copilot is a **mode**, not a service. "Voice Co-Pilot" is out of scope for this rename and stays as-is.

---

## 1. Service inventory (after convergence)

| Service | Role | Owns |
|---|---|---|
| `ai` | AI engine, prompt assembly, tool execution, integrations catalog, HITL evaluator, proposed-tool-call endpoints | `AIAgent`, `CatalogTool`, `TenantTool`, `TenantIntegration`, `AgentToolPermission`, `AIAgentPromptVersion`, `AgentTurnLog`, `ApprovalRequest`, `ProposedToolCall`, `ToolExecution` |
| `incoming-worker` | Inbound message consumer; calls AI engine in AUTO mode | Queue consumers; no domain tables |
| `conversation` | Inbox, messages, contacts, identity, broadcasts, approvals UI | `Conversation`, `Message`, `Contact`, `Department`, `ChannelAccount` (some), `RouterRule` |
| `auth` | Users, tenants, channel OAuth, sessions | `User`, `Tenant`, `ChannelAccount`, `Session` |
| `webhook` | Inbound webhook ingestion (Meta, Gmail push, Slack) | - (writes to queues) |
| `outgoing-worker` | Outbound message dispatch, scheduled broadcasts/followups | `ScheduledFollowup`, `BroadcastDelivery` |
| `analytics` | Event aggregation, usage reports | `AnalyticsEvent`, `AIUsage` |
| `voice-copilot` | Twilio media streams + STT. Unrelated to "Co-Pilot" rename. | `VoiceSession`, `VoiceTranscript` |
| `frontend` | Next.js UI for Inbox, AI Studio, Integrations, Settings | - |
| `gateway` | Nginx reverse-proxy, tenant subdomain routing | - |

---

## 2. Logical layers inside `ai` service

The `ai` service contains the new engine primitives. All other services call into it via HTTP - no direct DB writes to agent/tool tables.

```
services/ai/
├── src/
│   ├── engine/                       ← NEW - single source of execution logic
│   │   ├── execute-agent-turn.ts     executeAgentTurn({mode})
│   │   ├── tool-surface.ts           buildToolSurface()
│   │   ├── tool-dispatch.ts          dispatchTool()
│   │   ├── evaluate-policies.ts      evaluatePolicies()
│   │   ├── evaluate-routing.ts       evaluateRouting()
│   │   ├── build-context.ts          message history + RAG + intakeFacts
│   │   └── static-tools/
│   │       ├── escalate-to-human.ts
│   │       ├── link-customer-identifier.ts
│   │       ├── close-conversation.ts
│   │       ├── interactive-reply.ts
│   │       └── send-message.ts
│   ├── services/
│   │   ├── prompt-assembler.service.ts   (renders behavioralAnchors + escalationGates)
│   │   ├── tool-execution.service.ts     (integration HTTP executor, OAuth refresh)
│   │   └── approvals.service.ts          (ApprovalRequest CRUD)
│   ├── routes/
│   │   ├── ai-agents.ts
│   │   ├── integrations.ts
│   │   ├── crm-oauth.ts
│   │   ├── router-rules.ts               (with /test endpoint)
│   │   ├── routines.ts                   (CRUD + save-time lint/enforce)
│   │   ├── proposed-tool-calls.ts        (NEW)
│   │   ├── agent-turn.ts                 (NEW - internal endpoint, see §3)
│   │   └── ai-assist.ts                  (copilot HTTP surface - now a thin wrapper)
```

The `engine/` directory is promoted to `packages/shared/src/engine/` in Phase 1 so `incoming-worker` can import it directly without HTTP.

---

## 3. Interaction diagram

Ascii, authoritative shape. Arrows point in direction of call.

```
                    ┌───────────────────────┐
 WhatsApp/Gmail/etc ▶ webhook (service)     │
                    └─────────┬─────────────┘
                              │ enqueues
                              ▼
                    ┌─────────────────────────────────────┐
                    │ incoming-worker (queue consumer)    │
                    │ - resolves conversation             │
                    │ - calls evaluateRouting()           │◀──┐
                    │ - if AUTO: executeAgentTurn()       │   │ (both imported from
                    │ - if ROUTINE: runRoutineStep()      │   │  packages/shared/src/engine)
                    │ - if HUMAN: mark WAITING            │   │
                    └──────────┬──────────────────────────┘   │
                               │                              │
                               │ DB writes (Conversation,     │
                               │ Message, AgentTurnLog)       │
                               ▼                              │
                         ┌──────────┐                         │
                         │ Postgres │                         │
                         └──────────┘                         │
                                                              │
                    ┌────────────────────────────────────┐    │
                    │ frontend (Next.js)                 │    │
                    │  Inbox: opens conversation         │    │
                    │    ├─► GET /api/ai-assist/:id/     │    │
                    │    │        suggestions  ─────────►│    │
                    │    │                               │    │
                    │    ├─► GET proposed-tool-calls     │    │
                    │    └─► POST /accept|/reject        │    │
                    └─────────────┬──────────────────────┘    │
                                  │                            │
                                  ▼                            │
                    ┌────────────────────────────────────┐     │
                    │ ai (service)                       │     │
                    │  /api/ai-assist/:id/suggestions    │     │
                    │    = executeAgentTurn({mode:ASSIST})◀────┘
                    │    (lazy, cached 60s per conv)     │
                    │                                    │
                    │  /api/proposed-tool-calls/:id/     │
                    │     accept                         │
                    │    = re-evaluatePolicies()         │
                    │    = executeResolvedTool()         │
                    │                                    │
                    │  /api/router-rules (CRUD + /test)  │
                    │  /api/routines (CRUD + save lint)  │
                    │  /api/integrations/...             │
                    │  /api/ai-agents                    │
                    └──────┬──────────────────┬──────────┘
                           │                  │
                           ▼                  ▼
                    ┌──────────┐        ┌──────────────┐
                    │ Postgres │        │ OpenAI/Qdrant│
                    └──────────┘        └──────────────┘
```

### Cross-service calls

| From | To | Purpose | Auth |
|---|---|---|---|
| `incoming-worker` | `packages/shared/src/engine/*` (in-process) | `executeAgentTurn`, `evaluateRouting` | in-process |
| `frontend` | `ai` | Suggestions, proposed-tool accept/reject, agent CRUD | user JWT |
| `frontend` | `conversation` | Inbox, messages, claim/close | user JWT |
| `ai` | `conversation` | `send_message` outbound, identity linking | internal bearer + `x-tenant-id` |
| `ai` | external APIs (Zoho/HubSpot/etc.) | Integration tool dispatch | per-integration credentials |
| `ai` | OpenAI | LLM completions | `OPENAI_API_KEY` |
| `ai` | Qdrant | RAG search | `QDRANT_API_KEY` |
| `webhook` | `incoming-worker` queue | inbound enqueue | in-cluster |
| `outgoing-worker` | external APIs | send outbound messages | channel credentials |

---

## 4. Data ownership

Every table has exactly one owning service. Other services read via HTTP or via `@chatcenter/shared` types (but read-only Prisma access is tolerated for performance-critical paths - `TenantGuard` enforces isolation).

| Table | Owner |
|---|---|
| `ai_agents`, `ai_agent_prompt_versions` | ai |
| `catalog_tools`, `tenant_tools`, `tenant_integrations`, `agent_tool_permissions` | ai |
| `agent_turn_logs`, `tool_executions` | ai |
| `approval_requests`, `proposed_tool_calls` | ai |
| `router_rules`, `routines` | ai |
| `conversations`, `messages`, `contacts` | conversation |
| `users`, `tenants`, `channel_accounts`, `sessions` | auth |
| `departments`, `router_rules` (reads) | conversation (reads) |
| `scheduled_followups`, `broadcasts`, `broadcast_deliveries` | outgoing-worker |
| `ai_usage`, `analytics_events` | analytics |
| `knowledge_bases`, `knowledge_documents`, `knowledge_chunks` | ai |

---

## 5. HTTP contracts (stable)

These are the only endpoints the frontend and workers depend on. Anything else is implementation detail.

### `ai` service

```
# Agent CRUD
GET    /api/ai-agents
GET    /api/ai-agents/:id
POST   /api/ai-agents
PATCH  /api/ai-agents/:id
DELETE /api/ai-agents/:id

# Assist mode - lazy per conversation
GET    /api/ai-assist/:conversationId/suggestions?locale=...
GET    /api/ai-assist/:conversationId/summary?locale=...
GET    /api/ai-assist/:conversationId/intelligence
GET    /api/ai-assist/:conversationId/proposed-tool-calls?status=PENDING
POST   /api/ai-assist/:conversationId/proposed-tool-calls/:id/accept
POST   /api/ai-assist/:conversationId/proposed-tool-calls/:id/reject

# Integration catalog
GET    /api/integrations
GET    /api/integrations/:slug
POST   /api/integrations/:slug/connect
POST   /api/integrations/:slug/test
POST   /api/integrations/:slug/disconnect
PUT    /api/integrations/:slug/credentials
GET    /api/integrations/:slug/tools
PUT    /api/integrations/:slug/tools/:toolSlug     (tenant-level enable/disable)

# OAuth (public callbacks via JWT state)
GET    /api/integrations/oauth/zoho_crm/init       (admin)
GET    /api/integrations/oauth/zoho_crm/callback   (public - state-verified)

# Routing
GET    /api/router-rules
POST   /api/router-rules
PATCH  /api/router-rules/:id
DELETE /api/router-rules/:id
POST   /api/router-rules/:id/move                  (set position)
POST   /api/router-rules/test                      (dry-run with trace)

# Routines
GET    /api/routines?type=MAIN|SUB
POST   /api/routines                               (save-time lint/enforce)
PATCH  /api/routines/:id
DELETE /api/routines/:id

# Internal only
POST   /api/ai-assist/:conversationId/tools/execute (deprecated after Phase 8)
```

### `conversation` service

Unchanged. `ai` calls `POST /api/conversations/:id/messages` internally when dispatching `send_message` / `interactive_reply`.

---

## 6. Queues

| Queue | Producer | Consumer | Purpose |
|---|---|---|---|
| `incoming-messages` | webhook | incoming-worker | Inbound message processing → executeAgentTurn |
| `outgoing-messages` | ai, conversation | outgoing-worker | Dispatch outbound |
| `scheduled-messages` | conversation | outgoing-worker | Scheduled broadcasts/followups |
| `analytics-aggregation` | all services | analytics | Events |
| `idle-conversations` | scheduler | incoming-worker | Idle-check + reminders |

No new queues for this convergence.

---

## 7. Configuration surfaces

### Env vars added

```
ARCHITECTURE_PHASE=0|1|2|3|4|5|6|7|8
ARCHITECTURE_READ_NEW=true|false          # flipped per-tenant via Redis set
```

### Redis keys

```
arch:read-new:tenants                     # SET of tenantIds allowed on new readers
arch:intent-cache:<sha256(message)>       # TTL 5min, stores resolved intent hits
arch:suggestion-cache:<convId>:<lang>     # TTL 60s, stores assist-mode suggestions
arch:circuit-breaker:<tenantId>:<slug>    # counter + open/closed state per integration
```

---

## 8. Observability

Single canonical metrics namespace: `gotcha.ai.*`

| Metric | Type | Labels |
|---|---|---|
| `ai.turn.duration_ms` | histogram | tenant, agent, mode, outcome |
| `ai.turn.tokens` | counter | tenant, agent, mode |
| `ai.tool.executions` | counter | tenant, tool, decision, ok |
| `ai.tool.latency_ms` | histogram | tenant, tool |
| `ai.policy.decisions` | counter | tenant, tool, decision |
| `ai.routing.matches` | counter | tenant, rule_id |
| `ai.routing.fallbacks` | counter | tenant, reason |
| `ai.routine.runs` | counter | tenant, routine, flow_type |
| `ai.approval.created` | counter | tenant, tool |
| `ai.approval.decided` | counter | tenant, tool, decision, decider_role |
| `ai.proposed.accepted` | counter | tenant, tool |

Traces via OpenTelemetry on every `executeAgentTurn`. Span name: `agent.turn`. Attributes mirror the `AgentTurnLog` row.

---

## 9. Failure domains

Degraded-mode behavior:

| Outage | Behavior |
|---|---|
| OpenAI down | `executeAgentTurn` → `{kind: "escalated", reason: "llm_unavailable"}`. Conversation → PAUSED. |
| Qdrant down | RAG retrieval skipped; turn still runs with just message history. |
| A single integration API down | Per-tenant circuit breaker opens; tool returns structured error; LLM reasons around it. Other integrations unaffected. |
| Postgres primary down | All writes blocked. Read-only degradation mode: suggestions can still render from cache. |
| Redis down | Caches cold; HITL evaluation + routing still work (read from DB each time). Higher LLM cost transiently. |

No outage should cascade across tenants. All per-tenant quotas + circuit breakers.

---

## 10. What this does NOT touch

- `services/voice-copilot` - its "Co-Pilot" naming stays. Rename is a separate PR per §10 of the spec lock.
- Billing service / usage export - unchanged.
- Gateway nginx config - unchanged except possibly a new location block for `/api/ai-assist/:id/proposed-tool-calls` (covered by existing `/api/ai-assist` location).
- Meta/Gmail webhook subscription setup - unchanged.
