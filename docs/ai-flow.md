# AI Prompt-Building Flow

How ChatCenter generates, stores, and uses AI copilot configuration.

## Overview

```
Onboarding                          Runtime
─────────                           ───────
BusinessProfile ─┐                  Conversation
Departments ─────┤                       │
                 ▼                       ▼
       agent-config-generator     getEffectiveCopilotConfig()
                 │                       │
                 ▼                       ▼
     DepartmentCopilotConfig ────► OpenAI Provider
         (structured blocks          │
          + systemPrompt)            ▼
                                 Suggestions / Summary
```

## 1. Config Generation (Onboarding)

**Trigger:** Admin completes the onboarding wizard (business profile + departments + AI chat), or explicitly calls `POST /api/ai-assist/generate-configs`.

**File:** `services/ai/src/services/agent-config-generator.ts`

**Process:**
1. Load the tenant's `BusinessProfile` (industry, priority, description)
2. Load the `Department` settings (SLA, escalation rules, etc.)
3. Generate four structured blocks per department:
   - **identity** — role, responsibility, representation guidelines
   - **goals** — focus area, SLA awareness, quality expectations
   - **tone** — formality, empathy, assertiveness, brand alignment
   - **behavioral** — escalation triggers, forbidden actions, safety boundaries, confidence handling
4. Assemble blocks into a `systemPrompt` string (markdown-formatted sections)
5. Upsert into `DepartmentCopilotConfig` (both structured blocks AND assembled prompt)

## 2. Config Tables

### CopilotConfig (tenant-level)
- One per tenant, created during onboarding completion
- Acts as the fallback when a department has no config
- Stores: systemPrompt, rules, tools, model, provider, temperature, maxTokens, copilotMode
- Also stores structured blocks (identity/goals/tone/behavioral) as optional fields

### DepartmentCopilotConfig (department-level)
- One per department, created by the config generator
- Primary source of truth for AI behavior
- Same fields as CopilotConfig plus department-specific overrides
- `copilotMode` controls output format: `READY_MESSAGE` or `CONTEXT_ONLY`

## 3. Runtime Config Resolution

**File:** `services/ai/src/services/ai-assist.service.ts` — `getEffectiveCopilotConfig()`

**Resolution chain (2 steps):**
1. **DepartmentCopilotConfig** (if departmentId is available)
   - If `systemPrompt` is non-empty → use it directly
   - If `systemPrompt` is empty but structured blocks exist → reassemble from blocks via `assembleFromBlocks()`
2. **CopilotConfig** (tenant-level fallback)

Returns a `CopilotConfigData` object with: systemPrompt, rules, tools, model, provider, temperature, maxTokens, isActive, copilotMode.

## 4. OpenAI Provider — Message Structure

**File:** `services/ai/src/services/openai.provider.ts`

The provider builds an OpenAI chat completion request with this structure:

```
┌─────────────────────────────────────────────┐
│ System Message                              │
│  config.systemPrompt + rules (if any)       │
├─────────────────────────────────────────────┤
│ User Message: Conversation Transcript       │
│  [Customer - Name]: message text            │
│  [Agent - Name]: message text               │
│  [Customer - Name]: message text            │
├─────────────────────────────────────────────┤
│ User Message: Mode Instruction              │
│  (varies by copilotMode — see below)        │
│  + JSON format instruction                  │
└─────────────────────────────────────────────┘
```

**Key design choice:** All conversation messages are sent as a single `role: "user"` message with `[Customer]` / `[Agent]` labels. This prevents OpenAI from confusing agent messages with its own prior responses.

## 5. CopilotMode Behavior

### READY_MESSAGE (default)
- Mode instruction asks for 2-3 reply options the agent could send
- Response type: `"reply"` suggestions
- Used when agents need draft messages to send to customers

### CONTEXT_ONLY
- Mode instruction asks for analysis: key points, sentiment, suggested next actions
- Response type: `"info"` suggestions (no draft replies)
- Used when agents need context/analysis but will write their own responses

## 6. End-to-End Flow

```
1. Agent opens a conversation in the UI
2. Frontend calls GET /api/ai-assist/:conversationId/suggestions
3. Route loads last 20 messages from the database
4. getEffectiveCopilotConfig() resolves the config (dept → tenant fallback)
5. OpenAI provider builds: system prompt + transcript + mode instruction
6. OpenAI returns JSON with suggestions array
7. Suggestions displayed in the CoPilot panel
```
