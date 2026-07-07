/**
 * Bot-turn → Agent Loop adapter. Bridges the existing bot reply entry
 * (`generateAIBotReply`) to the new autonomous loop when the flag is on, and maps
 * the loop's result back to the legacy `AIBotReplyResult` shape. This is the ONLY
 * file that knows both worlds; the loop itself stays bot-agnostic.
 *
 * Kept deliberately thin: it loads the turn's transcript + agent mission, runs the
 * loop, and translates the outcome. Anything richer (persona, RBAC-scoped menu,
 * committed goal) is a follow-up — this proves the loop on real traffic first.
 */

import { prisma } from "@chatcenter/shared";
import { getDefaultModel } from "../ai.service";
import { loadCommittedGoal } from "../plan-context.service";
import { runAgentLoop, type AgentLoopResult } from "./agent-loop";
import { loadAgentMemory, saveAgentMemory } from "./memory-store";
import { loadToolGrants } from "./permissions-bridge";
import { isOperationAutonomous } from "./operation-status";
import type { AgentLoopMode } from "./flags";

/** The subset of AIBotReplyResult the loop can populate (kept structurally compatible). */
export interface LoopBotReply {
  reply: string | null;
  interimMessages?: string[];
  escalation: { reason: string; priority?: "low" | "medium" | "high"; summary?: string } | null;
  awaitingApproval: { approvalRequestId: string; tool: string; reason: string } | null;
  toolCallLog: Array<{ tool: string; args: Record<string, unknown>; result: string; decision?: string; sideEffect?: string }>;
  modelUsed: string;
  totalTokens: number;
}

