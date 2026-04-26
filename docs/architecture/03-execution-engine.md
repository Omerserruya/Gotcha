# 03 — Execution Engine

One entry point, one dispatch path, one HITL evaluator, one routing evaluator. No forks. No drift.

Code in this document is TypeScript-level. Paths reference `packages/shared/src/engine/*` (new directory).

---

## 1. `executeAgentTurn` — the single entry point

**Location:** `packages/shared/src/engine/execute-agent-turn.ts`

Both the bot (`services/incoming-worker`) and the assist UI (`services/ai/routes/ai-assist.ts`) call this function. No other agent-execution paths exist.

```ts
export type AgentMode = "AUTO" | "ASSIST";

export interface AgentTurnInput {
  tenantId: string;
  conversationId: string;
  aiAgentId: string;
  mode: AgentMode;
  /** The newest customer message. Null for re-entry (e.g. resume after unclaim). */
  latestMessage: InboundMessage | null;
  /** Explicit trigger reason for audit. */
  triggeredBy: "inbound_message" | "human_opened_inbox" | "scheduled_followup" | "resume_after_unclaim";
}

export type AgentTurnOutput =
  | { kind: "reply";              body: string;                toolCalls: ExecutedToolCall[] }
  | { kind: "suggestions";        items: Suggestion[];         proposedToolCalls: ProposedToolCallRef[]; summary?: string }
  | { kind: "escalated";          reason: string;              summary: string; priority: "low"|"medium"|"high" }
  | { kind: "awaiting_approval";  approvalRequestId: string;   tool: string }
  | { kind: "closed";             reason: string;              summary: string }
  | { kind: "no_op";              reason: string };

export async function executeAgentTurn(input: AgentTurnInput): Promise<AgentTurnOutput> {
  const start = Date.now();
  const trace: TurnTrace = { toolsOffered: [], toolCalls: [] };

  // 1. Load agent + verify capability for requested mode
  const agent = await loadAgent(input.tenantId, input.aiAgentId);
  if (!agent.capabilities[input.mode.toLowerCase()]) {
    return { kind: "no_op", reason: `agent not capable of ${input.mode}` };
  }

  // 2. Load (or create) prompt version snapshot
  const promptVersion = await resolvePromptVersion(agent);

  // 3. Context assembly (messages + RAG + intakeFacts)
  //    NOT long-term memory. Spec §9 defers that.
  const context = await buildContext({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    agent,
    latestMessage: input.latestMessage,
  });

  // 4. Build tool surface for this (tenant, agent, mode)
  const tools = await buildToolSurface({
    tenantId: input.tenantId,
    aiAgentId: agent.id,
    mode: input.mode,
  });
  trace.toolsOffered = tools.map(t => t.name);

  // 5. Pre-flight deterministic escalation gates
  const gateHit = evaluateEscalationGates({
    agent,
    context,
    message: input.latestMessage,
  });
  if (gateHit) {
    const out: AgentTurnOutput = { kind: "escalated", reason: gateHit.reason, summary: gateHit.summary, priority: gateHit.priority };
    await writeTurnLog({ input, promptVersion, out, trace, start });
    return out;
  }

  // 6. LLM loop — up to 3 rounds of tool calls then final reply
  //    ASSIST mode: tool calls are PROPOSED, not executed. The LLM sees
  //    the same tool surface but we short-circuit dispatch to stage
  //    ProposedToolCall rows instead.
  const llmOut = await runLlmLoop({
    mode: input.mode,
    agent,
    promptVersion,
    context,
    tools,
    trace,
  });

  // 7. Shape final output per mode
  const out: AgentTurnOutput = shapeOutput(input.mode, llmOut, trace);

  // 8. Persist turn log
  await writeTurnLog({ input, promptVersion, out, trace, start });
  return out;
}
```

---

## 2. Tool surface construction

**Location:** `packages/shared/src/engine/tool-surface.ts`

Single function returns the exact tool list the LLM sees. Used for BOTH modes — `allowedModes` filtering is the only mode-specific branching.

