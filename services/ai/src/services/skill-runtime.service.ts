/**
 * Business skills in the per-turn loop - NOT a parallel engine.
 *
 *   selection   rides the existing wizard-binding judgement call (one LLM call
 *               per turn already made by assemblePlanContext); this module only
 *               supplies the candidates and interprets the verdict
 *   continuity  the open SkillRun (sticky until done / handed over / two turns
 *               on another topic)
 *   injection   one `# Active Skill` turn block (mode on only) next to
 *               `# Pipeline Stage`; BLOCK 2 carries the skill NAMES only, so the
 *               cached prefix stays stable
 *   gathering   the skill's requiredInfo joins the knowledge ledger
 *   tools       a skill never grants a tool; it can only TIGHTEN approval
 *   state       a step's state comes from ToolExecutionRequest, never from the
 *               model's own claim
 *
 * Plan: docs/product/ai-studio-skills-automations.md §3.2. The decision and
 * rendering functions are pure; the I/O wrappers at the bottom load and record.
 */
import { prisma, writeAudit } from "@chatcenter/shared";
import type { KnowledgeField } from "./skills";
import { computeKnowledgeLedger } from "./knowledge-ledger";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SkillStepDef {
  id: string;
  kind: string;
  title: string;
  guidance?: string;
  tools?: string[];
  approvalOverAmount?: number | null;
  elseNote?: string | null;
}

export interface SkillCandidate {
  id: string;
  name: string;
  situation: string | null;
  whenToUse: string | null;
  examples: string[];
  exclusions: Array<{ text: string; skillId: string | null }>;
  steps: SkillStepDef[];
  rules: Array<{ type: "never" | "handover"; text: string }>;
  requiredInfo: Array<{ key: string; label: string; priority: number }>;
  version: number;
  mode: "on" | "watch";
  order: number;
}

export interface OpenSkillRun {
  id: string;
  skillId: string;
  skillVersion: number;
  mode: "on" | "watch";
  currentStepId: string | null;
  missedTurns: number;
  startedAt: Date;
  /** What the bot did in this run so far (see settleSkillRun). */
  trace?: Array<{ step: string | null; tool: string; outcome: string; at: string }>;
}

export interface SkillContext {
  candidates: SkillCandidate[];
  openRun: OpenSkillRun | null;
  noSkillPolicy: string;
  /** Skills that already finished in this conversation (so "thanks" does not restart one). */
  doneSkillIds?: string[];
  /** Finished within RESTART_COOLDOWN_MS: not restarted, whatever the judgement says. */
  recentlyDoneSkillIds?: string[];
}

/**
 * A skill that just finished is not restarted by the next message ("thanks",
 * "ok great"). Live check: the judgement re-chose a just-completed skill for a
 * thank-you despite being told it was done. The employee still answers that
 * message normally; it only does not open a second run of the same case.
 */
export const RESTART_COOLDOWN_MS = 5 * 60_000;

/** What the wizard-binding judgement is shown: enough to choose, nothing more. */
export interface SkillSelectionCandidate {
  id: string;
  name: string;
  whenToUse: string | null;
  situation: string | null;
  examples: string[];
  exclusions: Array<{ text: string; useSkillInstead: string | null }>;
  /** Finished (completed / handed over) earlier in this conversation. */
  doneInConversation?: boolean;
  /** For the OPEN skill: what it is still gathering (so a detail it asked for keeps it). */
  gathering?: string[];
}

export type SkillTurnDecision = {
  /** The run this turn works in, if any (new runs have runId null until created). */
  active: { skill: SkillCandidate; runId: string | null; missedTurns: number } | null;
  /** A run to end before anything else, and why. */
  close: { runId: string; reason: "topic_changed" | "skill_removed" | "skill_changed" } | null;
  /** Whether `active` starts a new run this turn. */
  starts: boolean;
};

// ── Selection candidates + the turn decision (pure) ────────────────────────

