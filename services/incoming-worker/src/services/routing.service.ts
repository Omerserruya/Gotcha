/**
 * Routing engine — list-ordered, first-match-wins.
 *
 * Replaces the previous priority-sorted evaluator. Key behaviors:
 *
 *   1. Rules are evaluated in `position` order (ASC). Default rules (isDefault=true)
 *      always evaluate LAST regardless of position — they are the explicit catch-all.
 *   2. First match wins. Subsequent rules are never evaluated. This is the same
 *      semantic as before but without a numeric priority field — UI drag-to-reorder
 *      writes `position`.
 *   3. AI-intent conditions across ALL rules are batched into a single LLM call,
 *      so a tenant with 10 intent-based rules pays 1 LLM call per inbound, not 10.
 *   4. When no rule matches, fall back to the tenant's explicit ladder:
 *         defaultAgentId → defaultRoutineId → defaultDepartmentId → unassigned.
 *   5. Every evaluation produces a trace (per-rule, per-condition results) available
 *      for the POST /api/router-rules/test admin endpoint.
 */
import { prisma, analyticsQueue, publishEvent } from "@chatcenter/shared";
import { processAIBot } from "./ai-bot.service";
import { processChatbotFlow } from "./chatbot-engine.service";
import { executeMainFlow } from "./flow-executor.service";

// ─── Types ───────────────────────────────────────────────────

export interface RoutingResult {
  departmentId: string | null;
  assignedAgentId: string | null;
  handledByAI: boolean;
  intent: string;
  matchedRule: string | null;
  fallback?: "default_agent" | "default_routine" | "default_department" | "unassigned";
  trace: RoutingTraceEntry[];
}

export interface RoutingTraceEntry {
  ruleId: string;
  name: string;
  isDefault: boolean;
  matched: boolean;
  condResults: { type: string; operator?: string; value: string; result: boolean }[];
  stopped?: true; // true on the rule that won
}

interface RuleCondition {
  type: "intent" | "keyword" | "channel" | "tag";
  operator?: "equals" | "contains" | "is_not";
  value: string;
}

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://ai:4006";

// ─── Batched AI intent classification ────────────────────────
// Single LLM call returns the set of intents that match the message. A rule
// with `{type:"intent", operator:"equals", value:"sales"}` then just checks
// whether "sales" is in the returned set. This collapses N calls into 1.

async function checkIntentsBatch(
  message: string,
  intents: string[],
  tenantId: string,
): Promise<Set<string>> {
  if (intents.length === 0) return new Set();
  try {
    const res = await fetch(`${AI_SERVICE_URL}/api/ai-assist/intent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026",
      },
      body: JSON.stringify({ message, intents, tenantId }),
    });
    if (!res.ok) throw new Error(`ai intent batch responded ${res.status}`);
    const json = (await res.json()) as any;
    // Preferred shape: { data: { matches: string[] } }
    // Back-compat shape: { data: { match: true|false, intent: "..." } } (single)
    if (Array.isArray(json?.data?.matches)) return new Set(json.data.matches);
    if (json?.data?.match && typeof json.data.intent === "string") return new Set([json.data.intent]);
    // Fallback: the AI service may still be on the single-intent endpoint; probe each.
    const hits = new Set<string>();
    await Promise.all(intents.map(async (intent) => {
      const r = await fetch(`${AI_SERVICE_URL}/api/ai-assist/intent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026",
        },
        body: JSON.stringify({ message, intent, tenantId }),
      }).catch(() => null);
      if (!r || !r.ok) return;
      const body = (await r.json().catch(() => ({}))) as any;
      if (body?.data?.match) hits.add(intent);
    }));
    return hits;
  } catch (err) {
    console.warn("[routing] intent batch check failed:", (err as Error).message);
    return new Set();
  }
}

// ─── Local intent fallback (no AI) ───────────────────────────

function classifyIntentLocally(message: string): { intent: string; department: string | null } {
  const lower = message.toLowerCase();
  if (/\b(price|pricing|buy|purchase|plan|upgrade|demo|trial|quote)\b/.test(lower))
    return { intent: "sales_inquiry", department: "Sales" };
  if (/\b(invoice|bill|payment|charge|refund|subscription|cancel.*plan)\b/.test(lower))
    return { intent: "billing", department: "Billing" };
  if (/\b(bug|error|broken|crash|not working|issue|problem|fix|debug)\b/.test(lower))
    return { intent: "technical_support", department: "Support" };
  if (/\b(return|ship|deliver|track|order|package)\b/.test(lower))
    return { intent: "order_inquiry", department: "Support" };
  return { intent: "general", department: null };
}

// ─── Condition evaluator (deterministic half) ────────────────

