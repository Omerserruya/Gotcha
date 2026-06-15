# GOTCHA - AI Security Architecture

> Phase 1 deliverable of the full AI security pass.
> Owner: Principal AI Security Architect. Audience: platform engineers, auditors, anyone wiring a new AI surface into the system.

This document maps every service, surface, trust boundary, and data flow that touches the AI layer. If you are about to add a new route, prompt block, RAG source, tool, or external integration, find the relevant boundary below first.

---

## 1. Services (deployed processes)

| Service              | Path                              | Port (default) | Role                                                                                         | Trust class        |
| -------------------- | --------------------------------- | -------------- | -------------------------------------------------------------------------------------------- | ------------------ |
| `ai`                 | `services/ai`                     | `4006`         | Prompt builder, agent runtime, tool executor, embedded chat, customer summary, action planner | Internal           |
| `conversation`       | `services/conversation`           | `3000`         | Conversations, messages, broadcasts, identity, approvals, voice sessions                     | Internal           |
| `incoming-worker`    | `services/incoming-worker`        | (worker)       | Drains `incomingMessageQueue` and routes inbound to bot / human                               | Internal           |
| `outgoing-worker`    | `services/outgoing-worker`        | (worker)       | Drains `outgoingMessageQueue` and dispatches to Meta / Twilio / webchat                       | Internal           |
| `voice-copilot`      | `services/voice-copilot`          | `4007`         | STT, voice session FSM, cue projector, post-call analysis                                    | Internal           |
| `webhook`            | `services/webhook`                | (varies)       | Meta Graph + Twilio + WebChat ingress                                                        | **Untrusted edge** |
| `chatbot`            | `services/chatbot`                | (varies)       | Deterministic chatbot flow runner                                                            | Internal           |
| `auth`               | `services/auth`                   | (varies)       | Login, signup, JWT issuance, refresh tokens, OAuth start                                     | **Auth edge**      |
| `notifications`      | `services/notifications`          | (varies)       | Email + system-event fan-out                                                                 | Internal           |
| `analytics`          | `services/analytics`              | (varies)       | Read models for dashboards                                                                   | Internal           |
| `frontend`           | `frontend/`                       | `3001`         | Next.js - operator console, embedded chat widget                                             | **Browser edge**   |
| `nginx`              | `nginx/`                          | `80/443`       | TLS termination, routing, SSE buffering control                                              | **Gateway**        |

All Node services share a workspace package `@chatcenter/shared` (`packages/shared/`) which owns:

* **Prisma client + schema** (`packages/shared/prisma/schema.prisma`)
* **Auth middleware** (`packages/shared/src/middleware/auth.ts`) - JWT verify + `INTERNAL_SERVICE_KEY` / `INTERNAL_SERVICE_TOKEN` shared-secret accept for service-to-service calls
* **Tenant middleware** (`packages/shared/src/middleware/tenant.ts`) - `resolveTenant`, `assertTenantId`. JWT tenant claim is **authoritative** for non-admins; `x-tenant-id` header is **ignored** for non-admins (good).
* **Agent tools, tool gate, policy engine, identity resolver, encryption** (`packages/shared/src/lib/*`)

---

## 2. Data stores

| Store          | What it holds                                                                                                                    | Tenant scoping mechanism                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Postgres + Prisma | Tenants, users, conversations, messages, contacts, leads, CRM secrets, voice calls, audit logs, approvals, scheduled messages, action contracts, policies | Every row has `tenantId`. **Prisma queries are responsible for adding `tenantId` to every `where` clause.** No DB-level row security. |
| Qdrant         | KB document chunks + vectors                                                                                                     | Single collection (`kb_chunks`) with a `tenantId` payload field + payload index. Search filters by `tenantId` (verified).   |
| Redis (BullMQ) | `incomingMessageQueue`, `outgoingMessageQueue`, scheduled jobs, presence, redaction state                                       | Job payloads carry `tenantId`. No per-tenant queue isolation - collisions impossible because job IDs are unique.            |
| OpenAI         | Sent on every LLM/embedding call. Account-level data isolation only.                                                             | `metadata.tenantId` set on calls + `user` field pinned to `sessionId` for prefix caching.                                   |
| Filesystem     | Prompt markdown (`services/ai/src/prompts/*.md`), uploaded KB files                                                              | Prompts are global. Uploaded KB files are scoped via `tenantId` in the upload path / DB row.                                 |