```ts
export async function buildToolSurface(opts: {
  tenantId: string;
  aiAgentId: string;
  mode: AgentMode;
}): Promise<ToolSpec[]> {
  // Static system tools (always available, both modes)
  const system: ToolSpec[] = [
    STATIC_TOOLS.link_customer_identifier,
    STATIC_TOOLS.escalate_to_human,
    STATIC_TOOLS.close_conversation,           // NEW — see §6
    STATIC_TOOLS.interactive_reply,            // NEW — see §7
  ];

  // Dynamic integration tools (per-agent grant)
  const grants = await prisma.agentToolPermission.findMany({
    where: {
      tenantId: opts.tenantId,
      aiAgentId: opts.aiAgentId,
      isAllowed: true,
      tenantTool: {
        isEnabled: true,
        tenantIntegration: { status: "CONNECTED" },
      },
    },
    include: {
      tenantTool: { include: { catalogTool: true } },
    },
  });

  const integration = grants
    .filter(g => (g.tenantTool.catalogTool.allowedModes as AgentMode[]).includes(opts.mode))
    .map(g => ({
      name: `integration_${g.tenantTool.catalogTool.slug}`,
      description: g.tenantTool.catalogTool.description,
      whenToUse: g.tenantTool.catalogTool.whenToUse,
      exampleUsage: g.tenantTool.catalogTool.exampleUsage,
      parameters: g.tenantTool.catalogTool.inputSchema,
      tenantToolId: g.tenantTool.id,
      catalogToolId: g.tenantTool.catalogTool.id,
    }));

  // Filter static tools by allowedModes too (e.g. send_message is AUTO only)
  return [...system, ...integration]
    .filter(t => modeAllows(t, opts.mode));
}
```

Tool names follow `[a-zA-Z0-9_-]+` per OpenAI's regex — underscores only, no dots.

---

## 3. Tool dispatch

**Location:** `packages/shared/src/engine/tool-dispatch.ts`

Called by `runLlmLoop` when the LLM emits a tool call.

```ts
export async function dispatchTool(
  mode: AgentMode,
  toolCall: { id: string; name: string; args: unknown },
  ctx: DispatchContext
): Promise<DispatchResult> {
  // 1. Resolve static vs integration
  const resolved = resolveToolByName(toolCall.name, ctx);
  if (!resolved) {
    return structuredError(toolCall.id, "unknown_tool", `unknown tool: ${toolCall.name}`);
  }

  // 2. HITL gate — SAME evaluator for both modes
  const policy = await evaluatePolicies({
    tenantId: ctx.tenantId,
    aiAgentId: ctx.aiAgentId,
    tool: resolved,
    args: toolCall.args,
  });

  if (policy.decision === "DENY") {
    return structuredError(toolCall.id, "denied", policy.reason);
  }

  if (policy.decision === "REQUIRE_APPROVAL") {
    // Create an approval request. Behavior differs by mode:
    //   AUTO  → pause the conversation, return awaiting_approval side-effect
    //   ASSIST → stage as ProposedToolCall, human accepts/rejects inline
    if (mode === "AUTO") {
      const approval = await createApprovalRequest({
        tenantId: ctx.tenantId,
        conversationId: ctx.conversationId,
        tool: resolved.name,
        params: toolCall.args,
        policySnapshot: policy.snapshot,
        reason: policy.reason,
      });
      return { kind: "awaiting_approval", approvalRequestId: approval.id, policy };
    } else {
      const proposal = await stageProposedToolCall({
        tenantId: ctx.tenantId,
        conversationId: ctx.conversationId,
        tenantToolId: resolved.tenantToolId,
        name: resolved.name,
        args: toolCall.args,
        policySnapshot: policy.snapshot,
      });
      return { kind: "proposed", proposedToolCallId: proposal.id, policy };
    }
  }

  // 3. ASSIST mode: even APPROVE decisions are staged for human review
  //    unless the tool is a "suggestion-only" tool (close_conversation,
  //    interactive_reply — filtered out of ASSIST surface already).
  if (mode === "ASSIST" && resolved.kind === "integration") {
    const proposal = await stageProposedToolCall({
      tenantId: ctx.tenantId,
      conversationId: ctx.conversationId,
      tenantToolId: resolved.tenantToolId,
      name: resolved.name,
      args: toolCall.args,
      policySnapshot: policy.snapshot,
    });
    return { kind: "proposed", proposedToolCallId: proposal.id, policy };
  }

  // 4. AUTO mode: execute for real
  const result = await executeResolvedTool(resolved, toolCall.args, ctx, policy);
  return result;
}
```

### 3.1 Integration execution

Delegates to the existing `services/ai/.../tool-execution.service.ts::executeTool`. That function already handles:
- endpoint URL resolution (relative + `baseUrl` prefix, `:param` substitution)
- auth scheme (Bearer vs Zoho-oauthtoken)
- token refresh (Zoho)
- audit + usage tracking
- structured error shape