function evaluateCondition(
  condition: RuleCondition,
  context: { message: string; channel: string; tags: string[] },
): boolean {
  const lowerValue = (condition.value || "").toLowerCase();
  switch (condition.type) {
    case "keyword": {
      const lowerMsg = context.message.toLowerCase();
      if (condition.operator === "equals")   return lowerMsg === lowerValue;
      if (condition.operator === "is_not")   return !lowerMsg.includes(lowerValue);
      return lowerMsg.includes(lowerValue);
    }
    case "channel": {
      const ch = context.channel.toLowerCase();
      if (condition.operator === "is_not")   return ch !== lowerValue;
      return ch === lowerValue;
    }
    case "tag": {
      const hasTag = context.tags.some((t) => t.toLowerCase() === lowerValue);
      if (condition.operator === "is_not")   return !hasTag;
      return hasTag;
    }
    default:
      return false;
  }
}

// ─── Rule evaluator ─────────────────────────────────────────

function evaluateRule(
  rule: { id: string; name: string; isDefault: boolean; logic: string; conditions: unknown },
  ctx: { message: string; channel: string; tags: string[]; intentHits: Set<string> },
): { matched: boolean; entry: RoutingTraceEntry } {
  const entry: RoutingTraceEntry = {
    ruleId: rule.id,
    name: rule.name,
    isDefault: rule.isDefault,
    matched: false,
    condResults: [],
  };

  if (rule.isDefault) {
    entry.matched = true;
    return { matched: true, entry };
  }

  const conditions = (rule.conditions as RuleCondition[]) || [];
  if (conditions.length === 0) {
    entry.matched = true;
    return { matched: true, entry };
  }

  const results = conditions.map((c) => {
    let r = false;
    if (c.type === "intent") {
      const raw = ctx.intentHits.has(c.value);
      r = c.operator === "is_not" ? !raw : raw;
    } else {
      r = evaluateCondition(c, ctx);
    }
    entry.condResults.push({ type: c.type, operator: c.operator, value: c.value, result: r });
    return r;
  });

  const matched = rule.logic === "OR" ? results.some(Boolean) : results.every(Boolean);
  entry.matched = matched;
  return { matched, entry };
}

// ─── Agent assignment helpers ───────────────────────────────

export async function assignToLeastBusyAgent(tenantId: string, departmentId: string): Promise<string | null> {
  const members = await prisma.departmentMember.findMany({
    where: { tenantId, departmentId },
    select: { userId: true },
  });
  if (members.length === 0) return null;

  const counts = await Promise.all(
    members.map(async (m) => {
      const count = await prisma.conversation.count({
        where: { tenantId, assignedAgentId: m.userId, status: { in: ["OPEN", "WAITING"] } },
      });
      return { userId: m.userId, count };
    }),
  );
  counts.sort((a, b) => a.count - b.count);
  return counts[0]?.userId ?? null;
}

// ─── Pure evaluator (no side effects) — used by /router-rules/test ──
// Same evaluation as the live path but does NOT dispatch to the AI bot
// or the flow engine, does NOT mutate the conversation. Returns the
// trace + the route the system WOULD pick.

export async function previewRouting(opts: {
  tenantId: string;
  message: string;
  channel: string;
  tags?: string[];
}): Promise<Omit<RoutingResult, "handledByAI"> & { routeType?: string; routeTargetId?: string | null }> {
  const { rules, intentHits } = await loadRulesAndIntents(opts.tenantId, opts.message, opts.channel);
  const trace: RoutingTraceEntry[] = [];
  const ctx = { message: opts.message, channel: opts.channel, tags: opts.tags ?? [], intentHits };

  for (const rule of rules) {
    const { matched, entry } = evaluateRule(rule, ctx);
    trace.push(entry);
    if (!matched) continue;
    entry.stopped = true;
    return {
      matchedRule: rule.id,
      intent: [...intentHits][0] ?? classifyIntentLocally(opts.message).intent,
      departmentId: (rule as any).routeType === "DEPARTMENT" ? (rule as any).routeTarget ?? null : null,
      assignedAgentId: null,
      routeType: (rule as any).routeType,
      routeTargetId: (rule as any).aiAgentId ?? (rule as any).routeTarget ?? null,
      trace,
    };
  }

  const fb = await resolveFallback(opts.tenantId);
  return {
    matchedRule: null,
    intent: classifyIntentLocally(opts.message).intent,
    departmentId: fb.departmentId,
    assignedAgentId: null,
    fallback: fb.kind,
    routeType: fb.routeType,
    routeTargetId: fb.targetId,
    trace,
  };
}

// ─── Live routing — dispatches + mutates ────────────────────