---

## 3. AI surfaces (where prompts and tool calls originate)

```
┌───────────────────────────────────────────────────────────────────────┐
│  1. AUTONOMOUS BOT (ai-bot.service.ts)                                │
│     Trigger: inbound message → incoming-worker → /api/ai-bot/respond  │
│     Owner: services/ai/src/services/ai-bot.service.ts                 │
│     Prompts: prompt-builder.service.ts (BLOCK 1/2/3) + guardrails.md  │
│     Tools: buildAgentToolsForAIAgent + custom api + custom db +       │
│            adapter framework + tenant tool permissions                │
│     LLM driver: ai.service.ts → openai.provider.ts                    │
│     Auth: internal (incoming-worker → ai over service mesh)            │
├───────────────────────────────────────────────────────────────────────┤
│  2. SYSTEM COPILOT (/api/agent/run)                                   │
│     Trigger: operator chat in the console                             │
│     Owner: services/ai/src/services/agent-runtime.service.ts          │
│     Prompts: prompts/system-copilot.md + per-operator context         │
│     Tools: system tools (search conversations, generate flows, etc.)  │
│     Auth: JWT (operator) → tenant scoped                              │
├───────────────────────────────────────────────────────────────────────┤
│  3. VOICE COPILOT (services/voice-copilot)                            │
│     Trigger: live call audio → STT → cue projector + suggestions      │
│     Prompts: intelligence/prompts/blocks/* + copilot-config-block     │
│     Tools: read-only (cue surfacing is non-mutating)                  │
│     Auth: JWT (operator) for UI; internal service token for Twilio    │
├───────────────────────────────────────────────────────────────────────┤
│  4. EMBEDDED CHAT WIDGET (/api/embedded-chat/*) - ★ NO-AUTH SURFACE ★ │
│     Trigger: anonymous visitor on tenant's site                       │
│     Owner: services/ai/src/routes/embedded-chat.ts                    │
│     Flow: /init → /message → incomingMessageQueue → ai-bot            │
│     Auth: NONE. Lookup is by widgetId (public) which derives tenantId │
│     Concern: rate-limit, abuse, cost cap, tenant-binding token        │
├───────────────────────────────────────────────────────────────────────┤
│  5. AI ASSIST (/api/ai-assist) - copilot for human agent inbox        │
│     Modes: context-only, draft reply, summarize, chat                 │
│     Owner: services/ai/src/services/ai-assist.service.ts              │
│     Auth: JWT (operator)                                              │
├───────────────────────────────────────────────────────────────────────┤
│  6. AGENT CONFIG GENERATOR                                            │
│     Trigger: operator builds an AI agent in the studio                │
│     Owner: services/ai/src/services/agent-config-generator.ts         │
│     Prompts: prompt-builder's generator mode                          │
│     Auth: JWT (operator with ADMIN)                                   │
├───────────────────────────────────────────────────────────────────────┤
│  7. ACTION PLANNER (/api/action-planner)                              │
│     Trigger: scheduled / on-demand summarisation → planned actions    │
│     Owner: services/ai/src/services/action-executor.service.ts +      │
│            routes/action-planner.ts                                   │
│     Auth: JWT (operator)                                              │
├───────────────────────────────────────────────────────────────────────┤
│  8. POST-CHAT PIPELINE                                                │
│     Trigger: conversation close / cron                                │
│     Owner: services/ai/src/services/post-chat-pipeline.service.ts +   │
│            post-conversation-summarizer.service.ts                    │
│     Tools: CRM merge (sparse patches per memory rules)                │
└───────────────────────────────────────────────────────────────────────┘
```