Add: honor `catalogTool.timeoutMs`, `maxRetries`, `retryBackoffMs`, `circuitBreakerThreshold`.

### 3.2 Static execution

`close_conversation`, `escalate_to_human`, `link_customer_identifier`, `interactive_reply`, `send_message` dispatched via their existing handlers. `close_conversation` pre-flight checks (§6) live in the dispatcher, not the LLM.

---

## 4. `evaluatePolicies` — THE single HITL layer

**Location:** `packages/shared/src/engine/evaluate-policies.ts`

```ts
export type Decision = "ALLOW" | "REQUIRE_APPROVAL" | "DENY";
export interface PolicyResult {
  decision: Decision;
  reason: string;
  snapshot: PolicySnapshot;      // denormalized, persisted with ApprovalRequest/ProposedToolCall
  effective: {
    mode: "never" | "always" | "on_condition";
    approverRole?: string;
  };
}

export async function evaluatePolicies(opts: {
  tenantId: string;
  aiAgentId: string;
  tool: ResolvedTool;
  args: unknown;
}): Promise<PolicyResult> {
  // Resolve the three layers
  const catalog: HitlPolicy = opts.tool.catalogTool.hitlPolicy;
  const tenant:  HitlPolicy | null = opts.tool.tenantTool?.configOverrides?.hitlPolicy ?? null;
  const agent:   { requireApproval?: boolean; approverRole?: string } = await loadAgentPermission(opts);

  // Compose with strictest-wins
  const effective = composeStrictest(catalog, tenant, agent);

  // Static DENY: tenant can explicitly disable
  if (opts.tool.tenantTool?.isEnabled === false) {
    return deny("tool disabled at tenant level", { catalog, tenant, agent });
  }
  if (agent.requireApproval === undefined && opts.tool.grant && !opts.tool.grant.isAllowed) {
    return deny("tool not granted to this agent", { catalog, tenant, agent });
  }

  // Effective mode → decision
  switch (effective.mode) {
    case "never":  return allow(effective, { catalog, tenant, agent });
    case "always": return requireApproval(effective, "policy: always approve", { catalog, tenant, agent });
    case "on_condition": {
      const hit = evalCondition(effective.condition!, opts.args);
      return hit
        ? requireApproval(effective, "condition matched", { catalog, tenant, agent })
        : allow(effective, { catalog, tenant, agent });
    }
  }
}

// Strictest-wins composition:
//   DENY > ALWAYS > ON_CONDITION > NEVER
function composeStrictest(
  catalog: HitlPolicy,
  tenant: HitlPolicy | null,
  agent: { requireApproval?: boolean; approverRole?: string }
): EffectivePolicy {
  let mode: HitlMode = catalog.mode;
  let condition = catalog.condition;
  let approverRole = catalog.approverRole;

  if (tenant) {
    if (strictnessRank(tenant.mode) > strictnessRank(mode)) {
      mode = tenant.mode;
      condition = tenant.condition;
    }
    if (tenant.approverRole && rankRole(tenant.approverRole) > rankRole(approverRole)) {
      approverRole = tenant.approverRole;
    }
  }

  if (agent.requireApproval && strictnessRank("always") > strictnessRank(mode)) {
    mode = "always";
  }
  if (agent.approverRole && rankRole(agent.approverRole) > rankRole(approverRole)) {
    approverRole = agent.approverRole;
  }

  return { mode, condition, approverRole };
}
```

**Rank (strict to lax):** `DENY(3) > always(2) > on_condition(1) > never(0)`.
**Role rank:** `admin(3) > supervisor(2) > billing(1) > any(0)`.

No other place in the codebase may make HITL decisions. No `HIGH_RISK_TOOLS` constant. No secondary check.

---

## 5. Routing evaluation

**Location:** `packages/shared/src/engine/evaluate-routing.ts`

Called from `services/incoming-worker` on inbound message and from `services/auth` on channel creation (for testing).