export async function routeConversation(
  tenantId: string,
  conversationId: string,
  message: string,
  channel?: string,
): Promise<RoutingResult> {
  const chan = (channel || "whatsapp").toLowerCase();

  // ─── Graph-walker path (Main Playbook FlowCanvas) ──────────────
  // If the tenant has authored a flow on the canvas, the runtime follows
  // exactly what the graph says. No RouterRule evaluation, no fallback ladder
  // — the graph IS the flow. Only if the canvas is empty do we fall through
  // to the legacy list-based evaluator below.
  const graph = await executeMainFlow({ tenantId, conversationId, message, channel: chan });
  if (graph.executed) {
    const result: RoutingResult = {
      departmentId:
        graph.route?.routeType === "DEPARTMENT" ? graph.route.targetId ?? null : null,
      assignedAgentId: null,
      handledByAI:
        graph.route?.routeType === "AI_AGENT" || graph.route?.routeType === "FLOW",
      intent: classifyIntentLocally(message).intent,
      matchedRule: graph.matchedNodeId ?? null,
      trace: graph.trace.map((t) => ({
        ruleId: t.nodeId,
        name: t.type,
        isDefault: false,
        matched: t.action !== "no_match" && t.action !== "skip_unknown",
        condResults: [],
      })),
    };
    console.log(
      `[routing] graph-walker conversation=${conversationId} halted=${graph.halted} reason=${graph.reason ?? "-"} route=${graph.route?.routeType ?? "-"} target=${graph.route?.targetId ?? "-"} end=${graph.endKind ?? "-"}`,
    );
    await publishEvent({
      event: "conversation:updated",
      tenantId,
      data: { id: conversationId, departmentId: result.departmentId, assignedAgentId: null },
    });
    await analyticsQueue.add("routing-applied", {
      tenantId,
      event: "conversation_routed",
      data: {
        conversationId,
        intent: result.intent,
        departmentId: result.departmentId,
        assignedAgentId: null,
        handledByAI: result.handledByAI,
        matchedRule: result.matchedRule,
        source: "flow_canvas",
      },
      timestamp: new Date().toISOString(),
    });
    return result;
  }

  const { rules, intentHits } = await loadRulesAndIntents(tenantId, message, chan);

  const result: RoutingResult = {
    departmentId: null,
    assignedAgentId: null,
    handledByAI: false,
    intent: [...intentHits][0] ?? classifyIntentLocally(message).intent,
    matchedRule: null,
    trace: [],
  };

  const ctx = { message, channel: chan, tags: [] as string[], intentHits };

  // Walk rules top-to-bottom (position ASC, defaults last). First match wins.
  for (const rule of rules) {
    const { matched, entry } = evaluateRule(rule, ctx);
    result.trace.push(entry);
    console.log(`[routing] rule=${rule.id} name=${rule.name} isDefault=${rule.isDefault} matched=${matched} conds=${JSON.stringify(entry.condResults)}`);

    if (!matched) continue;
    entry.stopped = true;
    result.matchedRule = rule.id;
    await dispatchRule(rule, tenantId, conversationId, message, result);
    break;
  }

  // No match → tenant fallback ladder
  if (!result.matchedRule) {
    const fb = await resolveFallback(tenantId);
    result.fallback = fb.kind;
    console.log(`[routing] no rule matched; fallback=${fb.kind} target=${fb.targetId ?? "none"}`);

    if (fb.kind === "default_agent" && fb.targetId) {
      result.handledByAI = true;
      await processAIBot(tenantId, conversationId, message, fb.targetId);
      await prisma.conversation.update({ where: { id: conversationId }, data: { handledBy: "ai_agent" } });
    } else if (fb.kind === "default_routine" && fb.targetId) {
      const flow = await prisma.chatbotFlow.findFirst({ where: { id: fb.targetId, tenantId, isActive: true } });
      if (flow) {
        await prisma.conversation.update({ where: { id: conversationId }, data: { chatbotFlowId: flow.id, chatbotNodeId: null } });
        await prisma.chatbotFlow.update({ where: { id: flow.id }, data: { runCount: { increment: 1 } } });
        await processChatbotFlow(tenantId, conversationId, message);
        result.handledByAI = true;
        await prisma.conversation.update({ where: { id: conversationId }, data: { handledBy: "flow" } });
      }
    } else if (fb.kind === "default_department" && fb.targetId) {
      result.departmentId = fb.targetId;
      await prisma.conversation.update({ where: { id: conversationId }, data: { departmentId: fb.targetId, status: "WAITING", handledBy: "human" } });
    } // else: unassigned, leave conversation as OPEN for a human to claim
  }

  // Publish updated state
  await publishEvent({
    event: "conversation:updated",
    tenantId,
    data: { id: conversationId, departmentId: result.departmentId, assignedAgentId: result.assignedAgentId },
  });

  // Analytics
  await analyticsQueue.add("routing-applied", {
    tenantId,
    event: "conversation_routed",
    data: {
      conversationId,
      intent: result.intent,
      departmentId: result.departmentId,
      assignedAgentId: result.assignedAgentId,
      handledByAI: result.handledByAI,
      matchedRule: result.matchedRule,
      fallback: result.fallback ?? null,
    },
    timestamp: new Date().toISOString(),
  });

  console.log(`[routing] conversation=${conversationId} intent=${result.intent} rule=${result.matchedRule} fallback=${result.fallback ?? "-"} dept=${result.departmentId} agent=${result.assignedAgentId} ai=${result.handledByAI}`);
  return result;
}

