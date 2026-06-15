# AI Flow - End-to-End

How an AI Employee answers a customer (autonomous mode) and how the CoPilot helps a human agent. Covers prompt assembly, tool-calling, RAG, config resolution, and the debug surface.

> **Architectural rule (2026-04 onward):** every LLM call lives in the **AI service**. The incoming-worker, comment-trigger walker, and any other surface that needs an LLM go through HTTP to the AI service - they do not import the OpenAI SDK directly. The single exception still pending migration is `services/auth/src/routes/onboarding.ts`.

---

## 1. The two surfaces

| Surface | Mode | Trigger | Who reads the reply |
|---|---|---|---|
| **Autonomous bot** | `agent` | Webhook → queue → flow-executor / incoming.worker | The customer (sent over WhatsApp/Messenger/Instagram) |
| **CoPilot** | `assist` | Human agent opens the inbox UI | The human agent (suggestions, summary, chat) |

Both share the same `AIAgent` row in the DB, but they assemble prompts differently and the autonomous bot has access to integration tools while the copilot does not.

---

## 2. Autonomous bot - full call chain

### 2.1 Trigger paths into `processAIBot`

```
Meta webhook (WA / IG / Messenger)
        ↓
gateway → /api/webhook → webhook-service
        ↓
BullMQ enqueue: incoming-messages
        ↓
incoming-worker.processIncomingMessage(job)
        ↓
   ┌────────────────────────────────────────┐
   │ Worker decides what to do with this    │
   │ inbound based on conversation state:   │
   │                                        │
   │ messageCount <= 1  → routing.service   │
   │   → flow-executor.executeMainFlow      │
   │     → on `route_target { agent }`:     │
   │        dispatchRoute("agent")          │
   │        → processAIBot(...)             │
   │                                        │
   │ handledBy === "ai_agent"               │
   │   → processAIBot(...)                  │
   │                                        │
   │ chatbotNodeId set                      │
   │   → executeMainFlow(resumeNodeId)      │
   │     (may dispatch to AI again)         │
   └────────────────────────────────────────┘
```

`processAIBot` is the single entry point for "AI replies to customer" - three paths feed into it.

### 2.2 What the worker does (side effects only)

`services/incoming-worker/src/services/ai-bot.service.ts`

```
processAIBot(tenantId, conversationId, message, agentId?)
  1. Load conversation (+ channelAccount creds)
  2. Resolve aiAgentId (param → conversation.assignedAiAgentId)
  3. Load AIAgent (lite slice - escalationMessage, max thresholds, status)
  4. Build SendContext (channel, externalId, decrypted credentials)
  5. ── Pre-flight ────────────────────────────────────
     a. checkEscalationThresholds (max messages, max minutes)
        → escalateToHuman()  (sends escalationMessage, sets WAITING)
     b. isHumanRequest (regex over user message)
        → escalateToHuman()
  6. ── Delegate to AI service ─────────────────────────
     POST http://ai:4006/api/ai-bot/reply
     headers: { X-Internal-Key: $INTERNAL_SERVICE_KEY }
     body:    { tenantId, conversationId, aiAgentId, incomingMessage }
  7. ── Act on result ─────────────────────────────────
     awaitingApproval → set handledBy="awaiting_approval",
                        audit, send bridge-ack to customer, return
     escalation       → escalateToHuman(), return
     reply            → adapter.sendTextMessage() → DB persist
                        → trackMessageUsage → publish message:new
```

The worker **never imports `openai`** anymore. It calls AI service for the reply decision and acts on three return signals: `awaitingApproval`, `escalation`, or `reply`.

### 2.3 What the AI service does (the LLM work)

`services/ai/src/services/ai-bot.service.ts:generateAIBotReply()`

```
1. Load AIAgent row (validate tenant match)
2. Load last 50 messages (asc by createdAt)
3. systemPrompt = buildSystemPrompt(config)        ← see §4.1
4. RAG: retrieveRelevantChunks(tenantId, msg, 5)   ← see §6
        if any → systemPrompt += "\n\n## KB ..."
5. Build chatMessages:
     [{ role: "system", content: systemPrompt }, ...history(user/assistant)]
6. Resolve contactId for tool context
7. tools = buildAgentToolsForAIAgent(tenantId, agentId, …)
        → escalate_to_human + link_customer_identifier (static)
        → all enabled TenantTool rows whose integration is CONNECTED
8. Tool-calling loop (MAX 3 rounds):
     resp = generateResponse({ messages, tools, model, temp, max_tokens })
       → which calls openai.chat.completions.create() inside
         the central ai.service.ts gateway
     if resp.toolCalls.length === 0:
        replyText = resp.content  ← FINAL TEXT
        break
     else:
        push assistant turn (with tool_calls)
        for each tool_call:
          dispatchToolCall(tc, agentToolCtx)   ← from @chatcenter/shared
          audit ai.tool_call.<name>
          push role: "tool" message with result
          if sideEffect.escalate    → pendingEscalation = …
          if sideEffect.awaitingApproval → break early, signal pause
9. Audit ai.bot_turn (one summary record per inbound)
10. Return { reply, escalation, awaitingApproval, toolCallLog,
             modelUsed, totalTokens }
```