/** Sorted by the employee's order: the judgement prefers the earlier one on a tie. */
export function selectionCandidates(ctx: SkillContext): SkillSelectionCandidate[] {
  const nameById = new Map(ctx.candidates.map((c) => [c.id, c.name]));
  return [...ctx.candidates]
    .sort((a, b) => a.order - b.order)
    .map((c) => ({
      id: c.id,
      name: c.name,
      whenToUse: c.whenToUse,
      situation: c.situation,
      examples: c.examples.slice(0, 8),
      exclusions: c.exclusions.map((e) => ({ text: e.text, useSkillInstead: e.skillId ? nameById.get(e.skillId) ?? null : null })),
      doneInConversation: (ctx.doneSkillIds ?? []).includes(c.id) && ctx.openRun?.skillId !== c.id,
      ...(ctx.openRun?.skillId === c.id && c.requiredInfo.length ? { gathering: c.requiredInfo.map((r) => r.label) } : {}),
    }));
}

/**
 * Decide which skill this turn works in.
 *
 * `matched` is the judgement's verdict: a candidate id, null (none fits), or
 * undefined (the judgement did not run or failed - then nothing changes: an
 * open run continues, nothing new starts).
 */
export function decideSkillTurn(ctx: SkillContext, matched: string | null | undefined): SkillTurnDecision {
  const byId = new Map(ctx.candidates.map((c) => [c.id, c]));
  const justDone = new Set(ctx.recentlyDoneSkillIds ?? []);
  const pick = matched && byId.has(matched) && !(justDone.has(matched) && ctx.openRun?.skillId !== matched) ? byId.get(matched)! : null;
  let open = ctx.openRun;
  let close: SkillTurnDecision["close"] = null;

  if (open) {
    const skill = byId.get(open.skillId);
    // Removed from the employee, turned off, archived or back to draft: end it.
    if (!skill) { close = { runId: open.id, reason: "skill_removed" }; open = null; }
    // Edited since the run started: a run follows ONE definition, so it ends
    // and the new version starts fresh if it still fits.
    else if (skill.version !== open.skillVersion) { close = { runId: open.id, reason: "skill_changed" }; open = null; }
  }

  if (open) {
    const skill = byId.get(open.skillId)!;
    if (matched === undefined || matched === open.skillId) {
      return { active: { skill, runId: open.id, missedTurns: 0 }, close, starts: false };
    }
    if (pick) {
      // Clearly another case: end this run, start the matched one.
      return { active: { skill: pick, runId: null, missedTurns: 0 }, close: { runId: open.id, reason: "topic_changed" }, starts: true };
    }
    // The judgement saw nothing that fits: stay with the open run (a short
    // "ok" or "thanks" is not a topic change) until it happens twice in a row.
    const missed = open.missedTurns + 1;
    if (missed >= 2) return { active: null, close: { runId: open.id, reason: "topic_changed" }, starts: false };
    return { active: { skill, runId: open.id, missedTurns: missed }, close, starts: false };
  }

  if (pick) return { active: { skill: pick, runId: null, missedTurns: 0 }, close, starts: true };
  return { active: null, close, starts: false };
}

// ── Step states (pure over ToolExecutionRequest rows) ──────────────────────

export type StepState = "done" | "awaiting_approval" | "in_progress" | "failed" | "denied" | "todo" | "unavailable";

/** The bot calls a catalog HTTP tool `integration_<slug>`; the editor lists it as `integration.<slug>`. */
export function sameTool(a: string, b: string): boolean {
  const n = (s: string) => String(s || "").replace(/^integration\./, "integration_");
  return n(a) === n(b);
}

export interface ToolRequestRow { tool: string; status: string; proposedAt: Date }

/** A trace outcome as a request status, so trace and requests merge into one state. */
const OUTCOME_TO_STATUS: Record<string, string> = {
  completed: "completed", simulated: "completed", approval_requested: "proposed",
  failed: "failed", denied: "denied", escalated: "completed",
};

/**
 * The run's own trace as request rows. The trace is what the bot did each
 * turn, INCLUDING a result reused from the idempotency window and a write the
 * sandbox simulated - neither of which writes a ToolExecutionRequest row.
 */
export function traceAsRequests(trace: Array<{ tool: string; outcome: string; at: string }> | undefined): ToolRequestRow[] {
  return (trace ?? [])
    .filter((t) => OUTCOME_TO_STATUS[t.outcome])
    .map((t) => ({ tool: t.tool, status: OUTCOME_TO_STATUS[t.outcome], proposedAt: new Date(t.at) }));
}

/** One turn's tool call, as the bot logged it. */
export interface TurnToolCall { tool: string; decision: string; ok: boolean }