Each surface composes the **same prompt-builder.service.ts** but with different `mode` (`agent` / `copilot` / `generator`) and different `ContextSlot` blocks. The builder renders three blocks in order:

1. **BLOCK 1** - per-agent (Identity + Guardrails + agent playbooks)  ← `guardrails.md` is loaded here at module init
2. **BLOCK 2** - per-conversation (Customer info + CRM snapshot + memory + templates + locale skill)
3. **BLOCK 3** - per-turn (Conversation State + Pipeline stage + Knowledge slice + Execution Contract + Tools Policy)

The model `user` field is pinned to `sessionId = conversationId` so OpenAI's prefix cache reuses BLOCK 1+2.

---

## 4. Trust boundaries

```
   ╔══════════════════ UNTRUSTED EDGE ══════════════════╗
   ║                                                    ║
   ║   ┌────────────────┐         ┌──────────────────┐  ║
   ║   │ Meta Graph API │         │ Embedded chat    │  ║
   ║   │  (WA / IG / FB)│         │  (anonymous web) │  ║
   ║   └────────┬───────┘         └────────┬─────────┘  ║
   ║            │ HMAC-signed              │ public POST║
   ║            ▼                          ▼            ║
   ║   ┌────────────────────────────────────────────┐   ║
   ║   │ webhook service / embedded-chat routes     │   ║  ← signature verify (Meta)
   ║   │   • normalises payload                     │   ║     no auth gate (widget)
   ║   │   • enqueues incomingMessageQueue          │   ║
   ║   └─────────────────┬──────────────────────────┘   ║
   ╚═════════════════════│══════════════════════════════╝
                         ▼
   ╔══════════════════ INTERNAL MESH ════════════════════╗
   ║                                                     ║
   ║   incoming-worker  ──► ai-bot.service.ts            ║
   ║       │                  │                          ║
   ║       │                  ├─► prompt-builder         ║
   ║       │                  │     + guardrails.md      ║
   ║       │                  │     + RAG (Qdrant)       ║
   ║       │                  │     + CRM (Zoho/HubSpot) ║◄── ★ untrusted CRM data
   ║       │                  │                          ║     enters prompt verbatim
   ║       │                  ▼                          ║
   ║       │                OpenAI ────────►◄────────    ║◄── external boundary
   ║       │                  │                          ║
   ║       │                  ▼                          ║
   ║       │             tool-execution → orchestrator ──► policy gate
   ║       │                  │                            │
   ║       │                  ▼                            ▼
   ║       │             approvals (HITL) ─────── audit log
   ║       │                                              │
   ║       ▼                                              ▼
   ║   outgoing-worker ──► Meta / Twilio / webchat   Postgres
   ╚════════════════════════════════════════════════════════════╝

   Auth: JWT (browser) | INTERNAL_SERVICE_KEY (service mesh) | nothing (widget)
   Tenancy: req.tenantId from JWT (authoritative) | req.headers["x-tenant-id"] (admin only)
```

Trust classes:

* **Untrusted edge** - Meta webhooks, embedded chat. Must validate HMAC (Meta) or apply rate limit + tenant binding (widget).
* **Auth edge** - `/api/auth/*`. Login, refresh, OAuth callbacks. Already rate-limited.
* **Browser edge** - operator console. Authenticated via JWT issued by `auth` service.
* **Internal mesh** - service-to-service over the Docker network. Authenticated via `Authorization: Bearer ${INTERNAL_SERVICE_KEY}` with `x-tenant-id` header. **The shared secret IS the security boundary; if it leaks the entire system is compromised.**
* **External boundary** - OpenAI, Zoho/HubSpot, Twilio, Meta, Google, Calendly. We send tenant data outbound; provider terms control retention.