### 2.4 Token usage & audit

- The central `generateResponse()` (`services/ai/src/services/ai.service.ts`) writes:
  - `usage_logs` row (via `trackAIUsage`)
  - `audit_logs` row with action `ai.responded` per LLM call
- `generateAIBotReply` adds:
  - `audit_logs` `ai.tool_call.<tool_name>` per tool call
  - `audit_logs` `ai.bot_turn` summary per inbound message

---

## 3. CoPilot - full call chain

### 3.1 Trigger paths

| Endpoint | When | Mode |
|---|---|---|
| `GET /api/ai-assist/:conversationId/suggestions` | Agent opens conversation, draft suggestions | `READY_MESSAGE` or `CONTEXT_ONLY` |
| `GET /api/ai-assist/:conversationId/summary` | Agent clicks "summarize" | n/a (separate prompt) |
| `POST /api/ai-assist/:conversationId/chat` | Agent types into the CoPilot chat panel | `CHAT` |
| `POST /api/ai-assist/compose` | Agent uses AI compose in inbox / template editor | n/a (one-shot copy) |

### 3.2 Inside the request

```
1. Load conversation + last N messages (20 for suggestions, all for summary, all for chat)
2. config = getEffectiveCopilotConfig(tenantId, departmentId, "copilot")  ← see §5
   → returns CopilotConfigData { systemPrompt, model, temperature, maxTokens,
                                  copilotMode, tools, isActive }
3. OpenAIProvider.suggestResponse() / .summarize() / .chatWithAgent():
   a. systemPrompt = config.systemPrompt
   b. + truthfulness footer
   c. + locale-specific language instruction (e.g. "respond in Hebrew")
   d. RAG: if last inbound looks "worth searching" (`shouldSearchKB`),
      retrieveRelevantChunks → append "## Knowledge Base" block
   e. messages = [
        { role: "system", content: systemPrompt },
        { role: "user",   content: "## Conversation Transcript\n[Customer]: ...\n[Agent]: ..." },
        { role: "user",   content: <mode instruction>   ← see §3.3 }
      ]
   f. tools = buildAgentTools({ identityLinking, escalation: true })
              ← only the 2 static helpers (no integrations in copilot)
4. generateResponse(...) → OpenAI
5. Suggestions endpoint parses JSON; chat returns plain text.
```

### 3.3 Mode instruction (decides response shape)

| `copilotMode` | Instruction | Response format |
|---|---|---|
| `READY_MESSAGE` (default) | "Suggest 2-3 reply options the agent could send. JSON suggestions[]." | JSON `{ suggestions: [{text, confidence, type}] }` |
| `CONTEXT_ONLY` | "Provide 2-4 brief insights - original reason, current need, sentiment, next step. JSON suggestions[] type:info." | JSON insight bullets |
| `CHAT` | "You are talking to the HUMAN AGENT, not the customer. Plain text, no JSON." | Plain markdown text |

Mode is selected per request from `config.copilotMode` (set on the AI Agent record).

---

## 4. Prompt assembly - the two builders

### 4.1 Autonomous bot - `buildSystemPrompt(config)`

`services/ai/src/services/ai-bot.service.ts`

This is the **legacy builder**, preserved from the original worker code so production agents (e.g. "Rotem") keep producing the same prompt they always have.

Reads from the `AIAgent` row:

| Field | Effect |
|---|---|
| `systemPrompt` (long text) | The base of the prompt - this is the big free-text block authors edit in AI Studio |
| `rules[]` | Appended as `Rules you must follow:\n- …` |
| `identity.{role, responsibility, representationGuidelines[]}` | Appended as `Your role: …` block |
| `toneConfig.{formalityLevel, empathyLevel, assertiveness, brandAlignment}` | Appended as `Tone guidelines:` |
| `behavioral.{forbiddenActions[], safetyBoundaries[]}` | Appended as `Forbidden actions:` / `Safety boundaries:` |

