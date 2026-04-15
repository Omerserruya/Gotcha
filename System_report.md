# GOTCHA / ChatCenter — System Reality Report

**Method:** bottom-up discovery. Only code that exists on disk is reported.
PRD.md was not used as source of truth — it's referenced only at the end for gap framing.

**Audit date:** 2026-04-13
**Audited tree:** `/home/ocs/projects/ChatCenter`

---

## 0. Executive Answer

> **What does this system ACTUALLY do today?**

GOTCHA is a **multi-tenant omnichannel messaging platform** (WhatsApp, Messenger, Instagram, Gmail, Outlook, Slack, Webchat) with a **human-agent inbox**, a **visual chatbot/flow builder**, a **RAG knowledge base**, and a **recently-bolted-on AI action layer** (planner + executor + command palette).

The messaging, inbox, routing, broadcasts, knowledge base, and auth/tenant plumbing are **real and production-grade**. The AI "execution OS" framing is **partially real**: the planner, classifier, executor, policy gate and audit log all exist and run end-to-end, but several of the advertised capabilities (CRM writes, broadcast creation, identity merge, follow-up scheduling) are **stubs that return `{queued: true}` without performing the action**, because the concrete `CrmConnector` / `MessagingConnector` implementations are never registered in the AI service.

Verdict: **~70% of the marketed AI execution surface is real. ~30% is plumbing without a payload.**

---

## 1. Discovered Capabilities

### 1.1 Backend services (6)

| Service | Port | Reality |
|---|---|---|
| `auth` | 4001 | Users, tenants, departments, channels, onboarding, SLA, system-admin |
| `conversation` | 4002 | Conversations, messages, contacts, broadcasts, scheduled messages, templates, identity routes, Socket.IO |
| `webhook` | 4003 | Unified inbound webhook for WhatsApp / Messenger / Instagram / Gmail / Outlook / Slack |
| `analytics` | 4004 | Dashboard/agent/hourly/daily/queue stats |
| `chatbot` | 4005 | CRUD for `ChatbotFlow` (the React Flow definitions) |
| `ai` | 4006 | Action planner, executor, copilot, knowledge base, RAG, system chat, router rules, integrations, tools, agents, policy, usage |

### 1.2 Background workers

| Queue | Where | Real logic? |
|---|---|---|
| `incoming-messages` | `services/incoming-worker` | ✅ routes inbound messages → conversation → AI classification |
| `outgoing-messages` | `services/outgoing-worker` | ✅ channel adapter dispatch, status updates |
| `scheduled-messages` | `outgoing-worker/scheduled.worker.ts` | ✅ checks due messages, queues, respects opt-out |
| `broadcast-messages` | `outgoing-worker/broadcast.worker.ts` | ✅ per-recipient dispatch, delivery tracking |
| `analytics-aggregation` | `services/analytics` | ✅ Redis counters |
| `channel-health` | `incoming-worker` | ✅ Meta token validation/refresh |
| `idle-conversations` | `incoming-worker/idle-conversation.worker.ts` | ✅ stale reminders + auto-close |

### 1.3 Prisma models in use (43)

Tenant, User, ChannelAccount, TenantChannelConfig, Department, DepartmentMember, Conversation, Message, Contact, AIAgent, AIAgentKnowledge, RouterRule, ChatbotFlow, BusinessProfile, TenantOnboarding, KnowledgeBase, KnowledgeDocument, KnowledgeChunk, KnowledgeIntegration, MessageTemplate, Broadcast, BroadcastRecipient, ScheduledMessage, TokenLog, UsageLog, CreditTransaction, AuditLog, ConversationIntelligence, AgentScore, ToolExecution, AgentToolPermission, TenantIntegration, TenantTool, IntegrationCatalog, CatalogTool, MagicLink, RefreshToken, WaitlistEntry, NotificationLog, FlowCanvas.

### 1.4 External integrations actually wired