/** The outcome a turn's tool call records in the trace (null = nothing happened). */
export function outcomeOfCall(c: TurnToolCall): string | null {
  switch (c.decision) {
    case "awaiting_approval": return "approval_requested";
    case "denied": return "denied";
    case "escalate": return "escalated";
    case "simulated": return "simulated";
    case "executed":
    case "executed_on_retry": return c.ok ? "completed" : "failed";
    default: return null; // refused before dispatch (missing inputs, gates): no step progress
  }
}

/**
 * Each step's state: from the newest request for any of its tools since the
 * run started. A step whose tools are not on this employee's surface is
 * `unavailable` - the employee hands over there. A step with no tools is
 * `todo` until the steps after it show progress.
 */
export function computeStepStates(steps: SkillStepDef[], requests: ToolRequestRow[], surface: string[]): Array<{ step: SkillStepDef; state: StepState }> {
  const sorted = [...requests].sort((a, b) => +b.proposedAt - +a.proposedAt);
  const states = steps.map((step) => {
    const tools = step.tools ?? [];
    if (!tools.length) return { step, state: "todo" as StepState };
    const latest = sorted.find((r) => tools.some((t) => sameTool(t, r.tool)));
    if (latest) {
      const map: Record<string, StepState> = {
        completed: "done", proposed: "awaiting_approval", approved: "in_progress", running: "in_progress",
        failed: "failed", denied: "denied",
      };
      return { step, state: map[latest.status] ?? "in_progress" };
    }
    const available = tools.some((t) => surface.some((s) => sameTool(t, s)));
    return { step, state: (available ? "todo" : "unavailable") as StepState };
  });
  // A tool-less step BEFORE a step that already moved is behind us.
  let lastMoved = -1;
  states.forEach((s, i) => { if (s.state !== "todo" && s.state !== "unavailable") lastMoved = i; });
  return states.map((s, i) => (s.state === "todo" && !(s.step.tools ?? []).length && i < lastMoved ? { ...s, state: "done" } : s));
}

/** The first step not done; null when every step is done. */
export function currentStepOf(states: Array<{ step: SkillStepDef; state: StepState }>): SkillStepDef | null {
  return states.find((s) => s.state !== "done")?.step ?? null;
}

/** Complete when every step that has tools is done (and there is at least one). */
export function isSkillComplete(states: Array<{ step: SkillStepDef; state: StepState }>): boolean {
  const withTools = states.filter((s) => (s.step.tools ?? []).length > 0);
  return withTools.length > 0 && withTools.every((s) => s.state === "done");
}

// ── Rendering (pure) ───────────────────────────────────────────────────────

const MARK: Record<StepState, string> = {
  done: "[done]", awaiting_approval: "[waiting for a person's approval]", in_progress: "[in progress]",
  failed: "[failed]", denied: "[not permitted]", todo: "[to do]", unavailable: "[you cannot do this step]",
};

/** BLOCK 2 line: names only, so the cached prefix changes only when the list does. */
export function renderSkillNamesLine(names: string[]): string | null {
  if (!names.length) return null;
  return `# Business Skills\nYou have business skills for: ${names.join("; ")}. When one applies, its steps are given to you this turn in the Active Skill section.`;
}