Then **two hardcoded sections** are always appended:
- `## Truthfulness & Knowledge Base Rules` (don't fabricate, base on KB, etc.)
- `IMPORTANT: You are chatting directly with the customer.`

**Tool schemas are NOT duplicated in the prompt** - they're sent only via the OpenAI `tools` field. The author should write tool *policy* (when to call which tool, in what order) inside `agent.systemPrompt`, NOT the schemas.

### 4.2 CoPilot - `assemblePrompt("assist", …)`

`services/ai/src/services/prompt-assembler.service.ts`

Modern, opinionated builder. Order:

```
[CoPilot Instructions]   ← static MD: services/ai/src/prompts/copilot-instructions.md
       ↓
[Shared Section]         ← built from agent.{name, role, description, tone, style, tools}
                           = Overview + Behavioral Rules + Tools section *
       ↓
[Guardrails]             ← static MD: services/ai/src/prompts/guardrails.md
       ↓
[Custom Guardrails]      ← agent.customGuardrails[] (optional)
```

Joined with `\n\n---\n\n`.

> **\*Note:** The Tools section in `Shared Section` *currently duplicates* tool descriptions inside the prompt - even though the same tools are also passed via the API `tools[]` field. This is bloat (double-billing tokens, drift risk). Tracked as cleanup; remove `buildToolsSection()` from `prompt-assembler.service.ts:buildSharedSection()` to fix.

For the agent autonomous mode, `assemblePrompt("agent", …)` adds an `[Autonomous Section]` (escalation rules) and `[Conversation Strategy]` instead of CoPilot Instructions - but **this path is currently NOT used** by the autonomous bot. The bot uses `buildSystemPrompt` (§4.1). A future migration could switch the bot to `assemblePrompt("agent")`; that's a behavior change and not done yet.

### 4.3 Decision tree - which builder runs?

```
Surface          | Builder
────────────────────────────────────────────────────────────
Autonomous bot   | buildSystemPrompt   (§4.1)
CoPilot          | buildConfigFromAIAgent → assemblePrompt("assist") if agent.sharedPrompt
                 |                       → fallback: agent.systemPrompt + COPILOT_MODE_INJECTION
                                            + assembleFromBlocks (legacy) if no systemPrompt
                                          [legacy fallback: rare, only for old agents
                                           that were never opened in the new editor]
```

The fallback is in `services/ai/src/services/ai-assist.service.ts:buildConfigFromAIAgent()`.

---

## 5. AI Agent resolution - which agent answers

`services/ai/src/services/ai-assist.service.ts:getEffectiveCopilotConfig(tenantId, departmentId, role)`

```
1. departmentId set?
   → query RouterRule { tenantId, routeType: "AI_AGENT", routeTarget: deptId, enabled }
     → if found → load AIAgent → buildConfigFromAIAgent(agent, role)
2. Otherwise (or no dept rule):
   → query RouterRule { tenantId, routeType: "AI_AGENT", isDefault: true, enabled }
     → if found → load AIAgent
3. Final fallback:
   → first AIAgent for tenant where status IN (ACTIVE, DRAFT), oldest first
```

For the autonomous bot the resolution is different - the **Main Flow Canvas's `route_target { agent }` node decides** which agent to dispatch. Once dispatched, `conversation.assignedAiAgentId` is set so subsequent inbound messages re-enter the same agent without re-routing through the graph.

---

## 6. RAG - knowledge base retrieval

Retrieval is the **same code** from both autonomous bot and copilot - `services/ai/src/services/knowledge.service.ts:retrieveRelevantChunks(tenantId, query, limit=5)`.

```
1. Embed query  →  openai.embeddings.create() via central ai.service
2. Filter active KnowledgeBase rows for the tenant
3. qdrant.search("knowledge_chunks", { vector, filter: tenantId + KB ids, limit })
4. Return top-k chunks: { content, score, documentTitle, chunkIndex }
```

**When it fires:**

| Surface | Probe | Skip on |
|---|---|---|
| Autonomous bot | The current inbound message (always) | (always tries) |
| CoPilot suggestions / chat | The last inbound message - only if `shouldSearchKB(msg)` is true | Greetings, thanks, "ok", emoji-only, etc. (regex skip-list) |

If chunks are returned, they're formatted into a `## Knowledge Base Context` markdown block and **appended to the system prompt** (not pushed as a separate user message - except in `chatWithAgent` which uses a fake user/assistant turn pair to inject KB).

---

## 7. Tool-calling protocol

### 7.1 Tool list

- **Autonomous bot:** `buildAgentToolsForAIAgent(tenantId, agentId, …)` from `@chatcenter/shared`
  - Static: `escalate_to_human`, `link_customer_identifier`
  - Dynamic: every `TenantTool` row that's `isEnabled` AND whose `TenantIntegration.status === "CONNECTED"`
- **CoPilot:** `buildAgentTools({ identityLinking, escalation: true })` - only the 2 static helpers

### 7.2 OpenAI request shape

```js
openai.chat.completions.create({
  model, messages, temperature, max_tokens,
  tools: [
    { type: "function", function: { name, description, parameters: {jsonSchema} } },
    ...
  ],
  tool_choice: "auto"   // implicit default
})
```

### 7.3 Response → loop

If the response has `tool_calls`:

```
1. Append assistant turn (with tool_calls) to messages
2. For each tc:
     args = JSON.parse(tc.function.arguments)
     result = dispatchToolCall(tc, agentToolCtx)
     audit ai.tool_call.<name>
     append { role: "tool", tool_call_id: tc.id, content: result.content }
   sideEffects:
     - sideEffect.escalate → store, will escalateToHuman after loop
     - sideEffect.awaitingApproval → break early, return signal to worker
3. Loop again so the model can write the final text reply
```

Capped at **3 rounds**. After 3 rounds with no final text, return `null` and the worker drops the turn.

`dispatchToolCall` lives in `@chatcenter/shared/src/lib/agent-tools.ts` and handles routing by tool name - it's used by both autonomous-bot and copilot-chat paths.

---

## 8. Debug surface - see what the LLM gets

`services/ai/src/routes/ai-debug.ts` - mounted at `/api/ai-debug`.

- `POST /api/ai-debug/jit` - SYSTEM_ADMIN only; mints a single-use, short-TTL token bound to a `tenantId` (and optional `agentId`).
- `GET /api/ai-debug/prompt?tenantId=…&agentId=…&mode=agent|assist&conversationId=…&message=…`
  - Auth: `X-Debug-Key: $AI_DEBUG_KEY` header **or** `Authorization: Bearer <jit>`.
  - Returns: `{ tenant, agent, mode, context, systemPrompt, tools, messages, stringified }`.
  - **The exact `messages` and `tools` arrays the LLM would receive.**

`mode=agent` calls the same `buildSystemPrompt` as production. `mode=assist` calls the same `assemblePrompt("assist")` as production. There's no drift - debug and runtime share one builder per mode.

---

## 9. End-to-end timing diagram (autonomous bot)

```
Customer (WhatsApp)
   │  "אני רוצה לקנות חבילה"
   ▼
Meta webhook (POST /api/webhook)
   │
gateway-1 → webhook-service → BullMQ "incoming-messages"
   │
incoming-worker (Job N)
   │  conversation lookup → status check → assignedAiAgentId resolve
   │  pre-flight: thresholds, "human" keyword
   │
   │   POST http://ai:4006/api/ai-bot/reply
   ▼
ai-service
   │  load agent + history(50)
   │  buildSystemPrompt(agent)  + RAG (qdrant search)
   │  build tools: static + tenant integrations
   │  ROUND 1: generateResponse({ messages, tools })
   │    ↳ central ai.service → openai.chat.completions.create
   │    response: tool_calls = [integration_create_lead]
   │  dispatchToolCall → POST Zoho CRM (via tool dispatcher)
   │  push tool result message
   │  ROUND 2: generateResponse(...)
   │    response: content = "מעולה, יצרתי לך פנייה..."
   │  audit ai.bot_turn
   │   ↑
   │   ▼  return { reply: "מעולה...", toolCallLog: [...], modelUsed, totalTokens }
incoming-worker
   │  outboundAdapter.sendTextMessage()  ← WhatsApp Cloud API
   │  prisma.message.create  ← OUTBOUND row with toolCalls metadata
   │  publishEvent message:new  ← socket.io fan-out to inbox UIs
   ▼
Customer receives the reply
```

Latency budget: typical round trip is ~2-4s for one round, ~5-8s when a tool is called (because of round 2).

---

## 10. What changed in 2026-04 (migration notes)

- **All OpenAI calls moved to AI service.** Worker no longer imports `openai`. The bot path now goes through `POST /api/ai-bot/reply`. The one-shot path (comment-trigger) goes through `POST /api/ai-bot/oneshot`.
- **`services/incoming-worker/src/services/knowledge-retrieval.service.ts`** is now dead code - nothing imports it. Safe to delete.
- **`services/auth/src/routes/onboarding.ts`** still has a direct OpenAI client - pending migration.
- **Debug route** (`/api/ai-debug/prompt`) added for inspecting the assembled prompt + tools before it hits OpenAI.