- **OpenAI** (`gpt-4o-mini`, `text-embedding-3-small`) — `services/ai/src/services/ai.service.ts` (central gateway, token-logged, audit-logged)
- **Qdrant** — `services/ai/src/services/qdrant.service.ts` (RAG embeddings)
- **Meta Cloud API** (WhatsApp / Messenger / Instagram) — incoming + channel-health workers
- **Gmail / Outlook** — via webhook adapters + `knowledge-oauth` for Drive sync
- **Google Drive / Confluence OAuth** — `routes/knowledge-oauth.ts` for KB ingestion
- **Slack** — webhook adapter
- **PostgreSQL** via Prisma; **Redis** via BullMQ + ioredis; **Socket.IO** for realtime
- **Nodemailer** — password resets, magic links, notifications

No Anthropic SDK, no Twilio, no Salesforce/HubSpot SDK in code. CRM "integrations" are currently only the DB-backed `IntegrationCatalog`/`TenantIntegration` metadata tables + generic `tool-execution.service.ts` HTTP dispatcher — no vendor-specific client code.

### 1.5 Frontend (Next.js app router)

**Pages (~40):** `/`, `/login`, `/conversations`, `/history`, `/dashboard`, `/analytics`, `/outbound/{templates,broadcasts,scheduled}`, `/departments`, `/departments/[id]/copilot`, `/ai-studio`, `/ai-studio/agents/[id]`, `/ai-studio/flows/[id]`, `/ai-studio/knowledge`, `/ai-studio/router`, `/ai-studio/marketplace/[slug]`, `/agents`, `/channels`, `/integrations`, `/integrations/[slug]`, `/bot`, `/copilot`, `/knowledge`, `/usage`, `/settings`, `/setup`, `/setup/verify`, `/early-access`, `/system/*` (tenants, chat, leads, onboarding, token-usage, usage), `/privacy-policy`, `/terms`, `/en`, `/he`.