```ts
export interface RoutingOutcome {
  matchedRuleId: string | null;
  routeType: RouteType | "FALLBACK";
  aiAgentId?: string;
  routineId?: string;
  departmentId?: string;
  trace: RoutingTrace[];          // for admin /router-rules/test
}

export async function evaluateRouting(opts: {
  tenantId: string;
  conversationId: string;
  message: string;
  channel: string;
  tags?: string[];
}): Promise<RoutingOutcome> {
  const rules = await prisma.routerRule.findMany({
    where: { tenantId: opts.tenantId, enabled: true },
    orderBy: { position: "asc" },
  });

  // Default rules always last — regardless of position
  const ordered = [...rules.filter(r => !r.isDefault), ...rules.filter(r => r.isDefault)];

  // Batch-resolve intent conditions in ONE LLM call
  const allIntents = unique(
    ordered.flatMap(r => (r.conditions as Cond[]).filter(c => c.type === "intent").map(c => c.value))
  );
  const intentHits: Set<string> = allIntents.length
    ? await checkIntentsBatch(opts.message, allIntents, opts.tenantId)
    : new Set();

  const trace: RoutingTrace[] = [];
  for (const rule of ordered) {
    const result = evaluateRule(rule, { message: opts.message, channel: opts.channel, tags: opts.tags ?? [], intentHits });
    trace.push({ ruleId: rule.id, name: rule.name, matched: result.matched, condResults: result.condResults });
    if (!result.matched) continue;

    // First match wins
    return {
      matchedRuleId: rule.id,
      routeType: rule.routeType,
      aiAgentId: rule.aiAgentId ?? undefined,
      routineId: rule.routineId ?? undefined,
      departmentId: rule.departmentId ?? undefined,
      trace,
    };
  }

  // No rule matched → tenant fallback ladder
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: opts.tenantId } });
  if (tenant.defaultAgentId)   return { matchedRuleId: null, routeType: "AGENT",   aiAgentId: tenant.defaultAgentId,   trace };
  if (tenant.defaultRoutineId) return { matchedRuleId: null, routeType: "ROUTINE", routineId:  tenant.defaultRoutineId, trace };
  if (tenant.defaultQueue)     return { matchedRuleId: null, routeType: "HUMAN",   departmentId: tenant.defaultQueue,  trace };
  return                              { matchedRuleId: null, routeType: "FALLBACK", trace };
}

function evaluateRule(rule: RouterRule, ctx: EvalCtx): { matched: boolean; condResults: boolean[] } {
  if (rule.isDefault) return { matched: true, condResults: [] };
  const conditions = rule.conditions as Cond[];
  if (!conditions.length) return { matched: true, condResults: [] };

  const condResults = conditions.map(c => {
    if (c.type === "intent")  return c.operator === "is_not" ? !ctx.intentHits.has(c.value) : ctx.intentHits.has(c.value);
    if (c.type === "keyword") return matchKeyword(c, ctx.message);
    if (c.type === "channel") return matchChannel(c, ctx.channel);
    if (c.type === "tag")     return matchTag(c, ctx.tags);
    return false;
  });

  const matched = rule.logic === "OR" ? condResults.some(Boolean) : condResults.every(Boolean);
  return { matched, condResults };
}
```

### 5.1 `POST /api/router-rules/test`

```ts
router.post("/test", authenticate, requireRole("ADMIN"), async (req, res) => {
  const { message, channel, tags } = req.body;
  const outcome = await evaluateRouting({
    tenantId: req.tenantId!,
    conversationId: "dryrun",
    message,
    channel: channel ?? "WHATSAPP",
    tags,
  });
  res.json({ data: outcome }); // full trace visible to admin
});
```

Admin UI renders the trace: ✓/✗ per condition per rule + which rule matched + what the effective route is.

---

## 6. `close_conversation` — precondition enforcement

Added to the static tool registry. Available in AUTO mode only; in ASSIST the human uses the UI.

```ts
async function closeConversation(args: { conversationId: string; reason: string; summary: string }, ctx: DispatchContext) {
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: args.conversationId } });
  if (conv.tenantId !== ctx.tenantId) throw new Error("cross-tenant close blocked");

  // Server-side preconditions (per spec §7):
  const pending = await Promise.all([
    prisma.approvalRequest.count({ where: { conversationId: conv.id, status: "PENDING" } }),
    prisma.proposedToolCall.count({ where: { conversationId: conv.id, status: "PENDING" } }),
    prisma.scheduledFollowup.count({ where: { conversationId: conv.id, status: "SCHEDULED" } }),
  ]);
  const [approvals, proposals, followups] = pending;
  if (approvals || proposals || followups) {
    return {
      ok: false,
      error: "preconditions_not_met",
      details: { approvals, proposals, followups },
    };
  }

  await prisma.conversation.update({
    where: { id: conv.id },
    data: { status: "CLOSED", handledBy: "ai_auto" },
  });
  return { ok: true };
}
```

---

## 7. `interactive_reply` — channel UX