export function renderActiveSkillBlock(skill: SkillCandidate, states: Array<{ step: SkillStepDef; state: StepState }>, missingInfo: string[]): string {
  const current = currentStepOf(states);
  const lines: string[] = [`# Active Skill: ${skill.name}`];
  if (skill.whenToUse) lines.push(`Why this skill: ${skill.whenToUse}`);
  lines.push("While this skill is active it decides your next move, ahead of the Current Plan's next action. Platform rules, approvals and tool permissions still apply.");
  lines.push("", "Steps, in order:");
  states.forEach((s, i) => {
    const here = current && s.step.id === current.id ? " <- you are here" : "";
    const tools = (s.step.tools ?? []).length ? ` (tools: ${(s.step.tools ?? []).join(", ")})` : "";
    lines.push(`${i + 1}. ${MARK[s.state]} ${s.step.title}${tools}${here}`);
    if (s.step.guidance) lines.push(`   ${s.step.guidance}`);
    if (s.state === "unavailable") lines.push("   You do not have the tool for this step: tell the customer a person will take over, and hand over here.");
    if (s.step.elseNote && (s.state === "failed" || s.state === "denied" || s.state === "unavailable")) lines.push(`   If it cannot be done: ${s.step.elseNote}`);
  });
  const never = skill.rules.filter((r) => r.type === "never");
  const handover = skill.rules.filter((r) => r.type === "handover");
  if (never.length || handover.length) {
    lines.push("", "Rules of this skill (they override its steps):");
    for (const r of never) lines.push(`- Never: ${r.text}`);
    for (const r of handover) lines.push(`- Hand over to a person when: ${r.text}`);
  }
  if (missingInfo.length) lines.push("", `Still needed from the customer: ${missingInfo.join(", ")}. Ask for what the current step needs, one thing at a time.`);
  lines.push(
    "",
    "Only a step marked [done] has happened. A step waiting for approval is PENDING: tell the customer it is being checked, never that it is done. Never claim a step you have not seen marked [done].",
  );
  return lines.join("\n");
}

/** When no business skill fits and the employee's policy is not the default. */
export function renderNoSkillBlock(policy: string): string | null {
  if (policy === "always_handover") {
    return "# No Skill Fits\nNone of your business skills fits this message. Your instruction for this case: hand the conversation to a person (escalate_to_human) with a short, honest message. Do not try to resolve it yourself.";
  }
  if (policy === "knowledge_only") {
    return "# No Skill Fits\nNone of your business skills fits this message. Your instruction for this case: answer ONLY from the Knowledge section. If it does not cover the question, say so plainly and offer a person. Do not take any action.";
  }
  return null;
}

/** The active skill's requiredInfo as ledger fields (same path as the built-in skill). */
export function skillLedgerFields(skill: SkillCandidate): KnowledgeField[] {
  return skill.requiredInfo.map((r) => ({ key: r.key, label: r.label, importance: "required" as const, priority: r.priority }));
}

/**
 * What the prompt gets for business skills this turn, or undefined when the
 * employee has none and the default no-skill policy - then the prompt is
 * byte-for-byte what it was before skills existed.
 *
 *   names        the employee's LIVE (on) skills, in its order (BLOCK 2)
 *   activeBlock  the live skill's steps / rules / missing info (turn block)
 *   noSkillBlock the employee's no-skill policy, when no live skill is active
 *   requiredInfo the live skill's fields for the knowledge ledger
 *
 * A watch-mode skill contributes NOTHING here: it is recorded, never shown.
 */
export function businessSkillsForPrompt(opts: {
  ctx: SkillContext;
  activeOnSkill: SkillCandidate | null;
  requests: ToolRequestRow[];
  surface: string[];
  factText: string;
}): { names: string[]; activeName: string | null; activeBlock: string | null; noSkillBlock: string | null; requiredInfo: KnowledgeField[] } | undefined {
  const { ctx, activeOnSkill } = opts;
  if (!ctx.candidates.length && ctx.noSkillPolicy === "answer_from_knowledge") return undefined;
  let activeBlock: string | null = null;
  let requiredInfo: KnowledgeField[] = [];
  if (activeOnSkill && activeOnSkill.mode === "on") {
    const states = computeStepStates(activeOnSkill.steps, opts.requests, opts.surface);
    requiredInfo = skillLedgerFields(activeOnSkill);
    const missing = computeKnowledgeLedger(requiredInfo, opts.factText).entries.filter((e) => !e.known).map((e) => e.label);
    activeBlock = renderActiveSkillBlock(activeOnSkill, states, missing);
  }
  return {
    names: ctx.candidates.filter((c) => c.mode === "on").sort((a, b) => a.order - b.order).map((c) => c.name),
    activeName: activeBlock && activeOnSkill ? activeOnSkill.name : null,
    activeBlock,
    noSkillBlock: activeBlock ? null : renderNoSkillBlock(ctx.noSkillPolicy),
    requiredInfo,
  };
}

// ── Approval: tighten only (pure) ──────────────────────────────────────────

/**
 * A step's "ask you over X": when this tool belongs to a step of the active
 * (mode on) skill that sets approvalOverAmount and the call's amount exceeds
 * it, the call needs a person's approval. Returns the reason, or null. Used
 * by the orchestrator ONLY when policy already ALLOWS - it can never loosen.
 */