**Major component clusters:**
- **CommandCenter/** — global Ctrl+K palette (portal modal, provider, trigger pill) — real, recently upgraded with dual-mode + animated glow
- **conversations/** — full inbox UI (list, chat panel, copilot panel, history panel, replay, claim/release/reassign)
- **chatbot/** — React Flow visual editor with start/message/quickReply/condition/handover/departmentRoute/end nodes
- **mainPlaybook/** — separate visual routing playbook
- **routing/** — router-rules nodes
- **Root** — AppLayout, Sidebar, MobileNav, I18nProvider, AuthProvider
- **AI surfaces** — `ApprovalQueue.tsx`, `AICommandBar.tsx`, `AIInsightsPanel.tsx`, `CustomerTimeline.tsx`, `PolicyAdmin.tsx` exist as components but wiring into the app layout is spotty (see §4).

**API clients:** `lib/api.ts` (80+ endpoints), `lib/gotcha-api.ts` (identity, action-planner, ai-assist, policy), `lib/socket.ts` (realtime).

### 1.6 AI execution surface

**Two tool registries coexist:**

1. **Static TS registry** — `services/ai/src/services/tool-registry.ts` — 14 tools across messaging/crm/broadcast/workflow/identity/meta. Used by the **action-planner LLM system prompt**.
2. **DB-backed dynamic catalog** — `IntegrationCatalog` × `CatalogTool` × `TenantTool` × `AgentToolPermission`. Served by `routes/tools.ts` and executed by `services/tool-execution.service.ts` (generic HTTP dispatch for INTERNAL_API/CRM/ECOMMERCE/KNOWLEDGE_BASE/CUSTOM types).

These **are not unified** — the action-planner doesn't see the DB catalog, and the dynamic catalog isn't exposed via the command center. Two parallel AI execution surfaces.

**LLM decision points** (all `gpt-4o-mini`):
- `POST /api/action-planner/plan` — prompt → `ExecutionPlan` JSON
- `POST /api/action-planner/classify` — chat vs execution mode (newly added)
- `POST /api/action-planner/simulate` — dual-mode classify + dry-run (newly added)
- `GET /api/ai-assist/:id/suggestions` — agent reply suggestions
- `GET /api/ai-assist/:id/summary` — conversation summary
- `POST /api/ai-agents/:id/test-chat` — agent harness
- `POST /api/system-chat/ask` — RAG QA for admins
- `POST /api/ai-agents/generate` — wizard config generator
- `POST /api/ai-assist/intent` — internal intent classifier

**Executor** (`services/ai/src/services/action-executor.service.ts`):

| Tool | Status |
|---|---|
| `tag_contact` | ✅ Prisma direct |
| `get_contact` / `get_conversation` / `list_recent_messages` | ✅ Prisma direct |
| `create_workflow` | ✅ Prisma direct — creates `ChatbotFlow` with seeded start→message→end graph |
| `list_workflows` | ✅ Prisma direct |
| `noop` | ✅ (intentional stub) |
| `send_message` | ⚠️ calls `MessagingConnector.send()` — **only stub connector registered** |
| `update_crm` / `update_contact` / `create_ticket` / `create_task` | ⚠️ call `CrmConnector` — **only stub connector registered** |
| `create_broadcast`, `schedule_followup`, `preview_broadcast`, `schedule_broadcast`, `resolve_identity`, `merge_contacts` | ❌ stub `{queued: true, note: "delegated to domain service"}` — no real dispatch |

**Policy gate:** `policy.service.ts` — real hard gate at executor line ~82 via `validateAgainstPolicy`. Violations written to AuditLog. Defaults come from env/memory (no persistent `BusinessPolicy` Prisma model — the GET/PUT `/api/ai-assist/policy` routes operate on an in-memory object).

**RAG:** Qdrant + `text-embedding-3-small` + chunk pipeline are real and used by `/system-chat/ask` and (via `assemblePrompt`) by copilot suggestions. **The action planner does NOT consult the knowledge base** — it works from tool metadata only.

---

## 2. Real End-to-End Flows

These are flows where every step from user click to persisted effect is backed by code.

### 2.1 Messaging & inbox

1. **Inbound WhatsApp → inbox.** Meta → `webhook` → `incoming-messages` queue → conversation upsert → routing rules → agent assignment → Socket.IO push → inbox UI re-render.
2. **Agent sends reply.** `ChatPanel` → `POST /messages/:id/messages` → `outgoing-messages` queue → channel adapter → Meta API → status update → UI refresh.
3. **Agent claims/releases/reassigns/closes.** Inbox UI → `/conversations/:id/{claim,release,reassign,close}` → DB update → Socket.IO broadcast.
4. **Media upload.** `ChatPanel` → `POST /messages/:id/messages/media` → storage → outgoing queue.
5. **Idle reminder / auto-close.** `idle-conversations` worker → reminder message via outgoing queue → after delay, auto-close.

### 2.2 Broadcasts & scheduled messages

6. **Create broadcast.** `/outbound/broadcasts` UI → `POST /broadcasts` → DB draft.
7. **Validate / add recipients / send.** UI → `/broadcasts/:id/{validate,recipients,send}` → `broadcast-messages` queue → per-recipient outgoing dispatch → `BroadcastRecipient` status.
8. **Schedule message.** UI → `POST /scheduled-messages` → `scheduled.worker` fires at due time → outgoing queue.
9. **Cancel broadcast.** UI → `POST /broadcasts/:id/cancel` → queue drain + DB status.

### 2.3 Agents, departments, channels, auth

10. **Tenant onboarding.** `/setup` → `/onboarding/business-profile` → `/departments` → `/ai-chat` → `/generate-configs` → `/complete` → tenant marked `ACTIVE`.
11. **Connect WhatsApp Cloud.** `/channels` UI → `POST /channels/connect/whatsapp` → ChannelAccount row + token → health worker validates periodically.
12. **Connect embedded webchat.** `/channels` → `POST /channels/webchat/create` → widget settings → public `/embedded-chat/{init,message,messages/:sessionId}` endpoints drive the widget.
13. **Login / magic link / password reset.** `/login` → auth routes → JWT + refresh token.
14. **Create/manage department + assign AI employee.** `/departments` → auth routes → `Department` + `AIAgent` link.

### 2.4 Visual flow & routing

15. **Build chatbot flow.** `/ai-studio/flows/[id]` → `FlowEditor` → `PUT /api/chatbot-flows/:id` → DB nodes/edges JSON.
16. **Router rule CRUD + reorder.** `/ai-studio/router` → `/api/router-rules` endpoints.
17. **Auto-generate flow from wizard.** `POST /flow-canvas/auto-generate` → LLM → seeded nodes.

### 2.5 Knowledge base & RAG

18. **Create KB + upload doc.** `/ai-studio/knowledge` → KB routes → `KnowledgeDocument` → `POST /:id/documents/:docId/process` → chunker → `generateEmbedding` → Qdrant upsert.
19. **OAuth-sync Confluence / Drive.** `/ai-studio/marketplace/[slug]` → OAuth init/callback → `knowledge-oauth` sync endpoints → KB ingestion.
20. **Admin RAG Q&A.** `/system/chat` → `POST /system-chat/ask` → embed query → Qdrant search → LLM answer with sources.
21. **Copilot reply suggestion.** `ChatPanel`'s CoPilotPanel → `GET /api/ai-assist/:id/suggestions` → LLM (with RAG context if KB attached) → ranked suggestions → one-click insert.

### 2.6 Command Center (AI action layer)

22. **Ctrl+K question (chat mode).** Global `CommandCenterModal` → `POST /api/action-planner/simulate` → classifier returns `mode: "chat"` → UI shows natural-language answer. ✅
23. **Ctrl+K "create a workflow that greets new WhatsApp contacts" (execution mode).** Modal → simulate → plan with `create_workflow` step → Execute → `prisma.chatbotFlow.create` with seeded start/message/end graph → user opens `/ai-studio/flows/[id]`. ✅ (verified in gateway logs)
24. **Ctrl+K "tag contact X as VIP".** Modal → plan `tag_contact` → approve/execute → Prisma update → AuditLog row. ✅
25. **High-risk action approval.** Planner marks step `riskLevel: high` → executor blocks unless `approved: true` → `requiresApproval: true` → UI shows red "Approve & Execute" button → on click, plan is executed + `approvedBy` written to AuditLog. ✅
26. **Conversation intelligence panel.** Inbox → `GET /api/ai-assist/:id/intelligence` → `ConversationIntelligence` row with sentiment/resolution/confidence.
27. **Customer state panel.** `GET /api/ai-assist/customer-state/:contactId` → aggregated customer decision state from AuditLog + intelligence.
28. **Policy read/write.** `PolicyAdmin.tsx` (if mounted) → `/api/ai-assist/policy` → in-memory `BusinessPolicy` — **read/write works but is not persisted across restarts**.

### 2.7 System admin

29. **System admin dashboard.** `/system` → `system-admin` routes → tenant list, stats, token usage.
30. **Create tenant.** `/system/tenants` → `POST /system/tenants` → onboarding email trigger.

---

## 3. Partial / Broken Capabilities

### 3.1 AI executor tools that look real but don't do anything

Every tool in the list below is in the **static tool registry**, is callable by the planner, is accepted by the executor, writes an AuditLog row, and returns HTTP 200 — but performs **no real side effect** because no vendor connector is registered:

- `send_message` — calls `getMessagingConnector()` which returns the **stub** that returns `{ok: true, messageId: "stub"}`. No WhatsApp/SMS/Email is sent.
- `update_crm` / `update_contact` / `create_ticket` / `create_task` — same story with `CrmConnector`. No CRM row mutated.
- `create_broadcast`, `schedule_followup`, `preview_broadcast`, `schedule_broadcast`, `resolve_identity`, `merge_contacts` — executor returns `{queued: true, note: "delegated to domain service"}`. Nothing is queued. The domain endpoints (`/api/broadcasts`, `/api/identity/resolve`, `/api/identity/merge`) exist but the executor never calls them.

**Impact:** A user typing "send a follow-up to contact X on WhatsApp" via the Command Center will see a green "ready" success state, an AuditLog row, and zero delivered messages.

### 3.2 BusinessPolicy is not persistent

`policy.service.ts` keeps policy as an **in-memory map**. There is no `BusinessPolicy` Prisma model. `PUT /api/ai-assist/policy` edits memory only — any ai service restart reverts to defaults. The policy gate still enforces the in-memory value correctly, so this is a **persistence break, not a gate break**.

### 3.3 Parallel tool registries never unified

The static `tool-registry.ts` (used by planner) and the DB-backed `CatalogTool`/`TenantTool` (used by `tool-execution.service.ts`) describe overlapping concepts but live in different worlds:

- Planner can't call a catalog tool.
- Command Center can't invoke an INTERNAL_API catalog tool.
- `AgentToolPermission` (dept-level approval gates) applies to catalog tools but **not** to planner tools — planner tools only see the static `HIGH_RISK_TOOLS` list.

This is architectural drift: the DB catalog was designed for the "tool marketplace" UI; the static registry was added later for the Command Center.

### 3.4 Identity routes live in the wrong service

`POST /identity/resolve`, `/identity/merge`, `/:id/timeline` are served by the **conversation** service, not by `ai`. `gotcha-api.ts`'s `resolveIdentity`/`mergeIdentities` hit them directly, so the frontend works. But the action-planner executor has its own stubbed `resolve_identity`/`merge_contacts` that don't call those real endpoints. A Command Center "merge contacts A and B" request will stub-succeed and actually do nothing.

### 3.5 `CustomerTimeline.tsx` / `AIInsightsPanel.tsx` / `ApprovalQueue.tsx` / `PolicyAdmin.tsx`

These components exist and compile, but grepping for their imports shows they aren't mounted into any route/layout I can see. They appear to be **"F1.5/F4.3/F5.1/F7.4/F8.4 functional prototypes"** that were built per the PRD but never wired into the real nav. Users cannot reach them. `AICommandBar.tsx` has the same status — superseded by `CommandCenterModal`.

### 3.6 `create_workflow` quality

Works (creates a real `ChatbotFlow` row), but the seeded graph is a minimal start→message→end. Any richer intent ("create a flow that branches on intent and hands off to sales") produces the same 3-node skeleton. The graph isn't derived from the LLM's `steps[]` unless the LLM returns a properly-shaped React Flow `{nodes, edges}` blob, which current prompts don't instruct it to do.

### 3.7 Token logs say `trim` doesn't exist

`tsc --noEmit` on the ai service reveals pre-existing type errors unrelated to the Command Center changes (ai-agents.ts:113, integrations.ts:143, knowledge*.ts:*, tools.ts:17, system-chat.ts:285, prompt-assembler.service.ts:307, tool-execution.service.ts:47/54/236). These do not block the current build (tsx/ts-node tolerates them), but they indicate **schema drift between Prisma models and the TypeScript callers** — likely from a recent schema migration.

---

## 4. Orphan Code

### 4.1 Frontend components with no route reference

Components found under `frontend/src/components/` but not imported by any page under `frontend/src/app/`:

- `ApprovalQueue.tsx`
- `AICommandBar.tsx` (superseded by CommandCenter)
- `AIInsightsPanel.tsx`
- `CustomerTimeline.tsx`
- `PolicyAdmin.tsx`

These are the "functional prototypes" PRD F1.5/F4.3/F5.1/F7.4/F8.4 ticked off. They exist as files; they are not in the product.

### 4.2 Backend endpoints with no frontend caller

Grep of `gotcha-api.ts` + `api.ts` shows no caller for:

- `/api/action-planner/plan` (only `/simulate` and `/execute` are used)
- `/api/action-planner/approvals` (no approval queue UI wired)
- `/api/ai-assist/:id/intelligence` route (analysis data exists, no page reads it)
- `/api/ai-assist/:id/tools` and `/tools/execute` (tool-execution viewer not wired)
- `/api/ai-assist/:id/score` / `POST /score` (agent scoring not surfaced in a dashboard)
- `/api/ai-assist/prompt/:departmentId` (system-admin debug, possibly intentional)
- `/api/flow-canvas` GET/PUT/auto-generate (superseded by `/api/chatbot-flows`?)
- Several `/system/*` endpoints (some have UI under `/system`, some don't)

### 4.3 Dead or near-dead models

- `CreditTransaction` — billing placeholder, unused in code paths.
- `FlowCanvas` — parallel to `ChatbotFlow`, unclear if it's the new or old system. Routes exist but I don't see UI reading it.

---

## 5. Missing wiring (frontend ↔ backend mismatches)

1. **Command Center ↔ vendor connectors.** Front-end "execute a send_message action" will succeed without sending anything. Fix: register real connectors in `services/ai/src/index.ts` via `registerCrmConnector()` / `registerMessagingConnector()`, or delegate executor cases to existing internal routes (e.g. POST to `/api/messages/:conversationId/messages`).
2. **Command Center ↔ identity service.** Same pattern — `resolve_identity` / `merge_contacts` should delegate to the existing `/api/identity/*` routes on the conversation service.
3. **Planner ↔ knowledge base.** RAG is used by copilot suggestions but not by action planning. A question like "what's the refund policy for Pro plan?" in Ctrl+K currently goes to the classifier and back in chat mode with whatever the LLM guesses, not what's in the KB.
4. **Planner ↔ DB catalog tools.** `TenantTool` + `AgentToolPermission` exist; planner can't see them. Catalog tools cannot be invoked via natural language.
5. **Approval queue.** `ApprovalQueue.tsx` exists, `/api/action-planner/approvals` exists, they don't meet. Either mount the component somewhere (inbox sidebar? system-admin?) or delete it.
6. **Policy persistence.** Persist `BusinessPolicy` to Prisma so `PUT /api/ai-assist/policy` survives restart.
7. **ConversationIntelligence panel.** The row is written by analyze routes but no page reads it.

---

## 6. Critical production risks

**P0 — Silent-success on AI execution.**
The biggest production-facing risk. A command that looks like it sent a message or updated a CRM record actually did nothing, but returned HTTP 200 with `{ok: true}` and wrote an AuditLog row claiming success. A customer-facing operator relying on Command Center for "tag contact VIP and send a welcome message" will believe it worked. The tag part is real (Prisma); the send part is a stub. **Must fix connectors before advertising this path.**

**P1 — In-memory policy.**
`BusinessPolicy` lives in a JS Map. If the ai service restarts (which happened once during this audit — `ai-1 exited with code 143` / recreated), any custom policy edits are lost. Reverts silently to defaults. High-risk for tenants relying on a custom `maxDiscountPercent` or `blockedTopics`.

**P2 — Pre-existing typecheck errors in the ai service.**
Routes `tools.ts`, `integrations.ts`, `knowledge*.ts`, `system-chat.ts`, `prompt-assembler.service.ts`, `tool-execution.service.ts` have type errors that indicate schema/code drift. The service runs (tsx doesn't gate on strict mode) but new code touching these modules will inherit the drift. Regression risk is elevated.

**P3 — Two parallel tool systems diverge further.**
Every feature added to the static registry pushes it further from the catalog. Plan a unification milestone before adding more Command Center tools.

**P4 — `.env`-shaped secrets flowing through `TenantIntegration`.**
`POST /api/integrations/:slug/connect` and `PUT /credentials` store credentials keyed by tenant. Worth a security pass to confirm they're encrypted at rest (not audited here).

**P5 — Orphan components shipped in the bundle.**
`AIInsightsPanel`, `ApprovalQueue`, `CustomerTimeline`, `PolicyAdmin`, `AICommandBar` are built into the frontend bundle but unreachable. Free bundle-size fat. Delete or wire.

---

## 7. Feature reality vs PRD (appendix, not primary)

Purely for the person reading this with `PRD.md` open. Strict PASS means backend + API + frontend + AI-tool wiring + working E2E.

| PRD Feature | Backend | API | Frontend wired | AI tool real | Verdict |
|---|---|---|---|---|---|
| F1 Identity Resolution | ✅ (conversation svc) | ✅ | ⚠️ `CustomerTimeline.tsx` orphan | ❌ stub in executor | **⚠️ PARTIAL** |
| F2 AI Command Center | ✅ action-planner | ✅ plan/simulate/execute/classify/approvals | ✅ CommandCenterModal | ✅ planner prompt | **✅** |
| F3 Action Engine | ✅ executor + audit | ✅ /execute | ✅ | ⚠️ half the tools stubbed | **⚠️ PARTIAL** |
| F4 Approval System | ✅ risk gate + approvals route | ✅ | ⚠️ `ApprovalQueue.tsx` orphan | ✅ risk gate enforced | **⚠️ PARTIAL** |
| F5 AI Copilot (Inbox) | ✅ ai-assist suggestions/summary | ✅ | ✅ CoPilotPanel in ChatPanel | ✅ | **✅** |
| F6 Smart Follow-up | ✅ idle worker + scheduled worker + `/followup` | ✅ | ⚠️ triggered by worker, not user-facing | ⚠️ `schedule_followup` stubbed in executor, but real `/followup` endpoint works | **⚠️ PARTIAL** |
| F7 Conversation Intelligence | ✅ `ConversationIntelligence` + `customer-state` + Qdrant | ✅ | ❌ intelligence route has no reader, `AIInsightsPanel.tsx` orphan | n/a | **⚠️ PARTIAL** |
| F8 Business Policy | ✅ gate | ✅ GET/PUT | ⚠️ `PolicyAdmin.tsx` orphan | ✅ enforced in executor | **⚠️ PARTIAL** (+ not persisted) |
| F9 Suggested Actions | ✅ copilot suggestions + agent-scoring + router-rules | ✅ | ✅ CoPilotPanel | ⚠️ `tag_contact` real, others stubbed | **⚠️ PARTIAL** |

PRD's "[x]" checkmarks are accurate about **existence**. They are optimistic about **real execution** — hence the partials.

---

# 8. Reality-based PRD (proposed replacement for PRD.md)

Below is a new PRD that describes **what the system actually does today**, written as if PRD.md did not exist. This is the honest feature list to ship/market.

---

## GOTCHA — Product Requirements (reality-based, 2026-04-13)

### Product one-liner
GOTCHA is a **multi-tenant omnichannel conversation platform** that unifies customer messaging across WhatsApp, Messenger, Instagram, Gmail, Outlook, Slack and embedded webchat into a single agent inbox, with a **visual chatbot builder**, a **RAG-powered knowledge base**, and an **AI copilot + command palette** for agents and admins.

### Primary users
1. **Tenant admin** — connects channels, configures departments, builds flows, manages AI agents, edits policy.
2. **Human agent** — works the inbox, claims conversations, uses copilot suggestions, sends replies.
3. **System admin** — onboards tenants, monitors token usage.

### Shipping capabilities (what's real today)

**C1. Unified omnichannel inbox**
Agents see conversations from all connected channels in one list. Claim/release/reassign/close. Real-time updates via Socket.IO. Media upload. Notes.

**C2. Channel connections**
WhatsApp Cloud API, Messenger, Instagram, Gmail (OAuth), Outlook (OAuth), Slack, embedded webchat widget. Health checks + token refresh for Meta channels.

**C3. Multi-tenant auth & RBAC**
Magic link + password login, JWT + refresh tokens, tenant onboarding wizard, system-admin console.

**C4. Department routing & SLA**
Tree of departments, per-department SLA rules, idle-conversation automation, AI agent assignment per department.

**C5. Visual chatbot flow builder**
React Flow canvas with start/message/quick_reply/condition/handover/department_route/end nodes. Per-channel or universal flows. Save/activate/test.

**C6. Main playbook routing**
Second visual editor (`/ai-studio/router`) for channel entry → condition groups → route targets. Uses `RouterRule` and `FlowCanvas`.

**C7. Broadcasts & scheduled messages**
Create, validate (audience sizing), schedule, send, cancel. Per-recipient delivery tracking. Templates (including Meta template submission flow).

**C8. RAG knowledge base**
Text/file/URL documents, chunker + `text-embedding-3-small` + Qdrant. OAuth sync from Google Drive and Confluence. Used by copilot suggestions and `/system-chat/ask`.

**C9. AI copilot in inbox**
Per-conversation reply suggestions, summary, intelligence (sentiment/resolution/confidence), customer state aggregate. One-click insert to message input. RAG-grounded when a KB is attached.

**C10. AI Command Center (Ctrl+K)**
Global command palette. Dual-mode: chat (natural-language Q&A) or execution (plan → simulate dry-run → approve → execute). Animated state-aware glow. Tool registry covers messaging / CRM / broadcast / workflow / identity / meta categories. Plans logged to AuditLog.

**C11. Policy-gated execution**
Every AI action passes through a hard policy gate before execution. High-risk tools (`send_message`, `create_broadcast`, `update_crm`, `schedule_followup`) are blocked unless explicitly approved. Policy violations and blocked actions written to audit trail.

**C12. Immutable audit log**
Every AI action, dry-run, block, and approval writes a row with reason, risk level, params, approvedBy, idempotency key, and outcome.

**C13. Tool catalog & agent permissions**
DB-backed `IntegrationCatalog` × `CatalogTool` × `TenantTool` × `AgentToolPermission` — a marketplace-style mechanism for wiring external APIs (Salesforce, HubSpot, Shopify, etc.) to AI agents with per-department approval gates. Generic HTTP dispatcher for INTERNAL_API/CRM/ECOMMERCE/KNOWLEDGE_BASE/CUSTOM tool types.

**C14. Analytics**
Dashboard KPIs, per-agent stats, hourly/daily volume, queue depth, token usage per-tenant.

**C15. Idle automation**
Background worker checks stale conversations, sends configurable reminders, optionally auto-closes after delay.

### Capabilities promised in docs but NOT shipping today (do-not-market list)

These need engineering work before they're sellable:

- **D1.** "AI can send WhatsApp messages via natural language" — executor path exists, but `MessagingConnector` is a stub. **Wire the connector to the existing outgoing-messages queue.**
- **D2.** "AI can update CRM records via natural language" — executor path exists, `CrmConnector` is a stub. **Wire catalog tools via `tool-execution.service.ts` into the executor.**
- **D3.** "AI can create/schedule broadcasts via natural language" — executor returns `{queued: true}` with no dispatch. **Delegate to `/api/broadcasts` routes.**
- **D4.** "AI can resolve/merge customer identity via natural language" — same stub. **Delegate to `/api/identity/*` routes on conversation service.**
- **D5.** "Approval queue dashboard" — component exists, endpoint exists, **not mounted anywhere.**
- **D6.** "Customer timeline view" — component exists, endpoint exists, **not mounted anywhere.**
- **D7.** "Persistent business policy" — policy gate works, but policy state is in-memory. **Add `BusinessPolicy` Prisma model.**
- **D8.** "Unified tool system" — two registries run in parallel. **Expose DB catalog to planner; deprecate static registry OR make it generate from catalog.**
- **D9.** "Planner-aware RAG" — action-planner never consults the knowledge base. **Add KB context injection to planner prompt.**

### Non-goals (explicit)
- Not a CRM replacement. GOTCHA operates on top of CRMs via connectors it doesn't own the data in.
- Not a marketing automation suite. Broadcasts are functional but minimal.
- Not a billing system. `CreditTransaction` model is a placeholder.

### Quality gates for any feature to be marked "done"
1. Backend route exists and is registered in a router.
2. API is called by at least one mounted frontend component **OR** a named background worker.
3. If the feature is AI-executable, the executor case performs a real side-effect (Prisma write or HTTP dispatch via a registered connector) — **not** a `{queued: true}` stub.
4. `tsc --noEmit` passes for the touched files.
5. The path is exercised at least once against a running environment before shipping.

A feature is PARTIAL if any of 1–3 is missing. PARTIAL features do not get a PRD checkmark.

---

## 9. Recommendations (ordered by ROI)

1. **Ship real connectors (P0).** In `services/ai/src/index.ts`, register:
   - `MessagingConnector` whose `send()` enqueues to the existing `outgoing-messages` BullMQ queue.
   - `CrmConnector` whose methods call `tool-execution.service.ts` for whichever catalog tool the tenant has connected (or the tenant's default "internal" catalog tool that writes to `Contact` directly).
   This one change converts ~6 currently-fake tools into real ones with near-zero new code.
2. **Delegate stubbed tools to existing routes.** `create_broadcast` → `POST /api/broadcasts`, `resolve_identity` → `POST /api/identity/resolve`, etc. These routes exist; the executor just doesn't call them.
3. **Persist `BusinessPolicy`.** Add a Prisma model with one row per tenant. Migrate `policy.service.ts` to load/save instead of in-memory Map.
4. **Mount the orphan components or delete them.** Wire `ApprovalQueue.tsx` into `/ai-studio` or a new `/approvals` page. Wire `CustomerTimeline.tsx` into the contact detail drawer. Wire `PolicyAdmin.tsx` into `/settings`. Delete `AICommandBar.tsx` (superseded).
5. **Fix the pre-existing typecheck errors in ai service.** They're unrelated to the AI execution layer but they hide future regressions. Apply targeted fixes to `tools.ts`, `integrations.ts`, `knowledge*.ts`, `tool-execution.service.ts`.
6. **Unify tool registries.** Make `tool-registry.ts` generate from `CatalogTool` per tenant (or the other way around).
7. **Planner KB injection.** Pass top-K chunks for the prompt into the planner system message so Ctrl+K chat mode can answer policy/product questions with grounded data.
8. **Add a smoke-test suite** that exercises each E2E flow in §2 against a running docker-compose stack, so future audits take 5 minutes instead of an hour.

---

*End of report.*
