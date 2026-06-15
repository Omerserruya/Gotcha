# 01 - Final Unified Schema

Target state after all migration phases complete. This is what `packages/shared/prisma/schema.prisma` must look like after phase 8.

All models here are tenant-scoped unless explicitly noted. Indexes for tenant isolation and common access paths are included.

---

## 1. `AIAgent` - the single source of truth

Absorbs everything previously spread across `AIAgent` + `CopilotConfig` + per-department copilot overrides.

```prisma
enum AgentStatus { DRAFT ACTIVE PAUSED ARCHIVED }

model AIAgent {
  id             String       @id @default(cuid())
  tenantId       String       @map("tenant_id")
  departmentId   String?      @map("department_id")

  // Identity
  name           String
  role           String        // "customer_support" | "sales" | "booking" | ...
  description    String?
  avatarColor    String?       @map("avatar_color")
  status         AgentStatus   @default(DRAFT)

  // Capabilities - which modes this agent can run in
  // Both can be true. Mode is runtime; capability is config.
  capabilities   Json          @default("{\"auto\":true,\"assist\":true}")
  //   { auto: boolean, assist: boolean }

  // Tone / style
  tone           String        @default("friendly")
  style          Json          @default("{}")
  //   { useEmojis, concise, useFirstName, proactive }
  languages      Json          @default("{\"english\":true}")

  // Prompt fragments (regenerated via promptAssembler on save)
  sharedPrompt       String?   @map("shared_prompt")   @db.Text
  autonomousPrompt   String?   @map("autonomous_prompt") @db.Text
  assistPrompt       String?   @map("assist_prompt")   @db.Text

  // Suggestion config (absorbed from CopilotConfig)
  suggestionStyle    String?   @map("suggestion_style")
  maxSuggestions     Int       @default(3) @map("max_suggestions")
  summaryEnabled     Boolean   @default(true) @map("summary_enabled")

  // Model tuning
  model          String        @default("gpt-4o-mini")
  temperature    Float         @default(0.7)
  maxTokens      Int           @default(1024) @map("max_tokens")

  // Anchors (guidance, NOT gates)
  behavioralAnchors Json       @default("[]") @map("behavioral_anchors")
  //   [{ id, condition, intent, guidance }]

  // Escalation - two shapes to end the dual-purpose today:
  //   gates   = deterministic triggers (max msgs, keyword list) - part of HITL
  //   anchors = LLM-judged hints - part of behavioralAnchors
  escalationGates   Json       @default("[]") @map("escalation_gates")
  //   [{ type: "max_messages"|"keyword"|"max_minutes",
  //      value: number|string[], enabled: bool }]

  // Channel allowlist (which channels this agent may handle)
  channels       Json          @default("[\"whatsapp\",\"webchat\",\"gmail\",\"messenger\"]")

  createdAt      DateTime      @default(now()) @map("created_at")
  updatedAt      DateTime      @updatedAt @map("updated_at")

  tenant           Tenant                  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  department       Department?             @relation(fields: [departmentId], references: [id], onDelete: SetNull)
  knowledgeBases   AIAgentKnowledge[]
  toolPermissions  AgentToolPermission[]
  promptVersions   AIAgentPromptVersion[]
  conversations    Conversation[]          @relation("AgentAssignment")

  @@index([tenantId, status])
  @@index([tenantId, departmentId])
  @@map("ai_agents")
}
```

---

## 2. `AIAgentPromptVersion` - snapshot per publish

Enables replay and "why did the bot answer differently yesterday" debugging.

```prisma
model AIAgentPromptVersion {
  id             String   @id @default(cuid())
  tenantId       String   @map("tenant_id")
  aiAgentId      String   @map("ai_agent_id")
  promptHash     String   @map("prompt_hash")    // sha256 of assembled fragments
  fragments      Json     // { sharedPrompt, autonomousPrompt, assistPrompt, anchors, tools, version }
  schemaVersion  Int      @default(1) @map("schema_version")
  createdAt      DateTime @default(now()) @map("created_at")

  aiAgent        AIAgent @relation(fields: [aiAgentId], references: [id], onDelete: Cascade)
  turnLogs       AgentTurnLog[]

  @@unique([aiAgentId, promptHash])
  @@index([tenantId, aiAgentId])
  @@map("ai_agent_prompt_versions")
}
```