export function skillApprovalReason(skill: SkillCandidate | null, tool: string, args: Record<string, unknown>): string | null {
  if (!skill || skill.mode !== "on") return null;
  const amount = typeof args?.amount === "number" ? args.amount : typeof args?.amount === "string" ? Number(args.amount) : NaN;
  if (!Number.isFinite(amount)) return null;
  for (const step of skill.steps) {
    const limit = step.approvalOverAmount;
    if (typeof limit !== "number" || !(limit > 0)) continue;
    if (!(step.tools ?? []).some((t) => sameTool(t, tool))) continue;
    if (amount > limit) return `skill "${skill.name}" step "${step.title}" asks a person over ${limit}`;
  }
  return null;
}

// ── I/O ────────────────────────────────────────────────────────────────────

const asArr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** The employee's usable skills (on/watch, status active) and this conversation's open run. */
export async function loadSkillContext(tenantId: string, aiAgentId: string, conversationId: string): Promise<SkillContext> {
  const [agent, assigns, open, done] = await Promise.all([
    prisma.aIAgent.findFirst({ where: { id: aiAgentId, tenantId }, select: { noSkillPolicy: true } }),
    prisma.agentSkill.findMany({
      where: { tenantId, aiAgentId, mode: { in: ["on", "watch"] }, skill: { status: "active" } },
      orderBy: { order: "asc" },
      select: {
        mode: true, order: true,
        skill: { select: { id: true, name: true, situation: true, whenToUse: true, examples: true, exclusions: true, steps: true, rules: true, requiredInfo: true, version: true } },
      },
    }),
    prisma.skillRun.findFirst({
      where: { tenantId, conversationId, aiAgentId, status: "active" },
      orderBy: { startedAt: "desc" },
      select: { id: true, skillId: true, skillVersion: true, mode: true, currentStepId: true, missedTurns: true, startedAt: true, trace: true },
    }),
    prisma.skillRun.findMany({
      where: { tenantId, conversationId, aiAgentId, status: { in: ["completed", "handed_over"] } },
      select: { skillId: true, endedAt: true },
    }),
  ]);
  return {
    noSkillPolicy: agent?.noSkillPolicy ?? "answer_from_knowledge",
    doneSkillIds: [...new Set(done.map((d: any) => d.skillId as string))],
    recentlyDoneSkillIds: [...new Set(
      done.filter((d: any) => d.endedAt && Date.now() - new Date(d.endedAt).getTime() < RESTART_COOLDOWN_MS).map((d: any) => d.skillId as string),
    )],
    openRun: open ? { ...open, mode: open.mode === "on" ? "on" : "watch", trace: asArr(open.trace) } : null,
    candidates: assigns.map((a: any) => ({
      id: a.skill.id, name: a.skill.name, situation: a.skill.situation ?? null, whenToUse: a.skill.whenToUse ?? null,
      examples: asArr(a.skill.examples), exclusions: asArr(a.skill.exclusions), steps: asArr(a.skill.steps),
      rules: asArr(a.skill.rules), requiredInfo: asArr(a.skill.requiredInfo), version: a.skill.version,
      mode: a.mode === "on" ? "on" : "watch", order: a.order,
    })),
  };
}

/** Record the decision: end a run, start one, or keep the open one. Returns the run id in use. */
export async function applySkillDecision(
  tenantId: string,
  conversationId: string,
  aiAgentId: string,
  d: SkillTurnDecision,
): Promise<string | null> {
  if (d.close) {
    await prisma.skillRun.updateMany({
      where: { tenantId, id: d.close.runId, status: "active" },
      data: { status: "abandoned", stopReason: d.close.reason, endedAt: new Date() },
    });
  }
  if (!d.active) return null;
  if (!d.starts && d.active.runId) {
    await prisma.skillRun.updateMany({ where: { tenantId, id: d.active.runId }, data: { missedTurns: d.active.missedTurns } });
    return d.active.runId;
  }
  const run = await prisma.skillRun.create({
    data: {
      tenantId, conversationId, aiAgentId, skillId: d.active.skill.id, skillVersion: d.active.skill.version,
      mode: d.active.skill.mode, status: "active", currentStepId: d.active.skill.steps[0]?.id ?? null,
    },
    select: { id: true },
  });
  void writeAudit({
    tenantId, actorType: "ai", actorId: aiAgentId, action: "ai.skill_selected",
    targetType: "conversation", targetId: conversationId,
    metadata: { skillId: d.active.skill.id, skillVersion: d.active.skill.version, mode: d.active.skill.mode, runId: run.id },
  }).catch(() => undefined);
  return run.id;
}