export async function runAgentLoopForBotTurn(
  opts: { tenantId: string; conversationId: string; aiAgentId: string; incomingMessage: string },
  mode: Exclude<AgentLoopMode, "off">,
  signal?: AbortSignal,
): Promise<LoopBotReply> {
  const [agent, conversation, recent, grants] = await Promise.all([
    prisma.aIAgent.findUnique({ where: { id: opts.aiAgentId } }),
    // tenant-scoped reads (TenantGuard requires tenantId in findFirst/findMany where).
    prisma.conversation.findFirst({ where: { id: opts.conversationId, tenantId: opts.tenantId }, select: { customerExternalId: true, customerName: true, channel: true } }),
    prisma.message.findMany({
      where: { conversationId: opts.conversationId, tenantId: opts.tenantId },
      orderBy: { createdAt: "asc" },
      take: 40,
      select: { direction: true, body: true, messageType: true },
    }),
    // RBAC home: the agent's tool grants (the same AND-rule guest-list the
    // legacy surface uses). Fail-soft to ungoverned inside the loader.
    loadToolGrants(opts.tenantId, opts.aiAgentId),
  ]);

  const transcript = recent
    .filter((m) => m.body?.trim() && m.messageType !== "system")
    .map((m) => ({ role: m.direction === "INBOUND" ? ("customer" as const) : ("agent" as const), text: m.body }));
  // Ensure the just-arrived inbound is present even if not yet persisted.
  if (opts.incomingMessage?.trim() && transcript[transcript.length - 1]?.text !== opts.incomingMessage) {
    transcript.push({ role: "customer", text: opts.incomingMessage });
  }

  // Employee binding: the AIAgent row IS the employee-as-data — thread its
  // mission / policies / persona into the kernel contract (which already has the
  // slots). Pure mapping; the kernel stays employee-agnostic.
  const binding = buildEmployeeBinding(agent);
  const language = detectAgentLanguage(agent);

  // Identity threading (parity with the legacy brain's extractRecentEmail): an email
  // the customer states IN THE CONVERSATION must reach the operations' execution
  // context, or write ops that need an attendee/contact email (BOOK_MEETING, ADD_NOTE,
  // UPSERT_CUSTOMER) can NEVER satisfy their identity invariant and the loop dead-loops
  // re-proposing them. Prefer the most recent email in a CUSTOMER message.
  const customerEmail = extractLatestEmail(transcript);
  // A WhatsApp/SMS external id IS the customer's phone number.
  const customerPhone = /^\+?\d[\d\s-]{6,}$/.test(conversation?.customerExternalId ?? "")
    ? (conversation?.customerExternalId ?? undefined)
    : undefined;

  // Rollout mode → runtime EXECUTION semantics. `shadow` (evaluation) runs the full
  // Runtime as a dry_run: writes stay RECOMMENDED (no mutation) but the approval
  // gate IS probed (no request created), so shadow evidence proves the HITL
  // surface too — distinct from copilot "advisory", which skips the gate because
  // a human is already in the loop. Only `autonomous` performs real writes.
  const executionMode = mode === "autonomous" ? "autonomous" : "dry_run";

  // Cross-turn memory: load the Reasoner's prior conclusions for this agent ×
  // customer (advisory — Facts override). No continuity key → empty memory.
  const memoryKey = conversation?.customerExternalId
    ? { tenantId: opts.tenantId, agentId: opts.aiAgentId, customerExternalId: conversation.customerExternalId }
    : null;
  const memory = memoryKey ? await loadAgentMemory(memoryKey) : emptyMemory();

  // GOAL home: the objective the legacy runtime committed to for this customer
  // (per-customer continuity, audit-backed). The kernel treats it as the
  // outcome it is driving toward; null → the Reasoner infers from mission.
  const committedGoal = await loadCommittedGoal(opts.tenantId, opts.conversationId, {
    channel: String((conversation as any)?.channel ?? ""),
    externalId: conversation?.customerExternalId,
  }).catch(() => null);

  const result = await runAgentLoop({
    tenantId: opts.tenantId,
    conversationId: opts.conversationId,
    turnId: `${opts.conversationId}:${Date.now()}`,
    aiAgentId: opts.aiAgentId,
    customerExternalId: conversation?.customerExternalId,
    customerEmail,
    mode: executionMode,
    // Oracle base: identity + (RBAC unfiltered for the pilot — menu gates on world-state).
    customer: {
      id: conversation?.customerExternalId,
      knownFields: {
        name: conversation?.customerName ?? undefined,
        ...(customerEmail ? { email: customerEmail } : {}),
        ...(customerPhone ? { phone: customerPhone } : {}),
      },
      identityResolved: !!conversation?.customerExternalId,
    },
    permissions: { allowedOperations: [] }, // fallback ceiling; real RBAC comes from `grants`
    grants,
    transcript,
    mission: binding.mission,
    guidance: binding.guidance,
    persona: binding.persona,
    goal: committedGoal?.objectiveId ?? null, // committed objective (per-customer continuity) or Reasoner-inferred
    memory,
    language,
    signal,
    // Ownership probe (autonomous only): stand down mid-loop if a human takes
    // the conversation over while the loop holds the turn. Shadow runs are
    // fire-and-forget dry-runs — nothing to protect, no probe.
    ownershipCheck:
      executionMode === "autonomous"
        ? async () => {
            const row = await prisma.conversation.findFirst({
              where: { id: opts.conversationId, tenantId: opts.tenantId },
              select: { isHandedOver: true, assignedAgentId: true },
            });
            return !!row && !row.isHandedOver && !row.assignedAgentId;
          }
        : undefined,
    // Migration guard (P1-4): an operation not yet PROVEN autonomous in the
    // ledger dry-runs even in an autonomous turn — so a graduating capability
    // (e.g. CRM writes in "shadow") never mutates production before its opt-in.
    operationExecutionMode: (operation, requestedMode) =>
      requestedMode === "autonomous" && !isOperationAutonomous(operation) ? "dry_run" : requestedMode,
  });

  // Persist the Reasoner's carried-forward conclusions for the NEXT turn.
  // Awaited (a single ~ms upsert) so it is never dropped on process exit;
  // fail-soft internally, so it can never break the reply.
  // AUTONOMOUS ONLY: shadow trajectories systematically diverge (dry-run
  // writes, anti-stall rule-outs) — persisting their conclusions would boot
  // the first real autonomous turn from evaluation-mode hallucinated history.
  // A superseded run also skips: a human owns the conversation now.
  if (memoryKey && result.memoryUpdate && executionMode === "autonomous" && result.terminationReason !== "superseded") {
    await saveAgentMemory(memoryKey, result.memoryUpdate);
  }

  return mapResult(result);
}