Replaces the flow-engine's "Quick Reply" / "List Message" nodes for channels that support them (WhatsApp, IG, Messenger). Generated by the Agent, not by Routines.

Schema per input:
```json
{
  "body": "string",
  "action": {
    "type": "button" | "list",
    "buttons": [{ "id", "title" }],
    "list": { "header", "sections": [{ "title", "rows": [{ "id", "title", "description?" }] }] }
  }
}
```

Dispatcher renders the platform-specific payload (WhatsApp interactive, Messenger quick replies, IG quick replies) and enqueues via the existing outbound adapter. `send_message` is deprecated for interactive content — the LLM should call `interactive_reply` when offering choices.

---

## 8. Assist mode: Proposed tool call acceptance

**Location:** `services/ai/routes/proposed-tool-calls.ts`

```
POST /api/ai-assist/:conversationId/proposed-tool-calls/:id/accept
POST /api/ai-assist/:conversationId/proposed-tool-calls/:id/reject
GET  /api/ai-assist/:conversationId/proposed-tool-calls?status=PENDING
```

On accept:
1. Load `ProposedToolCall` by id, scoped to tenant.
2. If expired, return `410`.
3. **Re-run `evaluatePolicies()`** (policy may have tightened since staging).
4. If now DENY, mark proposal REJECTED and return 403.
5. If still REQUIRE_APPROVAL and the acceptor's role doesn't satisfy `approverRole`, return 403.
6. Execute the tool via `executeResolvedTool` using the SERVER-SIDE args from the proposal (client-sent args ignored).
7. Write a `ToolExecution` row.
8. Mark proposal `ACCEPTED` with `executionId`.

Never trust client-passed arguments. Always use the stored `args`.

---

## 9. Turn log shape

Every successful or failed call to `executeAgentTurn` writes exactly one row:

```ts
await prisma.agentTurnLog.create({
  data: {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    aiAgentId: input.aiAgentId,
    mode: input.mode,
    promptVersionId: promptVersion.id,
    toolsOffered: trace.toolsOffered,
    toolCalls: trace.toolCalls,
    finalOutput: out,
    durationMs: Date.now() - start,
    tokenUsage: trace.tokenUsage ?? {},
  },
});
```

---

## 10. Tenant isolation contract

Every function above:
- Accepts `tenantId` explicitly.
- Passes it to every Prisma query's `where`.
- Never reads from DB without it.

`TenantGuard` middleware in `packages/shared/src/lib/prisma.ts` rejects any query missing `tenantId`. Escape hatch: `withCrossTenantAccess(() => …)` — only used by cross-tenant analytics jobs.

---

## 11. Failure semantics

| Failure | Response | Side effect |
|---|---|---|
| LLM timeout | `{ kind: "escalated", reason: "llm_timeout" }` | conversation → PAUSED |
| Tool DENY | passed back as `tool` message → LLM reasons around it | turn log records decision |
| Tool timeout | retried per `maxRetries`, then returned as error | circuit-breaker counter incremented |
| HITL DENY | same as Tool DENY | ApprovalRequest NOT created |
| REQUIRE_APPROVAL (AUTO) | `{ kind: "awaiting_approval" }` | conversation → PAUSED, ApprovalRequest created |
| REQUIRE_APPROVAL (ASSIST) | `{ kind: "suggestions", proposedToolCalls: [...] }` | ProposedToolCall staged; human acts in UI |
| `close_conversation` preconditions not met | LLM sees structured error, can reason | conversation stays OPEN |
| Routine node type not supported (Phase 7+) | `{ kind: "escalated", reason: "routine_node_type_not_supported" }` | flow id logged |

---

## 12. What this replaces in the codebase

| New | Old |
|---|---|
| `executeAgentTurn` | `services/incoming-worker/.../ai-bot.service.ts::processAIBot` **and** `services/ai/.../ai-assist.service.ts::getSuggestionsForConversation` |
| `buildToolSurface` | `buildAgentTools` + `buildAgentToolsForAIAgent` (merged) |
| `dispatchTool` | `dispatchToolCall` + integration branch (merged into one) |
| `evaluatePolicies` | `evaluateToolGate` + `HIGH_RISK_TOOLS` constant + `TenantToolPermission` lookup (merged) |
| `evaluateRouting` | `routeConversation` in `routing.service.ts` (rewritten, no priority) |

Old paths are kept as thin shims during Phase 4 that delegate to the new functions. Removed in Phase 8.