---

## 3. `CatalogTool` - tool definition (floor for HITL)

Expanded to carry full tool contract + hitl policy + runtime limits.

```prisma
enum ToolCategory { READ WRITE DELETE ACTION }
enum RiskLevel    { LOW MEDIUM HIGH }
enum ToolMode     { AUTO ASSIST }

model CatalogTool {
  id             String        @id @default(cuid())
  integrationId  String        @map("integration_id")
  slug           String
  name           String
  description    String

  // NEW - required per spec §4.3
  whenToUse      String?       @map("when_to_use")    @db.Text
  exampleUsage   Json?         @map("example_usage")
  //   [{ input: {...}, output: {...}, note: "..." }]

  category       ToolCategory  @default(READ)
  riskLevel      RiskLevel     @default(LOW) @map("risk_level")

  // NEW - which modes this tool is valid in
  allowedModes   Json          @default("[\"AUTO\",\"ASSIST\"]") @map("allowed_modes")
  //   ["AUTO"] | ["ASSIST"] | ["AUTO","ASSIST"]

  // I/O contract
  inputSchema    Json          @default("{}") @map("input_schema")
  outputSchema   Json          @default("{}") @map("output_schema")
  endpoint       String?
  method         String        @default("GET")

  // HITL - the FLOOR. Tenant / agent can only tighten.
  hitlPolicy     Json          @default("{\"mode\":\"never\"}") @map("hitl_policy")
  //   { mode: "never" | "always" | "on_condition",
  //     condition?: string,        // JSONLogic/CEL-like
  //     approverRole?: string,
  //     notifyChannels?: string[] }

  // Runtime limits
  timeoutMs                  Int  @default(10000) @map("timeout_ms")
  maxRetries                 Int  @default(0)     @map("max_retries")
  retryBackoffMs             Int  @default(1000)  @map("retry_backoff_ms")
  circuitBreakerThreshold    Int? @map("circuit_breaker_threshold")

  // Versioning
  schemaVersion  Int           @default(1) @map("schema_version")

  isDefault      Boolean       @default(true) @map("is_default")
  sortOrder      Int           @default(0)    @map("sort_order")
  createdAt      DateTime      @default(now()) @map("created_at")
  updatedAt      DateTime      @updatedAt @map("updated_at")

  integration    IntegrationCatalog @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  tenantTools    TenantTool[]

  @@unique([integrationId, slug])
  @@index([integrationId])
  @@map("catalog_tools")
}
```

---

## 4. `TenantTool` - per-tenant activation + tenant-level HITL override

`TenantToolPermission` is **deleted**. Tenant-wide hitl overrides move into `TenantTool.configOverrides.hitlPolicy`.

```prisma
model TenantTool {
  id                  String   @id @default(cuid())
  tenantId            String   @map("tenant_id")
  tenantIntegrationId String   @map("tenant_integration_id")
  catalogToolId       String   @map("catalog_tool_id")

  isEnabled           Boolean  @default(true) @map("is_enabled")

  // Tenant-level overrides. Only "tightening" keys are honored by evaluatePolicies().
  configOverrides     Json     @default("{}") @map("config_overrides")
  //   Recognised keys (all optional):
  //     { hitlPolicy?: { mode, condition?, approverRole? },     // can only tighten
  //       allowedModes?: ToolMode[],                             // can only narrow
  //       timeoutMs?, maxRetries?,                               // can only shrink
  //       baseUrl?, authScheme?, tokenRefreshUrl?,               // provider-specific
  //       headers?: Record<string,string> }

  createdAt           DateTime @default(now()) @map("created_at")
  updatedAt           DateTime @updatedAt @map("updated_at")

  tenantIntegration TenantIntegration   @relation(fields: [tenantIntegrationId], references: [id], onDelete: Cascade)
  catalogTool       CatalogTool         @relation(fields: [catalogToolId], references: [id], onDelete: Cascade)
  agentPermissions  AgentToolPermission[]
  executions        ToolExecution[]

  @@unique([tenantIntegrationId, catalogToolId])
  @@index([tenantId, isEnabled])
  @@map("tenant_tools")
}
```