export function mapResult(r: AgentLoopResult): LoopBotReply {
  // Escalation side-effects must match what the customer is TOLD. The Writer's
  // honest fallbacks for failed/blocked say "a team member will take it from
  // here" — so those terminations MUST raise a real escalation (the worker's
  // existing escalateToHuman flow consumes it), not just say so. Resource-guard
  // stops (max_iterations/timeout/budget) are also "stuck" → human, matching the
  // legacy brain's stuck-turn behavior. Shadow runs discard this object, so no
  // side-effect can leak from evaluation mode.
  const STUCK: Record<string, string> = {
    failed: "kernel_unrecoverable_failure",
    blocked: "kernel_blocked",
    max_iterations: "kernel_stuck_max_iterations",
    timeout: "kernel_stuck_timeout",
    budget_exceeded: "kernel_budget_exceeded",
  };
  const lastObs = [...r.workingMemory.iterations].reverse().find((it) => it.observation)?.observation;
  const escalation =
    r.terminationReason === "escalate"
      ? { reason: (r.finalDecision as any).reason ?? "reasoner_escalate", priority: "medium" as const }
      : STUCK[r.terminationReason]
        ? {
            reason: STUCK[r.terminationReason],
            priority: "medium" as const,
            summary: lastObs ? `Loop ${r.terminationReason}; last observation: ${lastObs}`.slice(0, 300) : undefined,
          }
        : null;
  // The AWAITING_APPROVAL observation carries the REAL ApprovalRequest id
  // ("… awaiting_approval:<id>") — surface that, so the worker/UI reference the
  // same row the Approvals inbox shows. loopId is only a last-resort fallback.
  const approvalRef =
    r.terminationReason === "awaiting_approval"
      ? [...r.workingMemory.iterations]
          .reverse()
          .find((it) => it.runtimeResult === "AWAITING_APPROVAL")
          ?.observation?.match(/awaiting_approval:([A-Za-z0-9_-]+)/)?.[1]
      : undefined;
  const awaitingApproval =
    r.terminationReason === "awaiting_approval"
      ? { approvalRequestId: approvalRef ?? r.loopId, tool: (r.finalDecision as any).operation ?? "unknown", reason: "awaiting_approval" }
      : null;

  const toolCallLog = r.workingMemory.iterations
    .filter((it) => it.proposedOperation)
    .map((it) => ({
      tool: it.proposedOperation!,
      args: {},
      result: it.runtimeResult ?? "unknown",
      decision: it.decision.type,
      sideEffect: it.observation,
    }));

  return {
    reply: r.reply,
    escalation,
    awaitingApproval,
    toolCallLog,
    modelUsed: getDefaultModel(),
    totalTokens: r.spentUnits,
  };
}

function emptyMemory() {
  return { workingHypotheses: [], alreadyAsked: [], priorReads: [], openCommitments: [] };
}

/**
 * Employee binding — AIAgent row → the kernel's mission / guidance / persona slots.
 *
 * Pure and fail-soft (every field optional; a bare agent yields a minimal binding).
 * Mapping principles:
 *   - mission = WHO the employee is + WHAT it drives toward (role, goal, what we
 *     sell / ICP from salesContext) + disqualifiers. Authoritative framing.
 *   - guidance = the tenant PLAYBOOK the Reasoner MAY override: safety boundaries,
 *     forbidden actions, custom guardrails, behavioral anchors, success criteria.
 *     Same enforcement strength these had in the legacy prompt (steering text).
 *   - persona = voice only (informs the Writer, never the decision): name, tone,
 *     do-nots.
 * Built ONLY from static agent config → byte-stable across turns (cache-safe).
 */
