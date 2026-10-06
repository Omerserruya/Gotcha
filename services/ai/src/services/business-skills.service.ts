/**
 * Business skills (AI Studio, design 6) - the data side: validation, CRUD,
 * assignment to employees, stats, the run log, the fit check and the tool
 * list for the step editor. The per-turn side (selection, the # Active Skill
 * block, the run lifecycle) is skill-runtime.service.ts.
 *
 * A skill NEVER grants a tool. Its steps NAME tools; whether an employee may
 * use one is the bot's own rule (AgentToolPermission.isAllowed + TenantTool
 * enabled + integration CONNECTED + allowed in AUTO), applied here by the fit
 * check exactly as the bot applies it when it builds the tool surface.
 *
 * Plan: docs/product/ai-studio-skills-automations.md §3.1-3.2.
 */
import { prisma, buildAgentTools, visibilityClause, type Viewer } from "@chatcenter/shared";
import { getGovernableIntegrationTools } from "./tool-registry";

export const SKILL_CATEGORIES = ["orders", "products", "bookings", "other"] as const;
export const SKILL_STEP_KINDS = ["find", "check", "change", "document", "message", "approval", "handover"] as const;
export const SKILL_STATUSES = ["draft", "active", "archived"] as const;
export const SKILL_MODES = ["on", "watch", "off"] as const;
export const NO_SKILL_POLICIES = ["answer_from_knowledge", "always_handover", "knowledge_only"] as const;
export const RUN_STATUSES = ["active", "completed", "handed_over", "failed", "abandoned"] as const;

const LIMITS = { name: 120, text: 2000, examples: 20, exclusions: 20, steps: 20, toolsPerStep: 10, rules: 20, requiredInfo: 20 };

export interface SkillStep {
  id: string;
  kind: (typeof SKILL_STEP_KINDS)[number];
  title: string;
  guidance: string;
  tools: string[];
  approvalOverAmount: number | null;
  elseNote: string | null;
}
export interface SkillInput {
  name: string;
  situation: string | null;
  category: string;
  whenToUse: string | null;
  examples: string[];
  exclusions: Array<{ text: string; skillId: string | null }>;
  steps: SkillStep[];
  rules: Array<{ type: "never" | "handover"; text: string }>;
  requiredInfo: Array<{ key: string; label: string; priority: number }>;
  status: string;
}

export class SkillValidationError extends Error {
  constructor(public field: string, message: string) { super(message); }
}

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};
const keyOf = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") : "";
  return s ? s.slice(0, 60) : null;
};

/**
 * Validate and normalise a skill body. `partial` (PUT) keeps absent fields out
 * of the result so they are not overwritten. Step ids are kept when given (so a
 * run's currentStepId survives an edit) and generated when missing.
 */