---

## 5. `AgentToolPermission` - per-agent grant + per-agent HITL override

Last layer. Can also only tighten, not loosen.

```prisma
model AgentToolPermission {
  id                 String   @id @default(cuid())
  tenantId           String   @map("tenant_id")
  aiAgentId          String   @map("ai_agent_id")
  tenantToolId       String   @map("tenant_tool_id")

  isAllowed          Boolean  @default(true) @map("is_allowed")

  // Tightening override. Merged with stricter-wins against CatalogTool + TenantTool.
  requireApproval    Boolean  @default(false) @map("require_approval")
  approverRole       String?  @map("approver_role")

  createdAt          DateTime @default(now()) @map("created_at")
  updatedAt          DateTime @updatedAt @map("updated_at")

  aiAgent            AIAgent     @relation(fields: [aiAgentId], references: [id], onDelete: Cascade)
  tenantTool         TenantTool  @relation(fields: [tenantToolId], references: [id], onDelete: Cascade)

  @@unique([aiAgentId, tenantToolId])
  @@index([tenantId, aiAgentId])
  @@map("agent_tool_permissions")
}
```

---

## 6. `RouterRule` - no priority; list-ordered first-match

```prisma
enum RouteType { AGENT ROUTINE HUMAN }

model RouterRule {
  id            String     @id @default(cuid())
  tenantId      String     @map("tenant_id")
  name          String

  // Evaluation order: lower `position` evaluates first. UI drag-to-reorder writes this.
  // `priority` is REMOVED.
  position      Int        @default(0)

  enabled       Boolean    @default(true)
  isDefault     Boolean    @default(false) @map("is_default")

  conditions    Json       @default("[]")
  //   [{ type: "intent"|"keyword"|"channel"|"tag",
  //      operator: "equals"|"contains"|"is_not",
  //      value: string }]
  logic         String     @default("AND")   // AND | OR

  routeType     RouteType
  // For AGENT: routeTargetId = AIAgent.id (via aiAgentId)
  // For ROUTINE: routeTargetId = Routine.id (must be flowType=MAIN)
  // For HUMAN: routeTargetId = Department.id or null (global queue)
  aiAgentId     String?    @map("ai_agent_id")
  routineId     String?    @map("routine_id")
  departmentId  String?    @map("department_id")

  createdAt     DateTime   @default(now()) @map("created_at")
  updatedAt     DateTime   @updatedAt @map("updated_at")

  tenant        Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, name])
  @@index([tenantId, enabled, position])
  @@map("router_rules")
}
```

Fallback resolution (after no rule matches):
```
Tenant.defaultAgentId → Tenant.defaultRoutineId → Tenant.defaultQueue → UNASSIGNED
```

---

## 7. `Routine` - formerly `ChatbotFlow`, constrained

```prisma
enum FlowType   { MAIN SUB }
enum NodeType   { START STOP CONDITION ROUTE_TO SEND_MESSAGE QUICK_REPLY }

model Routine {
  id             String   @id @default(cuid())
  tenantId       String   @map("tenant_id")
  name           String

  flowType       FlowType @default(MAIN) @map("flow_type")
  // Only SUB flows have parentRoutineId. MAIN flows have it null.
  parentRoutineId String? @map("parent_routine_id")

  // Node DAG. Every node: { id, type: NodeType, position, config, edges: [...] }
  // Save-time validation rejects any node whose `type` isn't in the allowlist for `flowType`.
  nodes          Json     @default("[]")
  edges          Json     @default("[]")

  isActive       Boolean  @default(true) @map("is_active")
  runCount       Int      @default(0)    @map("run_count")

  // Optional trigger config for MAIN routines referenced by RouterRule.
  // SUB routines have no triggers.
  triggers       Json     @default("[]")

  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  tenant        Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  parent        Routine?  @relation("RoutineParent", fields: [parentRoutineId], references: [id], onDelete: SetNull)
  children      Routine[] @relation("RoutineParent")

  @@index([tenantId, flowType, isActive])
  @@map("routines")
}
```