---

## 5. Attack surface inventory

### 5.1 Untrusted text channels (every one becomes part of an LLM prompt)

| Source                           | Where it lands in the prompt                                | Adversary control       |
| -------------------------------- | ----------------------------------------------------------- | ----------------------- |
| Customer messages (chat history) | `chatMessages` (chat history, role=user)                    | Full text               |
| Customer messages (memory facts) | Memory block (Block 2) - derived from transcript            | Full text               |
| CRM lead/contact name            | `Existing CRM Records` block (Block 2)                      | Whoever can write CRM   |
| CRM description                  | `Existing CRM Records` block (Block 2)                      | Whoever can write CRM   |
| CRM notes (title + content)      | `recent notes` block (Block 2)                              | Whoever can write CRM   |
| KB document chunks               | Knowledge block (Block 3)                                   | Tenant operator (upload) |
| Confluence / Google Drive sync   | Knowledge block (Block 3)                                   | Whoever can edit upstream |
| Custom-api tool descriptions     | Tool descriptions in `tools` array sent to OpenAI           | Tenant admin            |
| Stage `goal` / `requiredQuestions` | Pipeline Stage block (Block 3)                              | Tenant admin            |
| WhatsApp template names          | Templates block (Block 2)                                   | Meta-approved templates  |
| Operator messages (system copilot) | system-copilot's user role                                  | Tenant operator         |
| Visitor name / pageUrl (widget)  | conversation.customerName (Block 2)                         | Anonymous internet      |

### 5.2 Tool surface (auditable mutating actions)

* CRM writes: `update_lead`, `update_contact`, `add_lead_note`, `add_lead_tag`, `add_contact_note`, `add_contact_tag`, `create_lead`, `create_contact`
* Messaging: `schedule_followup`, `schedule_followup_template`, `send_message` (executor only)
* Booking: `schedule_meeting`, `book_*`
* Identity: `link_customer_identifier`, `merge_contacts`, `resolve_identity`
* Conversation lifecycle: `close_conversation`, `escalate_to_human`
* Custom: `custom.<slug>` (tenant-defined HTTP POST), `custom_db.<slug>` (tenant-defined SQL/Mongo)
* Database adapters (when tenant integration CONNECTED): `postgres_*`, `mongodb_*`, `aws_rds_*`
* Broadcast / workflow: `create_broadcast`, `schedule_broadcast`, `preview_broadcast`, `create_workflow`, `list_workflows`

Every tool routes through `dispatchToolCall` → `ActionOrchestrator.submit` → `policy gate` + `evaluateToolGate(tenantId, toolName)` (`TenantToolPermission`). Approval-required tools synthesise an `awaitingApproval` side-effect.

### 5.3 Network ingress

* `nginx` → `frontend` (Next.js) - static + RSC + SSE proxy
* `nginx` → `auth` (`/api/auth/*`)
* `nginx` → `conversation` (`/api/*`)
* `nginx` → `ai` (`/api/agent/run` with `proxy_buffering off`, `/api/embedded-chat/*`, `/api/ai-bot`, etc.)
* `nginx` → `webhook` (`/webhooks/meta`, `/webhooks/twilio`, `/webhooks/widget`)

### 5.4 Outbound network egress (LLM + integrations)

* `openai.com` - every LLM + embedding call
* `*.zoho.com` - CRM
* `graph.facebook.com` - Meta WhatsApp / IG / Messenger
* `*.googleapis.com` - Drive + Calendar
* `api.calendly.com`
* `*.twilio.com`

---

## 6. Authentication & authorization summary