export function normalizeSkillInput(body: any, opts: { partial?: boolean } = {}): Partial<SkillInput> {
  const b = body && typeof body === "object" ? body : {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  const out: Partial<SkillInput> = {};

  if (!opts.partial || has("name")) {
    const name = str(b.name, LIMITS.name);
    if (!name) throw new SkillValidationError("name", "name is required");
    out.name = name;
  }
  if (!opts.partial || has("situation")) out.situation = str(b.situation, LIMITS.text);
  if (!opts.partial || has("whenToUse")) out.whenToUse = str(b.whenToUse, LIMITS.text);
  if (!opts.partial || has("category")) {
    const c = typeof b.category === "string" ? b.category : "other";
    if (!(SKILL_CATEGORIES as readonly string[]).includes(c)) throw new SkillValidationError("category", `category must be one of ${SKILL_CATEGORIES.join(", ")}`);
    out.category = c;
  }
  if (!opts.partial || has("status")) {
    const s = typeof b.status === "string" ? b.status : "draft";
    // archived is reached through DELETE only, so a run's history is never orphaned by an edit.
    if (s !== "draft" && s !== "active") throw new SkillValidationError("status", "status must be draft or active (archive with DELETE)");
    out.status = s;
  }
  if (!opts.partial || has("examples")) {
    const arr = Array.isArray(b.examples) ? b.examples : [];
    out.examples = arr.map((x: unknown) => str(x, 300)).filter((x: string | null): x is string => !!x).slice(0, LIMITS.examples);
  }
  if (!opts.partial || has("exclusions")) {
    const arr = Array.isArray(b.exclusions) ? b.exclusions : [];
    out.exclusions = arr
      .map((x: any) => ({ text: str(x?.text, 300), skillId: typeof x?.skillId === "string" && x.skillId ? x.skillId : null }))
      .filter((x: any) => x.text || x.skillId)
      .map((x: any) => ({ text: x.text ?? "", skillId: x.skillId }))
      .slice(0, LIMITS.exclusions);
  }
  if (!opts.partial || has("steps")) {
    const arr = Array.isArray(b.steps) ? b.steps : [];
    if (arr.length > LIMITS.steps) throw new SkillValidationError("steps", `at most ${LIMITS.steps} steps`);
    const seen = new Set<string>();
    out.steps = arr.map((x: any, i: number): SkillStep => {
      const kind = x?.kind;
      if (!(SKILL_STEP_KINDS as readonly string[]).includes(kind)) {
        throw new SkillValidationError(`steps[${i}].kind`, `kind must be one of ${SKILL_STEP_KINDS.join(", ")}`);
      }
      const title = str(x?.title, 200);
      if (!title) throw new SkillValidationError(`steps[${i}].title`, "every step needs a title");
      let id = typeof x?.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(x.id) ? x.id : `s${i + 1}`;
      while (seen.has(id)) id = `${id}_${i + 1}`;
      seen.add(id);
      const tools = (Array.isArray(x?.tools) ? x.tools : [])
        .filter((t: unknown): t is string => typeof t === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(t))
        .slice(0, LIMITS.toolsPerStep);
      const amt = x?.approvalOverAmount;
      const approvalOverAmount = typeof amt === "number" && Number.isFinite(amt) && amt > 0 ? amt : null;
      return { id, kind, title, guidance: str(x?.guidance, LIMITS.text) ?? "", tools: [...new Set<string>(tools)], approvalOverAmount, elseNote: str(x?.elseNote, 500) };
    });
  }
  if (!opts.partial || has("rules")) {
    const arr = Array.isArray(b.rules) ? b.rules : [];
    out.rules = arr
      .map((x: any) => ({ type: x?.type === "handover" ? "handover" as const : x?.type === "never" ? "never" as const : null, text: str(x?.text, 500) }))
      .filter((x: any) => x.type && x.text)
      .slice(0, LIMITS.rules) as SkillInput["rules"];
  }
  if (!opts.partial || has("requiredInfo")) {
    const arr = Array.isArray(b.requiredInfo) ? b.requiredInfo : [];
    const seen = new Set<string>();
    out.requiredInfo = arr
      .map((x: any, i: number) => ({ key: keyOf(x?.key ?? x?.label), label: str(x?.label, 120) ?? "", priority: Number.isInteger(x?.priority) ? x.priority : i + 1 }))
      .filter((x: any) => x.key && !seen.has(x.key) && seen.add(x.key))
      .map((x: any) => ({ ...x, label: x.label || x.key }))
      .slice(0, LIMITS.requiredInfo);
  }
  return out;
}

/** Exclusions may only point at this tenant's own skills. */
async function assertExclusionsInTenant(tenantId: string, exclusions: SkillInput["exclusions"] | undefined, selfId?: string) {
  const ids = [...new Set((exclusions ?? []).map((e) => e.skillId).filter((x): x is string => !!x))];
  if (!ids.length) return;
  if (selfId && ids.includes(selfId)) throw new SkillValidationError("exclusions", "a skill cannot exclude itself");
  const found = await prisma.businessSkill.count({ where: { tenantId, id: { in: ids } } });
  if (found !== ids.length) throw new SkillValidationError("exclusions", "an exclusion points at a skill that does not exist");
}

const SKILL_VIEW = {
  id: true, name: true, situation: true, category: true, whenToUse: true, examples: true, exclusions: true,
  steps: true, rules: true, requiredInfo: true, status: true, version: true, createdAt: true, updatedAt: true, archivedAt: true,
} as const;

export async function createSkill(tenantId: string, userId: string | undefined, body: any) {
  const data = normalizeSkillInput(body) as SkillInput;
  await assertExclusionsInTenant(tenantId, data.exclusions);
  return prisma.businessSkill.create({
    data: { ...data, tenantId, createdBy: userId ?? null, updatedBy: userId ?? null } as any,
    select: SKILL_VIEW,
  });
}

/** PUT: replace what is sent, version++ (a run pins the version it started with). */
export async function updateSkill(tenantId: string, id: string, userId: string | undefined, body: any) {
  const existing = await prisma.businessSkill.findFirst({ where: { id, tenantId }, select: { id: true, status: true } });
  if (!existing) return null;
  if (existing.status === "archived") throw new SkillValidationError("status", "an archived skill cannot be edited");
  const data = normalizeSkillInput(body, { partial: true });
  await assertExclusionsInTenant(tenantId, data.exclusions, id);
  return prisma.businessSkill.update({
    where: { id },
    data: { ...data, version: { increment: 1 }, updatedBy: userId ?? null } as any,
    select: SKILL_VIEW,
  });
}

/** DELETE = archive. Open runs end as abandoned (skill_removed); assignments stay for the history. */
export async function archiveSkill(tenantId: string, id: string, userId: string | undefined) {
  const existing = await prisma.businessSkill.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!existing) return null;
  const [skill] = await prisma.$transaction([
    prisma.businessSkill.update({ where: { id }, data: { status: "archived", archivedAt: new Date(), updatedBy: userId ?? null }, select: SKILL_VIEW }),
    prisma.skillRun.updateMany({
      where: { tenantId, skillId: id, status: "active" },
      data: { status: "abandoned", stopReason: "skill_removed", endedAt: new Date() },
    }),
  ]);
  return skill;
}

