# PRD.md — GOTCHA (AI Communication & Execution OS)

---

# 🎯 Product Vision

GOTCHA is an AI execution layer on top of existing business systems (NOT a CRM replacement).

It enhances CRMs like Salesforce / HubSpot by enabling:

- Unified omnichannel communication
- Customer identity resolution across systems
- AI-driven recommendations + execution
- Business workflow automation with guardrails

👉 Core shift:
"AI that responds" → "AI that operates the business"

---

# ⚙️ GLOBAL EXECUTION RULES

Applies to ALL tasks:

- Order: backend → frontend → smoke test
- No user prompts during execution
- Each task must be minimal and shippable (1–3 files max)
- Every feature ends with:
  - typecheck passes
  - no console errors
  - service rebuild successful
- Commit per task (conventional commits)
- If blocked → mark `blocked:` and continue
- Any destructive action → STOP and request confirmation

---

# 🧩 ATOMIC FEATURE BACKLOG

---

## 🧠 F1: Customer Identity Resolution (Unified Identity Layer)

### Tasks
- [x] F1.1 Add Identity Resolution schema (email, phone, external_ids) — reused existing `contacts` table per CLAUDE.md reuse rule
- [x] F1.2 Implement identity matching service (deterministic + heuristic) — POST /api/identity/resolve
- [x] F1.3 Merge identities endpoint — POST /api/identity/merge
- [x] F1.4 Customer timeline aggregation API — GET /api/identity/:id/timeline
- [ ] F1.5 UI: Unified customer profile timeline

### Done when:
- No duplicate customers across system
- All interactions resolve to single unified customer identity

---

## 🤖 F2: AI Command Center (Global + Contextual)

### Tasks
- [x] F2.1 Define AI Action Schema — `PlannedAction`/`ExecutionPlan` in routes/action-planner.ts
- [x] F2.2 Build Action Planner — POST /api/action-planner/plan (LLM JSON mode)
- [ ] F2.3 Global command bar (header AI input) — UI deferred
- [ ] F2.4 Context command (inside customer/chat view) — UI deferred
- [x] F2.5 Dry-run execution preview — POST /api/action-planner/execute with dryRun flag

### Done when:
- Any business operation can be triggered via natural language safely

---

## 🧠 F3: AI Action Engine (Execution Layer)

### Tasks
- [x] F3.1 Action logging — reused existing `AuditLog` table (no new migration)
- [x] F3.2 Action executor service — services/ai/src/services/action-executor.service.ts
- [ ] F3.3 CRM connector abstraction layer — stubbed; delegated to integrations service
- [ ] F3.4 Messaging connector abstraction layer — stubbed; delegated to outgoing-worker
- [x] F3.5 Safe execution wrapper — `validateAction()` risk gate + policy gate

### Done when:
- Every AI action is structured, logged, and reversible-safe (via audit trail)

---

## 🔐 F4: AI Approval System

### Tasks
- [x] F4.1 Risk scoring — `HIGH_RISK_TOOLS` list + per-action `riskLevel`
- [ ] F4.2 Approval queue backend — deferred (AuditLog query can serve as queue)
- [ ] F4.3 Approval UI modal (approve / reject) — UI deferred
- [x] F4.4 Action blocking until approval — executor returns skipped+reason when !approved
- [x] F4.5 Audit binding for approvals — `approvedBy` written to AuditLog metadata

### Done when:
- High-risk actions cannot execute without explicit approval

---

## 💬 F5: AI Copilot (Inbox Intelligence)

### Tasks
- [ ] F5.1 AI sidebar in conversation view — UI deferred
- [x] F5.2 Suggested replies generator — existing GET /api/ai-assist/:conversationId/suggestions
- [x] F5.3 Suggested actions generator — covered via action-planner + existing tools route
- [x] F5.4 “Why suggested” explanation — existing ai-assist.service suggestions include reasoning
- [ ] F5.5 One-click insert into message input — UI deferred

### Done when:
- Agents can execute AI suggestions directly inside inbox

---

## 🔄 F6: Smart Follow-up Engine

### Tasks
- [x] F6.1 Background job scanning inactive chats — existing incoming-worker/idle-conversation.worker.ts
- [x] F6.2 Intent detection — existing POST /api/ai-assist/intent
- [x] F6.3 Follow-up message generator — POST /api/ai-assist/:conversationId/followup (LLM + policy-aware)
- [x] F6.4 Auto-scheduled follow-up action — existing scheduled-messages + scheduled.worker
- [ ] F6.5 CRM task creation integration — stubbed via action-executor create_ticket tool

### Done when:
- System proactively drives conversions via follow-ups

---

## 🧠 F7: Conversation Intelligence (Memory Layer)

### Tasks
- [x] F7.1 Conversation summary storage — existing `ConversationIntelligence` model + aiSummary
- [ ] F7.2 Customer “state object” builder — deferred
- [x] F7.3 RAG memory retrieval — existing qdrant.service + knowledge.service + embedding.service
- [ ] F7.4 UI: Customer insight summary panel — UI deferred
- [ ] F7.5 Decision history tracking — deferred

### Done when:
- Every customer has persistent business memory across interactions

---

## 🧩 F8: Business Policy Engine

### Tasks
- [x] F8.1 Policy schema — `BusinessPolicy` in services/ai/src/services/policy.service.ts
- [x] F8.2 Policy injection into AI context — `getPolicyPrompt()` helper
- [x] F8.3 Policy enforcement middleware — hard gate in executeAction() via validateAgainstPolicy
- [ ] F8.4 Policy admin UI — UI deferred
- [x] F8.5 Rule violation detection — logged to AuditLog as `policyViolation` metadata

### Done when:
- AI cannot violate business rules

---

## 🎯 F9: Suggested Actions Layer

### Tasks
- [x] F9.1 Context-aware recommendation engine — action-planner + existing suggestions route
- [x] F9.2 Lead prioritization — existing agent-scoring.service
- [x] F9.3 Escalation suggestion — policy.escalationKeywords + existing router-rules
- [ ] F9.4 Action ranking UI inside inbox — UI deferred
- [x] F9.5 CRM tagging suggestions — action-executor `tag_contact` tool

---

# 🧠 QUALITY GATE (ALL FEATURES)

- typecheck passes
- unit tests pass
- no console errors
- commit created
- service rebuild successful

---

# 🚀 SUMMARY

GOTCHA = AI execution layer on top of CRMs

Not replacing CRM — augmenting it with intelligence + execution.