* **JWT issuance** (`services/auth`) - payload `{ userId, tenantId, role, email, departmentId?, departmentRole? }`. HS256 signed with `JWT_SECRET` (env). Default secret literal `"change-me"` if env missing - flagged in findings.
* **JWT verify** (`packages/shared/src/middleware/auth.ts`) - `verifyToken` checks signature + expiry, then a lightweight `User.isActive` DB hop. **Fail-open** on DB error (intentional, but noted).
* **Internal service auth** - `INTERNAL_SERVICE_KEY` or `INTERNAL_SERVICE_TOKEN` shared secret, sent as `Authorization: Bearer …` with `x-tenant-id`. Either env value is accepted by the gate; both must be treated as production secrets.
* **Tenant resolution** - JWT tenant for non-admins (authoritative); explicit override allowed only for `SYSTEM_ADMIN`. Path / header / JWT in that order. Missing tenant → 400.
* **RBAC** - `requireRole("ADMIN")`, `requireRole("SYSTEM_ADMIN")` middlewares. Department role on per-route basis.
* **Tool ABAC** - `TenantToolPermission` per tenant-per-tool with decision = ALLOW | REQUIRE_APPROVAL | DENY. Falls back to internal `HIGH_RISK_DEFAULTS`.
* **Policy gate** - `validateAgainstPolicy(policy, { tool, params })` - tenant-configurable allowlist / denylist of (tool, params).
* **Action contracts** - sequence + at-least-one tool gates per trigger (replay-safe progress).

---

## 7. Audit + logging surfaces

* `AuditLog` table - every tool call, every action, every behavior-state turn (`ai.bot_turn`), every approval decision.
* `UsageLog` - token spend per call.
* `console.*` - currently noisy + unredacted. **Findings doc lists every line that may leak a token, JWT, or PII.**

---

## 8. ASCII data-flow diagram (end-to-end inbound message)

```
visitor (browser)       ── HTTPS ──►  nginx ──► ai-service /api/embedded-chat/message
                                                │
                                                ▼
                                       BullMQ: incomingMessageQueue
                                                │
                                                ▼
                                       incoming-worker
                                          (route → bot / human)
                                                │
                                                ▼
                                       ai-service /api/ai-bot/respond
                                          │
                                          ▼
                                 ai-bot.service.ts:
                                    - load conversation + history
                                    - prefetch CRM        ◄── Zoho / HubSpot (egress)
                                    - load memory + funnel + contracts
                                    - compute BehaviorState
                                    - build prompt (BLOCK 1/2/3 + guardrails.md)
                                    - assemble tools (built-in + custom + adapter)
                                    - generateResponse() ──► OpenAI (egress)
                                    │
                                    ▼  tool-calls?
                                  ActionOrchestrator.submit:
                                     - policy gate
                                     - TenantToolPermission gate
                                     - dispatchToolCall ──► CRM / messaging connectors
                                     - audit row written
                                     - approval path (HITL)
                                    │
                                    ▼ assistant text
                                 outgoingMessageQueue
                                    │
                                    ▼
                                 outgoing-worker ──► Meta Graph / Twilio / webchat
```

---

## 9. Where new code MUST plug in for safety

| Concern                                            | Hook point                                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Wrap untrusted text in `<untrusted>` delimiters   | `services/ai/src/services/prompt-sanitizer.service.ts` (new) called from `prompt-builder.service.ts` Block 2 |
| Per-turn / per-conversation cost cap               | `services/ai/src/services/cost-budget.service.ts` (new) called by `ai-bot.service.ts` before each `generateResponse` and on the tool-call loop counter |
| Strip system-prompt fragments from assistant output | `services/ai/src/services/output-validator.service.ts` (new) called after `replyText` is finalised        |
| Embedded-chat rate limit + abuse                   | `services/ai/src/routes/embedded-chat.ts` (new middleware)                                                  |
| Log redaction                                      | `packages/shared/src/lib/log-redact.ts` (new) - masks JWTs, Bearer tokens, phones, emails                   |
| Tenant filter audit                                | Findings doc enumerates every unsafe `prisma.*` site; patches the top 10                                    |

These are the new modules Phase 4 will create.

---

End of architecture map.