/** This conversation's tool requests since the run started. */
export async function loadRunRequests(tenantId: string, conversationId: string, since: Date): Promise<ToolRequestRow[]> {
  const rows = await (prisma as any).toolExecutionRequest.findMany({
    where: { tenantId, conversationId, proposedAt: { gte: since } },
    select: { tool: true, status: true, proposedAt: true, decidedAt: true, startedAt: true, completedAt: true },
  });
  // Timed by the LATEST thing that happened to the request, so an approval
  // that completed after the turn that asked for it wins over that turn's
  // "approval requested" trace entry.
  return (rows as any[]).map((r) => ({
    tool: r.tool,
    status: r.status,
    proposedAt: new Date(Math.max(+new Date(r.proposedAt), +(r.decidedAt ? new Date(r.decidedAt) : 0), +(r.startedAt ? new Date(r.startedAt) : 0), +(r.completedAt ? new Date(r.completedAt) : 0))),
  }));
}

/**
 * After the turn: move the run to where the tool requests now put it. Trace
 * gets one entry per tool request seen for the first time; completion and
 * hand-over end the run and are audited. No model reasoning is stored.
 */
export async function settleSkillRun(opts: {
  tenantId: string;
  conversationId: string;
  aiAgentId: string;
  runId: string;
  skill: SkillCandidate;
  surface: string[];
  escalatedThisTurn: boolean;
  /** This turn's tool calls (from the bot's own log). */
  turnCalls: TurnToolCall[];
}): Promise<{ status: string; currentStepId: string | null }> {
  const run = await prisma.skillRun.findFirst({
    where: { tenantId: opts.tenantId, id: opts.runId },
    select: { startedAt: true, trace: true, currentStepId: true, status: true },
  });
  if (!run || run.status !== "active") return { status: run?.status ?? "missing", currentStepId: run?.currentStepId ?? null };
  // The trace records what the bot did THIS turn (including reused results and
  // simulated writes); the request rows add what changed since (an approval
  // decided, a run that finished after the turn).
  const trace = asArr(run.trace);
  const at = new Date().toISOString();
  for (const c of opts.turnCalls) {
    const outcome = outcomeOfCall(c);
    if (!outcome) continue;
    const step = opts.skill.steps.find((s) => (s.tools ?? []).some((t) => sameTool(t, c.tool)));
    trace.push({ step: step?.id ?? null, tool: c.tool, outcome, at });
  }
  const requests = await loadRunRequests(opts.tenantId, opts.conversationId, run.startedAt);
  const states = computeStepStates(opts.skill.steps, [...requests, ...traceAsRequests(trace)], opts.surface);
  const current = currentStepOf(states);
  const complete = isSkillComplete(states);
  const status = complete ? "completed" : opts.escalatedThisTurn ? "handed_over" : "active";
  const ended = status !== "active";
  await prisma.skillRun.updateMany({
    where: { tenantId: opts.tenantId, id: opts.runId, status: "active" },
    data: {
      trace, currentStepId: current?.id ?? null, status,
      ...(ended ? { endedAt: new Date(), stopReason: complete ? "completed" : "handed_over" } : {}),
    },
  });
  const audit = (action: string, meta: Record<string, unknown>) =>
    void writeAudit({ tenantId: opts.tenantId, actorType: "ai", actorId: opts.aiAgentId, action, targetType: "conversation", targetId: opts.conversationId, metadata: { skillId: opts.skill.id, runId: opts.runId, ...meta } }).catch(() => undefined);
  if ((current?.id ?? null) !== (run.currentStepId ?? null)) audit("ai.skill_step", { from: run.currentStepId, to: current?.id ?? null });
  if (status === "completed") audit("ai.skill_completed", {});
  if (status === "handed_over") audit("ai.skill_handed_over", { atStep: current?.id ?? null });
  return { status, currentStepId: current?.id ?? null };
}