export async function getSkill(tenantId: string, id: string) {
  return prisma.businessSkill.findFirst({ where: { id, tenantId }, select: SKILL_VIEW });
}

// ── Stats ──────────────────────────────────────────────────────────────────

export interface SkillStats {
  skillId: string;
  /** Live (mode on) runs started in the window. */
  runs: number;
  /** Watch-mode runs: what it WOULD have done. */
  watchRuns: number;
  /** completed / ended (completed + handed_over + failed); null before any ended. */
  aloneShare: number | null;
  /** Runs that needed a person: handed over, or paused for an approval. */
  askedYou: number;
  stopReasons: Array<{ reason: string; count: number }>;
  usedBy: Array<{ aiAgentId: string; name: string; mode: string; order: number }>;
}

export async function skillStats(tenantId: string, from: Date, skillIds?: string[]): Promise<SkillStats[]> {
  const skills = await prisma.businessSkill.findMany({
    where: { tenantId, ...(skillIds ? { id: { in: skillIds } } : { status: { not: "archived" } }) },
    select: { id: true },
  });
  const ids = skills.map((s) => s.id);
  if (!ids.length) return [];
  const [allRuns, assigns] = await Promise.all([
    prisma.skillRun.findMany({
      where: { tenantId, skillId: { in: ids }, startedAt: { gte: from } },
      select: { skillId: true, mode: true, status: true, stopReason: true, trace: true, conversationId: true },
    }),
    prisma.agentSkill.findMany({
      where: { tenantId, skillId: { in: ids } },
      select: { skillId: true, mode: true, order: true, aiAgent: { select: { id: true, name: true } } },
    }),
  ]);
  // Rehearsals (the employee's test chat) are not real runs: excluded, the same
  // rule analytics applies to sandbox conversations.
  const convIds = [...new Set(allRuns.map((r) => r.conversationId))];
  const sandbox = convIds.length
    ? new Set((await prisma.conversation.findMany({
        where: { tenantId, id: { in: convIds }, customerExternalId: { startsWith: "sandbox:" } },
        select: { id: true },
      })).map((c) => c.id))
    : new Set<string>();
  const runs = allRuns.filter((r) => !sandbox.has(r.conversationId));
  return ids.map((skillId) => {
    const mine = runs.filter((r) => r.skillId === skillId);
    const live = mine.filter((r) => r.mode === "on");
    const ended = live.filter((r) => r.status === "completed" || r.status === "handed_over" || r.status === "failed");
    const completed = live.filter((r) => r.status === "completed").length;
    const askedYou = live.filter((r) =>
      r.status === "handed_over" ||
      (Array.isArray(r.trace) && (r.trace as any[]).some((t) => t?.outcome === "approval_requested")),
    ).length;
    const reasons = new Map<string, number>();
    for (const r of live) if (r.stopReason) reasons.set(r.stopReason, (reasons.get(r.stopReason) ?? 0) + 1);
    return {
      skillId,
      runs: live.length,
      watchRuns: mine.length - live.length,
      aloneShare: ended.length ? completed / ended.length : null,
      askedYou,
      stopReasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
      usedBy: assigns
        .filter((a) => a.skillId === skillId)
        .map((a) => ({ aiAgentId: a.aiAgent.id, name: a.aiAgent.name, mode: a.mode, order: a.order }))
        .sort((a, b) => a.order - b.order),
    };
  });
}