Save-time validators (application code, not DB):
- `flowType=MAIN` → allowed node types: `[CONDITION, ROUTE_TO, SEND_MESSAGE, QUICK_REPLY]`
- `flowType=SUB`  → allowed node types: `[START, STOP, CONDITION, ROUTE_TO, SEND_MESSAGE, QUICK_REPLY]`
- `SUB.ROUTE_TO.targetNodeId` **must** reference a node inside the same sub.
- `MAIN.ROUTE_TO.target` may be `{kind:"agent",id}` or `{kind:"sub",id}`.
- No node may invoke a tool directly. (Engine-side check too.)

---

## 8. `Tenant` - defaults for routing fallback

```prisma
model Tenant {
  // ... existing fields ...

  defaultAgentId                   String?  @map("default_agent_id")
  defaultRoutineId                 String?  @map("default_routine_id")
  defaultQueue                     String?  @map("default_queue")   // dept id, or null for global

  // Human handoff config
  autoResumeAfterUnclaimMinutes    Int?     @map("auto_resume_after_unclaim_minutes")
  //   null = never resume. Integer = resume bot autonomously after N idle minutes.

  defaultAgent    AIAgent?  @relation("TenantDefaultAgent", fields: [defaultAgentId], references: [id], onDelete: SetNull)
  defaultRoutine  Routine?  @relation("TenantDefaultRoutine", fields: [defaultRoutineId], references: [id], onDelete: SetNull)
}
```

---

## 9. `Conversation` - mode, snapshot, intake facts

```prisma
enum ConversationStatus { OPEN WAITING CLAIMED PAUSED CLOSED }
enum AgentMode          { AUTO ASSIST }

model Conversation {
  // ... existing fields ...

  status                ConversationStatus @default(OPEN)
  channel               String
  customerExternalId    String             @map("customer_external_id")

  // Which agent is on this conversation (if any)
  aiAgentId             String?            @map("ai_agent_id")
  assignedAgentId       String?            @map("assigned_agent_id")  // human user id
  routineId             String?            @map("routine_id")
  routineNodeId         String?            @map("routine_node_id")

  // NEW - mode is per-conversation, set by routing or on handoff
  mode                  AgentMode?
  modeReason            String?            @map("mode_reason")
  //   "routed_auto" | "routed_assist" | "bot_requested_handoff" | "human_unclaimed_resume" | ...

  // NEW - prompt version this conversation is running against (snapshot on start)
  promptVersionId       String?            @map("prompt_version_id")

  // NEW - structured intake facts from routines / agent extraction
  intakeFacts           Json               @default("{}") @map("intake_facts")
  //   { email?, phone?, name?, capturedBy: "routine"|"agent"|"human",
  //     capturedAt: iso, routineNodeTrail: string[] }

  handledBy             String?            @map("handled_by")  // "ai_auto" | "ai_assist" | "human" | "routine"

  createdAt             DateTime           @default(now()) @map("created_at")
  updatedAt             DateTime           @updatedAt @map("updated_at")

  aiAgent               AIAgent?           @relation("AgentAssignment", fields: [aiAgentId], references: [id], onDelete: SetNull)
  promptVersion         AIAgentPromptVersion? @relation(fields: [promptVersionId], references: [id])

  @@index([tenantId, status])
  @@index([tenantId, aiAgentId])
  @@index([tenantId, assignedAgentId])
}
```

---

## 10. `AgentTurnLog` - unified observability row

One row per call to `executeAgentTurn`. Replaces the inconsistent mix of `AuditLog` entries bot/copilot currently produce.