// ─── Dispatch helpers (per-routeType actions) ────────────────

async function dispatchRule(
  rule: any,
  tenantId: string,
  conversationId: string,
  message: string,
  result: RoutingResult,
) {
  switch (rule.routeType) {
    case "AI_AGENT": {
      if (rule.aiAgentId) {
        result.handledByAI = true;
        await processAIBot(tenantId, conversationId, message, rule.aiAgentId);
        await prisma.conversation.update({ where: { id: conversationId }, data: { handledBy: "ai_agent" } });
      }
      break;
    }
    case "FLOW": {
      if (rule.routeTarget) {
        const flow = await prisma.chatbotFlow.findFirst({ where: { id: rule.routeTarget, tenantId, isActive: true } });
        if (flow) {
          await prisma.conversation.update({ where: { id: conversationId }, data: { chatbotFlowId: flow.id, chatbotNodeId: null } });
          await prisma.chatbotFlow.update({ where: { id: flow.id }, data: { runCount: { increment: 1 } } });
          await processChatbotFlow(tenantId, conversationId, message);
          result.handledByAI = true;
          await prisma.conversation.update({ where: { id: conversationId }, data: { handledBy: "flow" } });
        }
      }
      break;
    }
    case "DEPARTMENT": {
      if (rule.routeTarget) {
        const dept = await prisma.department.findFirst({
          where: { id: rule.routeTarget, tenantId, isActive: true },
          select: { id: true, queueMode: true, autoRepliesEnabled: true },
        });
        if (dept) {
          result.departmentId = dept.id;
          await prisma.conversation.update({ where: { id: conversationId }, data: { departmentId: dept.id } });
          if (dept.autoRepliesEnabled) {
            result.handledByAI = true;
            await processAIBot(tenantId, conversationId, message);
          } else {
            await prisma.conversation.update({ where: { id: conversationId }, data: { status: "WAITING", handledBy: "human" } });
            if (dept.queueMode === "ROUND_ROBIN") {
              const agentId = await assignToLeastBusyAgent(tenantId, dept.id);
              if (agentId) {
                result.assignedAgentId = agentId;
                await prisma.conversation.update({ where: { id: conversationId }, data: { assignedAgentId: agentId } });
              }
            }
          }
        }
      }
      break;
    }
    case "HUMAN": {
      await prisma.conversation.update({ where: { id: conversationId }, data: { status: "WAITING", handledBy: "human" } });
      break;
    }
  }
}

// ─── Fallback ladder ────────────────────────────────────────

async function resolveFallback(tenantId: string): Promise<{
  kind: "default_agent" | "default_routine" | "default_department" | "unassigned";
  targetId: string | null;
  routeType?: string;
  departmentId: string | null;
}> {
  const t = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { defaultAgentId: true, defaultRoutineId: true, defaultDepartmentId: true } as any,
  }) as any;
  if (t?.defaultAgentId)      return { kind: "default_agent",      targetId: t.defaultAgentId,      routeType: "AI_AGENT",  departmentId: null };
  if (t?.defaultRoutineId)    return { kind: "default_routine",    targetId: t.defaultRoutineId,    routeType: "FLOW",      departmentId: null };
  if (t?.defaultDepartmentId) return { kind: "default_department", targetId: t.defaultDepartmentId, routeType: "DEPARTMENT", departmentId: t.defaultDepartmentId };
  return { kind: "unassigned", targetId: null, departmentId: null };
}

// ─── Rule + intent loader (shared between live + preview) ────

async function loadRulesAndIntents(tenantId: string, message: string, channel: string) {
  const allRules = await prisma.routerRule.findMany({
    where: { tenantId, enabled: true },
    orderBy: { position: "asc" as any } as any,
  });
  // Non-default first (respects position), defaults last.
  const rules = [...allRules.filter((r) => !r.isDefault), ...allRules.filter((r) => r.isDefault)];

  // Batch all intent condition values
  const allIntents = Array.from(new Set(
    rules.flatMap((r) => ((r.conditions as unknown) as RuleCondition[] | null)?.filter((c) => c.type === "intent").map((c) => c.value) ?? []),
  ));
  const intentHits = await checkIntentsBatch(message, allIntents, tenantId);
  return { rules, intentHits };
}