export async function listSkills(tenantId: string, opts: { includeArchived?: boolean; from: Date }) {
  const skills = await prisma.businessSkill.findMany({
    where: { tenantId, ...(opts.includeArchived ? {} : { status: { not: "archived" } }) },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    select: SKILL_VIEW,
  });
  const stats = await skillStats(tenantId, opts.from, skills.map((s) => s.id));
  const byId = new Map(stats.map((s) => [s.skillId, s]));
  return skills.map((s) => ({ ...s, stats: byId.get(s.id) ?? null }));
}

// ── Run log ────────────────────────────────────────────────────────────────

/**
 * A skill's runs, newest first. A department-restricted viewer sees only runs
 * in conversations they may see (the inbox's visibility rule), and a run's
 * conversation it may not see is simply not listed.
 */
export async function listRuns(tenantId: string, skillId: string, viewer: Viewer, opts: { limit: number; cursor?: string | null }) {
  const take = Math.min(Math.max(opts.limit || 20, 1), 100);
  const rows = await prisma.skillRun.findMany({
    where: { tenantId, skillId },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: {
      id: true, conversationId: true, aiAgentId: true, skillVersion: true, mode: true, status: true,
      currentStepId: true, gatheredKeys: true, stopReason: true, trace: true, startedAt: true, endedAt: true,
    },
  });
  const hasMore = rows.length > take;
  let page = hasMore ? rows.slice(0, take) : rows;
  const clause = visibilityClause(viewer);
  if (clause && page.length) {
    const visible = await prisma.conversation.findMany({
      where: { tenantId, id: { in: [...new Set(page.map((r) => r.conversationId))] }, OR: clause },
      select: { id: true },
    });
    const ok = new Set(visible.map((c) => c.id));
    page = page.filter((r) => ok.has(r.conversationId));
  }
  return { data: page, nextCursor: hasMore ? rows[take - 1].id : null };
}

// ── Assignment ─────────────────────────────────────────────────────────────

export async function getAgentSkills(tenantId: string, aiAgentId: string, from: Date) {
  const agent = await prisma.aIAgent.findFirst({ where: { id: aiAgentId, tenantId }, select: { id: true, noSkillPolicy: true } });
  if (!agent) return null;
  const rows = await prisma.agentSkill.findMany({
    where: { tenantId, aiAgentId },
    orderBy: { order: "asc" },
    select: { skillId: true, mode: true, order: true, skill: { select: { name: true, status: true, category: true, version: true } } },
  });
  const runs = rows.length
    ? await prisma.skillRun.groupBy({
        by: ["skillId"],
        where: { tenantId, aiAgentId, startedAt: { gte: from }, skillId: { in: rows.map((r) => r.skillId) } },
        _count: { _all: true },
      })
    : [];
  const runsBy = new Map(runs.map((r: any) => [r.skillId, r._count._all as number]));
  return {
    aiAgentId,
    noSkillPolicy: agent.noSkillPolicy,
    skills: rows.map((r) => ({
      skillId: r.skillId, mode: r.mode, order: r.order,
      name: r.skill.name, status: r.skill.status, category: r.skill.category, version: r.skill.version,
      runs: runsBy.get(r.skillId) ?? 0,
    })),
  };
}

/**
 * PUT the full list. Order is the array order unless `order` is given. A skill
 * turned off or removed ends this employee's open runs of it as abandoned
 * (skill_removed); the employee falls back to its noSkillPolicy.
 */