export function buildEmployeeBinding(agent: any): {
  mission: { businessDescription?: string; disqualifiers?: string[] };
  guidance?: string;
  persona?: { displayName?: string; voice?: string; doNots?: string[] };
} {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => str(x)).filter((x): x is string => !!x) : [];
  const rec = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

  if (!agent) return { mission: {} };
  const sc = rec(agent.salesContext);
  const behavioral = rec(agent.behavioral);

  // ── Mission ──
  const missionParts: string[] = [];
  const role = str(agent.role);
  const name = str(agent.name);
  if (name || role) missionParts.push(`You are ${name ?? "an AI employee"}${role ? `, a ${role.replace(/_/g, " ")} employee` : ""}.`);
  const goal = str(agent.goal);
  if (goal) missionParts.push(`Goal: ${goal}`);
  const whatWeSell = str(sc.whatWeSell);
  if (whatWeSell) missionParts.push(`What we sell: ${whatWeSell}`);
  const icp = str(sc.idealCustomerProfile);
  if (icp) missionParts.push(`Ideal customer: ${icp}`);
  const mission = {
    businessDescription: missionParts.length ? missionParts.join(" ") : (goal ?? name),
    disqualifiers: strList(sc.disqualifiers).length ? strList(sc.disqualifiers) : undefined,
  };

  // ── Guidance (playbook) ──
  const g: string[] = [];
  for (const s of strList(behavioral.safetyBoundaries)) g.push(`Safety boundary: ${s}`);
  for (const s of strList(behavioral.forbiddenActions)) g.push(`Never do: ${s}`);
  for (const s of strList(agent.customGuardrails)) g.push(`Guardrail: ${s}`);
  for (const a of (Array.isArray(agent.behavioralAnchors) ? agent.behavioralAnchors : [])) {
    const cond = str(rec(a).condition);
    const guide = str(rec(a).guidance) ?? str(rec(a).intent);
    if (guide) g.push(cond ? `When ${cond}: ${guide}` : guide);
  }
  const success = str(agent.successCriteria);
  if (success) g.push(`Success looks like: ${success}`);
  const guidance = g.length ? g.join("\n") : undefined;

  // ── Persona (voice only) ──
  const toneCfg = rec(agent.toneConfig);
  const voiceParts = [str(agent.tone), str(toneCfg.formalityLevel) && `formality: ${str(toneCfg.formalityLevel)}`,
    str(toneCfg.empathyLevel) && `empathy: ${str(toneCfg.empathyLevel)}`].filter(Boolean) as string[];
  const doNots = strList(behavioral.forbiddenActions);
  const persona =
    name || voiceParts.length || doNots.length
      ? { displayName: name, voice: voiceParts.length ? voiceParts.join(", ") : undefined, doNots: doNots.length ? doNots : undefined }
      : undefined;

  return { mission, guidance, persona };
}

/** Most recent email stated in a CUSTOMER message (parity with legacy extractRecentEmail). */
function extractLatestEmail(transcript: Array<{ role: "customer" | "agent"; text: string | null }>): string | undefined {
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const t = transcript[i];
    if (t.role !== "customer" || !t.text) continue;
    const m = t.text.match(re);
    if (m) return m[0].toLowerCase();
  }
  return undefined;
}

function detectAgentLanguage(agent: any): string | undefined {
  try {
    const langs = agent?.languages ?? {};
    if (langs.hebrew) return "he";
    if (langs.arabic) return "ar";
    return "en";
  } catch {
    return undefined;
  }
}