```prisma
model AgentTurnLog {
  id                  String   @id @default(cuid())
  tenantId            String   @map("tenant_id")
  conversationId      String   @map("conversation_id")
  aiAgentId           String   @map("ai_agent_id")

  mode                AgentMode
  promptVersionId     String?  @map("prompt_version_id")

  toolsOffered        Json     @default("[]") @map("tools_offered")
  //   string[] - tool names the LLM saw

  toolCalls           Json     @default("[]") @map("tool_calls")
  //   [{ id, name, args, policyDecision, ok, error?, durationMs }]

  finalOutput         Json     @map("final_output")
  //   { kind: "reply", body } | { kind: "suggestions", items: [...] }
  //   | { kind: "escalated", reason } | { kind: "awaiting_approval", approvalRequestId }
  //   | { kind: "closed", reason, summary }

  durationMs          Int      @map("duration_ms")
  tokenUsage          Json     @default("{}") @map("token_usage")
  createdAt           DateTime @default(now()) @map("created_at")

  promptVersion       AIAgentPromptVersion? @relation(fields: [promptVersionId], references: [id])

  @@index([tenantId, conversationId, createdAt])
  @@index([tenantId, aiAgentId, createdAt])
  @@map("agent_turn_logs")
}
```

---

## 11. `ApprovalRequest` - add policy snapshot

```prisma
model ApprovalRequest {
  // ... existing fields ...

  // NEW - snapshot of evaluatePolicies() output at creation time.
  // No FK to TenantToolPermission (which is deleted); self-contained.
  policySnapshot   Json     @map("policy_snapshot")
  //   { catalog: {...}, tenant: {...}, agent: {...}, effective: { mode, reason } }
}
```

---

## 12. `ProposedToolCall` - for assist-mode approvals

Server-side staging of tool proposals so the client can't tamper with args.

```prisma
enum ProposedToolCallStatus { PENDING ACCEPTED REJECTED EXPIRED }

model ProposedToolCall {
  id                String                 @id @default(cuid())
  tenantId          String                 @map("tenant_id")
  conversationId    String                 @map("conversation_id")
  turnLogId         String?                @map("turn_log_id")
  tenantToolId      String                 @map("tenant_tool_id")
  toolName          String                 @map("tool_name")
  args              Json
  summary           String
  policySnapshot    Json                   @map("policy_snapshot")
  status            ProposedToolCallStatus @default(PENDING)
  expiresAt         DateTime               @map("expires_at")
  createdAt         DateTime               @default(now()) @map("created_at")
  decidedAt         DateTime?              @map("decided_at")
  decidedBy         String?                @map("decided_by")
  executionId       String?                @map("execution_id")

  @@index([tenantId, conversationId, status])
  @@map("proposed_tool_calls")
}
```

---

## 13. Removed tables

| Table | Disposition |
|---|---|
| `copilot_configs` | **DROP** - fields absorbed into `AIAgent`. |
| `tenant_tool_permissions` | **DROP** - fields moved to `TenantTool.configOverrides`. |
| `chatbot_flows` | **RENAME** to `routines` (schema above). |
| `chatbot_flow_runs` | **RENAME** to `routine_runs`. |

## 14. Removed fields

| Location | Field | Reason |
|---|---|---|
| `router_rules` | `priority` | Replaced by `position`. |
| `ai_agents` | `conversationFlow` | Merged into `behavioralAnchors`. |
| `ai_agents` | `autonomousEnabled` | Replaced by `capabilities.auto`. |
| `ai_agents` | `customGuardrails` | Merged into `behavioralAnchors` or `escalationGates`. |

## 15. Constraints enforced in application code (not DB)

- Strictest HITL wins across `CatalogTool.hitlPolicy` → `TenantTool.configOverrides.hitlPolicy` → `AgentToolPermission.requireApproval`.
- Routine save-time node allowlist per `flowType`.
- Routine `ROUTE_TO` targets validated per scope (§7).
- Routines never dispatch tools.
- `capabilities` honored by `executeAgentTurn`.
- `allowedModes` on `CatalogTool` filters the tool surface per mode.