export async function setAgentSkills(tenantId: string, aiAgentId: string, items: any[]) {
  const agent = await prisma.aIAgent.findFirst({ where: { id: aiAgentId, tenantId }, select: { id: true } });
  if (!agent) return null;
  if (!Array.isArray(items)) throw new SkillValidationError("skills", "body must be an array of {skillId, mode, order}");
  const clean: Array<{ skillId: string; mode: string; order: number }> = [];
  const seen = new Set<string>();
  items.forEach((x: any, i: number) => {
    const skillId = typeof x?.skillId === "string" ? x.skillId : "";
    if (!skillId || seen.has(skillId)) return;
    seen.add(skillId);
    const mode = (SKILL_MODES as readonly string[]).includes(x?.mode) ? x.mode : "watch";
    clean.push({ skillId, mode, order: Number.isInteger(x?.order) ? x.order : i });
  });
  if (clean.length) {
    const ok = await prisma.businessSkill.findMany({
      where: { tenantId, id: { in: clean.map((c) => c.skillId) }, status: { not: "archived" } },
      select: { id: true },
    });
    if (ok.length !== clean.length) throw new SkillValidationError("skills", "a skill does not exist or is archived");
  }
  const before = await prisma.agentSkill.findMany({ where: { tenantId, aiAgentId }, select: { skillId: true, mode: true } });
  const keep = new Set(clean.map((c) => c.skillId));
  const stopped = [
    ...before.filter((b) => !keep.has(b.skillId)).map((b) => b.skillId),
    ...clean.filter((c) => c.mode === "off").map((c) => c.skillId),
  ];
  await prisma.$transaction([
    prisma.agentSkill.deleteMany({ where: { tenantId, aiAgentId, skillId: { notIn: [...keep] } } }),
    ...clean.map((c) =>
      prisma.agentSkill.upsert({
        where: { aiAgentId_skillId: { aiAgentId, skillId: c.skillId } },
        create: { tenantId, aiAgentId, skillId: c.skillId, mode: c.mode, order: c.order },
        update: { mode: c.mode, order: c.order },
      }),
    ),
    ...(stopped.length
      ? [prisma.skillRun.updateMany({
          where: { tenantId, aiAgentId, skillId: { in: stopped }, status: "active" },
          data: { status: "abandoned", stopReason: "skill_removed", endedAt: new Date() },
        })]
      : []),
  ]);
  return getAgentSkills(tenantId, aiAgentId, new Date(Date.now() - 7 * 86_400_000));
}

// ── Tools: the step editor's list and the fit check ────────────────────────

export interface ToolChoice {
  name: string;
  displayName: string;
  source: "system" | "integration";
  integrationSlug: string | null;
  category: string | null;
  riskLevel: string | null;
  /** The integration is connected (system tools: always, calendar ones need a calendar). */
  connected: boolean;
  /** Present when an agent was asked about: the bot would offer it to this employee. */
  allowedForAgent?: boolean;
  reason?: string;
}

const CALENDAR_SYSTEM_TOOLS = new Set(["schedule_meeting", "check_availability", "reschedule_meeting", "cancel_meeting"]);

/** Built-in tools: every flag on, so the editor sees the whole set. */
function systemToolNames(): Array<{ name: string; description: string }> {
  const defs = buildAgentTools({
    identityLinking: true, escalation: true, closure: true, followup: true,
    scheduleMeeting: true, checkAvailability: true, rescheduleMeeting: true, cancelMeeting: true,
  } as any);
  return defs
    .map((d: any) => ({ name: d?.function?.name ?? d?.name, description: d?.function?.description ?? d?.description ?? "" }))
    .filter((d) => typeof d.name === "string" && d.name);
}

/**
 * The tools a step may name: built-ins + the tenant's integration tools. With
 * an agentId, each carries whether the bot would offer it to that employee -
 * the same rule as the bot's surface (allowed + enabled + CONNECTED + AUTO).
 */
export async function listToolChoices(tenantId: string, aiAgentId?: string | null): Promise<ToolChoice[]> {
  const [integration, calendarConnected, allowed] = await Promise.all([
    getGovernableIntegrationTools(tenantId, { includeDisconnected: true }),
    prisma.tenantIntegration.count({
      where: { tenantId, status: "CONNECTED", integration: { category: "CALENDAR" as any } },
    }).then((n) => n > 0).catch(() => false),
    aiAgentId ? allowedIntegrationToolsFor(tenantId, aiAgentId) : Promise.resolve(null),
  ]);
  const sys: ToolChoice[] = systemToolNames().map((t) => {
    const needsCalendar = CALENDAR_SYSTEM_TOOLS.has(t.name);
    const connected = needsCalendar ? calendarConnected : true;
    return {
      name: t.name, displayName: t.name.replace(/_/g, " "), source: "system", integrationSlug: null,
      category: needsCalendar ? "CALENDAR" : "SYSTEM", riskLevel: null, connected,
      ...(aiAgentId ? { allowedForAgent: connected, ...(connected ? {} : { reason: "no_calendar_connected" }) } : {}),
    };
  });
  const integ: ToolChoice[] = integration.map((t) => {
    const connected = t.integrationStatus === "CONNECTED";
    const base: ToolChoice = {
      name: t.name, displayName: t.displayName, source: "integration", integrationSlug: t.integrationSlug,
      category: t.catalogCategory, riskLevel: t.riskLevel, connected,
    };
    if (!aiAgentId) return base;
    const ok = connected && t.isEnabled && !!allowed?.has(`${t.integrationSlug}:${t.slug}`);
    return {
      ...base,
      allowedForAgent: ok,
      ...(ok ? {} : { reason: !connected ? "integration_not_connected" : !t.isEnabled ? "tool_disabled_for_workspace" : "not_allowed_for_employee" }),
    };
  });
  return [...sys, ...integ];
}

/** `${integrationSlug}:${catalogToolSlug}` the bot would offer this employee (ai-bot's own rule). */
async function allowedIntegrationToolsFor(tenantId: string, aiAgentId: string): Promise<Set<string>> {
  const perms = await prisma.agentToolPermission.findMany({
    where: { tenantId, aiAgentId, isAllowed: true, tenantTool: { isEnabled: true, tenantIntegration: { status: "CONNECTED" } } },
    select: { tenantTool: { select: { catalogTool: { select: { slug: true, allowedModes: true } }, tenantIntegration: { select: { integration: { select: { slug: true } } } } } } },
  });
  const out = new Set<string>();
  for (const p of perms as any[]) {
    const tt = p.tenantTool;
    const integ = tt?.tenantIntegration?.integration?.slug;
    const slug = tt?.catalogTool?.slug;
    if (!integ || !slug) continue;
    const am = tt?.catalogTool?.allowedModes;
    if (Array.isArray(am) && !am.includes("AUTO")) continue;
    out.add(`${integ}:${slug}`);
  }
  return out;
}

export interface FitResult {
  fits: boolean;
  handsOverAtStep: string | null;
  reason: string | null;
  steps: Array<{ stepId: string; tools: Array<{ name: string; allowed: boolean; connected: boolean; reason?: string }> }>;
}

/**
 * Can this employee run this skill? Each step's tools against the bot's own
 * surface for the employee. The first step with a tool it cannot use is where
 * the employee will hand over (the skill still runs up to there).
 */
export async function fitCheck(tenantId: string, aiAgentId: string, skillId: string): Promise<FitResult | null> {
  const [agent, skill] = await Promise.all([
    prisma.aIAgent.findFirst({ where: { id: aiAgentId, tenantId }, select: { id: true } }),
    prisma.businessSkill.findFirst({ where: { id: skillId, tenantId }, select: { steps: true, status: true } }),
  ]);
  if (!agent || !skill) return null;
  const choices = new Map((await listToolChoices(tenantId, aiAgentId)).map((c) => [c.name, c]));
  const steps = (Array.isArray(skill.steps) ? skill.steps : []) as any[];
  let handsOverAtStep: string | null = null;
  let reason: string | null = null;
  const out = steps.map((s) => ({
    stepId: String(s.id),
    tools: (Array.isArray(s.tools) ? s.tools : []).map((name: string) => {
      const c = choices.get(name);
      const allowed = !!c?.allowedForAgent;
      const connected = !!c?.connected;
      const r = c ? c.reason : "unknown_tool";
      if (!allowed && !handsOverAtStep) { handsOverAtStep = String(s.id); reason = r ?? "not_allowed_for_employee"; }
      return { name, allowed, connected, ...(allowed ? {} : { reason: r ?? "not_allowed_for_employee" }) };
    }),
  }));
  if (skill.status === "archived" && !reason) reason = "skill_archived";
  return { fits: !handsOverAtStep && skill.status !== "archived", handsOverAtStep, reason, steps: out };
}
