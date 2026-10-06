/**
 * Studio > Automations (design 09c / 09d / 09e).
 *
 * An automation is a ChatbotFlow with a structured trigger (triggerType).
 * Flows without one are the main playbook's sub-flows: not listed here, and
 * never fired by events. Contract: docs/api/automations-contract-v1.md.
 *
 * Going live is gated by ONE validator (validateAutomation) on every path
 * that can make an automation live: activate, and a save while live.
 * `isActive` is never taken from a request body.
 */
import { Router, type Request, type Response } from "express";
import {
  prisma, authenticate, resolveTenant, requirePermissionOrRole, requireEntitlement, requireCapacity,
  visibilityClause, viewerOf,
} from "@chatcenter/shared";
import {
  AutomationInputError, normalizeTrigger, validateAutomation, catalogFor, pathOf, pathChannelOf,
  TRIGGER_TYPES, CHANNELS, type Channel, type TriggerType, type ANode, type AEdge,
} from "../lib/automation-catalog";

const router = Router();
router.use(authenticate, resolveTenant);

const CAN_WRITE = requirePermissionOrRole("ai:workflows:update", "ADMIN");
const CAN_PUBLISH = requirePermissionOrRole("ai:workflows:publish", "ADMIN");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const AUTOMATION = { triggerType: { not: null } } as const;

type FlowRow = {
  id: string; name: string; description: string | null; isActive: boolean;
  triggerType: string | null; triggerConfig: any; nodes: any; edges: any;
  activatedAt: Date | null; activatedBy: string | null; pausedAt: Date | null; pausedBy: string | null;
  createdAt: Date; updatedAt: Date;
};

const statusOf = (f: FlowRow): "draft" | "live" | "paused" => (f.isActive ? "live" : f.pausedAt ? "paused" : "draft");
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

async function voiceConnected(tenantId: string): Promise<boolean> {
  const n = await prisma.channelAccount.count({ where: { tenantId, channel: "VOICE" as any, isActive: true } }).catch(() => 0);
  return n > 0;
}

/** The API shape. `full` adds the graph (the list carries `path` instead). */
async function present(tenantId: string, flows: FlowRow[], full: boolean) {
  if (!flows.length) return [];
  const ids = flows.map((f) => f.id);
  const since = new Date(Date.now() - WEEK_MS);
  const userIds = [...new Set(flows.flatMap((f) => [f.activatedBy, f.pausedBy]).filter((x): x is string => !!x))];
  const [week, users, lastRuns] = await Promise.all([
    prisma.automationRun.groupBy({ by: ["flowId"], where: { tenantId, flowId: { in: ids }, startedAt: { gte: since } }, _count: { _all: true } }),
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds }, tenantId }, select: { id: true, name: true } }) : Promise.resolve([]),
    // One newest run per automation.
    Promise.all(ids.map((id) => prisma.automationRun.findFirst({
      where: { tenantId, flowId: id }, orderBy: { startedAt: "desc" }, select: { flowId: true, startedAt: true, status: true },
    }))),
  ]);
  const weekBy = new Map((week as any[]).map((w) => [w.flowId, w._count._all as number]));
  const nameBy = new Map((users as any[]).map((u) => [u.id, u.name as string]));
  const lastBy = new Map(lastRuns.filter(Boolean).map((r: any) => [r.flowId, r]));
  const who = (id: string | null) => (id ? { id, name: nameBy.get(id) ?? null } : null);
  return flows.map((f) => {
    const last: any = lastBy.get(f.id);
    return {
      id: f.id, name: f.name, description: f.description,
      trigger: { type: f.triggerType, config: f.triggerConfig ?? {} },
      status: statusOf(f), isActive: f.isActive,
      activatedAt: f.activatedAt, activatedBy: who(f.activatedBy),
      pausedAt: f.pausedAt, pausedBy: who(f.pausedBy),
      ...(full ? { nodes: arr(f.nodes), edges: arr(f.edges) } : {}),
      path: pathOf(arr(f.nodes), arr(f.edges), f.triggerType),
      stats: { runsThisWeek: weekBy.get(f.id) ?? 0, lastRunAt: last?.startedAt ?? null, lastRunStatus: last?.status ?? null },
      createdAt: f.createdAt, updatedAt: f.updatedAt,
    };
  });
}

async function findAutomation(tenantId: string, id: string): Promise<FlowRow | null> {
  return (await prisma.chatbotFlow.findFirst({ where: { id, tenantId, ...AUTOMATION } })) as any;
}

function fail(res: Response, err: unknown, what: string) {
  if (err instanceof AutomationInputError) { res.status(422).json({ error: err.message, field: err.field }); return; }
  console.error(`[automations] ${what}:`, err);
  res.status(500).json({ error: `Failed to ${what}` });
}

/** name / description / graph from a body; only the fields present. */
function editable(body: any, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body ?? {}, k);
  if (!partial || has("name")) {
    const name = String(body?.name ?? "").trim();
    if (!name) throw new AutomationInputError("name", "Give the automation a name.");
    if (name.length > 100) throw new AutomationInputError("name", "A name is at most 100 characters.");
    out.name = name;
  }
  if (has("description")) out.description = body.description == null ? null : String(body.description).slice(0, 2000);
  if (!partial || has("trigger")) {
    const t = normalizeTrigger(body?.trigger);
    out.triggerType = t.type;
    out.triggerConfig = t.config;
  }
  if (has("nodes")) {
    if (!Array.isArray(body.nodes) || body.nodes.some((n: any) => !n || typeof n.id !== "string" || typeof n.type !== "string")) {
      throw new AutomationInputError("nodes", "nodes must be a list of { id, type, data }");
    }
    out.nodes = body.nodes;
  }
  if (has("edges")) {
    if (!Array.isArray(body.edges) || body.edges.some((e: any) => !e || typeof e.source !== "string" || typeof e.target !== "string")) {
      throw new AutomationInputError("edges", "edges must be a list of { source, target, sourceHandle? }");
    }
    out.edges = body.edges;
  }
  return out;
}

/** A new automation starts with its trigger step on the canvas. */
function starterGraph(): { nodes: ANode[]; edges: AEdge[] } {
  return { nodes: [{ id: "trigger", type: "automation_trigger", position: { x: 0, y: 0 }, data: {} }], edges: [] };
}

// ── Static paths before /:id ───────────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const where: any = { tenantId: req.tenantId!, ...AUTOMATION };
    if (status === "live") where.isActive = true;
    if (status === "paused") Object.assign(where, { isActive: false, pausedAt: { not: null } });
    if (status === "draft") Object.assign(where, { isActive: false, pausedAt: null });
    const flows = await prisma.chatbotFlow.findMany({ where, orderBy: { updatedAt: "desc" } });
    res.json({ data: await present(req.tenantId!, flows as any, false) });
  } catch (err) { fail(res, err, "list automations"); }
});

router.get("/catalog", async (req: Request, res: Response) => {
  try {
    const q = req.query;
    let triggerType: TriggerType | null = null;
    let channel: Channel | null = typeof q.channel === "string" && (CHANNELS as string[]).includes(q.channel) ? (q.channel as Channel) : null;
    let afterNodeType: string | null = null;
    let firstStep = true;
    if (typeof q.automationId === "string" && q.automationId) {
      const f = await findAutomation(req.tenantId!, q.automationId);
      if (!f) { res.status(404).json({ error: "Automation not found" }); return; }
      triggerType = (TRIGGER_TYPES as readonly string[]).includes(f.triggerType ?? "") ? (f.triggerType as TriggerType) : null;
      channel = channel ?? pathChannelOf({ type: f.triggerType ?? "", config: f.triggerConfig });
      if (typeof q.after === "string" && q.after) {
        const n = arr(f.nodes).find((x: any) => x?.id === q.after);
        afterNodeType = n?.type ?? null;
        firstStep = false;
      } else {
        firstStep = !arr(f.nodes).some((n: any) => n?.type === "automation_trigger") || !triggerType;
      }
    } else if (typeof q.after === "string" && q.after) {
      firstStep = false;
    }
    res.json({ data: catalogFor({ channel, firstStep, triggerType, afterNodeType, voiceConnected: await voiceConnected(req.tenantId!) }) });
  } catch (err) { fail(res, err, "read the catalogue"); }
});

router.get("/runs/:runId", async (req: Request, res: Response) => {
  try {
    const run = await prisma.automationRun.findFirst({
      where: { id: String(req.params.runId), tenantId: req.tenantId! },
      include: { steps: { orderBy: { at: "asc" } } },
    });
    if (!run || !(await runsVisible(req, [run]))[0]) { res.status(404).json({ error: "Run not found" }); return; }
    const [shown] = await presentRuns(req.tenantId!, [run]);
    res.json({ data: { ...shown, steps: (run as any).steps.map((s: any) => ({ nodeId: s.nodeId, nodeType: s.nodeType, status: s.status, branch: s.branch, output: s.output, at: s.at })) } });
  } catch (err) { fail(res, err, "read the run"); }
});

// ── One automation ─────────────────────────────────────────────────────────

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const f = await findAutomation(req.tenantId!, String(req.params.id));
    if (!f) { res.status(404).json({ error: "Automation not found" }); return; }
    res.json({ data: (await present(req.tenantId!, [f], true))[0] });
  } catch (err) { fail(res, err, "read the automation"); }
});

router.post(
  "/",
  CAN_WRITE,
  requireEntitlement("communication.automations"),
  requireCapacity("limit:workflows", (tenantId) => prisma.chatbotFlow.count({ where: { tenantId } })),
  async (req: Request, res: Response) => {
    try {
      const data = editable(req.body, false);
      const graph = starterGraph();
      const flow = await prisma.chatbotFlow.create({
        data: {
          tenantId: req.tenantId!, ...(data as any),
          nodes: (data.nodes as any) ?? graph.nodes, edges: (data.edges as any) ?? graph.edges,
          isActive: false, // a new automation is always a draft
        },
      });
      res.status(201).json({ data: (await present(req.tenantId!, [flow as any], true))[0] });
    } catch (err) { fail(res, err, "create the automation"); }
  },
);

router.put("/:id", CAN_WRITE, async (req: Request, res: Response) => {
  try {
    const existing = await findAutomation(req.tenantId!, String(req.params.id));
    if (!existing) { res.status(404).json({ error: "Automation not found" }); return; }
    const expected = req.body?.expectedUpdatedAt;
    if (expected && new Date(expected).getTime() !== new Date(existing.updatedAt).getTime()) {
      res.status(409).json({ error: "stale_version_conflict: this automation changed since you opened it; reload before saving." });
      return;
    }
    const data = editable(req.body, true);
    // A live automation stays live only if the new version can go live.
    if (existing.isActive) {
      const next = { ...existing, ...data } as FlowRow;
      const { errors, warnings } = validateAutomation(
        { type: next.triggerType ?? "", config: next.triggerConfig }, arr(next.nodes), arr(next.edges),
        { voiceConnected: await voiceConnected(req.tenantId!) },
      );
      if (errors.length) { res.status(422).json({ error: "validation_failed", errors, warnings }); return; }
    }
    const flow = await prisma.chatbotFlow.update({ where: { id: existing.id }, data: data as any });
    res.json({ data: (await present(req.tenantId!, [flow as any], true))[0] });
  } catch (err) { fail(res, err, "update the automation"); }
});

router.post("/:id/validate", async (req: Request, res: Response) => {
  try {
    const existing = await findAutomation(req.tenantId!, String(req.params.id));
    if (!existing) { res.status(404).json({ error: "Automation not found" }); return; }
    const trigger = req.body?.trigger ? normalizeTrigger(req.body.trigger) : { type: existing.triggerType ?? "", config: existing.triggerConfig };
    const nodes = Array.isArray(req.body?.nodes) ? req.body.nodes : arr(existing.nodes);
    const edges = Array.isArray(req.body?.edges) ? req.body.edges : arr(existing.edges);
    res.json(validateAutomation(trigger, nodes, edges, { voiceConnected: await voiceConnected(req.tenantId!) }));
  } catch (err) { fail(res, err, "validate the automation"); }
});

router.post("/:id/activate", CAN_PUBLISH, async (req: Request, res: Response) => {
  try {
    const existing = await findAutomation(req.tenantId!, String(req.params.id));
    if (!existing) { res.status(404).json({ error: "Automation not found" }); return; }
    const { errors, warnings } = validateAutomation(
      { type: existing.triggerType ?? "", config: existing.triggerConfig }, arr(existing.nodes), arr(existing.edges),
      { voiceConnected: await voiceConnected(req.tenantId!) },
    );
    if (errors.length) { res.status(422).json({ error: "validation_failed", errors, warnings }); return; }
    const flow = await prisma.chatbotFlow.update({
      where: { id: existing.id },
      data: { isActive: true, activatedAt: new Date(), activatedBy: (req as any).user?.userId ?? null, pausedAt: null, pausedBy: null },
    });
    res.json({ data: (await present(req.tenantId!, [flow as any], true))[0], warnings });
  } catch (err) { fail(res, err, "activate the automation"); }
});

router.post("/:id/pause", CAN_PUBLISH, async (req: Request, res: Response) => {
  try {
    const existing = await findAutomation(req.tenantId!, String(req.params.id));
    if (!existing) { res.status(404).json({ error: "Automation not found" }); return; }
    const flow = await prisma.chatbotFlow.update({
      where: { id: existing.id },
      data: { isActive: false, pausedAt: new Date(), pausedBy: (req as any).user?.userId ?? null },
    });
    res.json({ data: (await present(req.tenantId!, [flow as any], true))[0] });
  } catch (err) { fail(res, err, "pause the automation"); }
});

router.delete("/:id", CAN_WRITE, async (req: Request, res: Response) => {
  try {
    const existing = await findAutomation(req.tenantId!, String(req.params.id));
    if (!existing) { res.status(404).json({ error: "Automation not found" }); return; }
    // A conversation parked on one of its runs is released, not left on a dead cursor.
    const runIds = (await prisma.automationRun.findMany({ where: { tenantId: req.tenantId!, flowId: existing.id, status: "waiting" }, select: { id: true } })).map((r: any) => r.id);
    if (runIds.length) {
      await prisma.conversation.updateMany({
        where: { tenantId: req.tenantId!, automationRunId: { in: runIds } },
        data: { automationRunId: null, chatbotNodeId: null, chatbotFlowId: null },
      });
    }
    await prisma.chatbotFlow.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (err) { fail(res, err, "delete the automation"); }
});

// ── Run log ────────────────────────────────────────────────────────────────

/** Which of these runs the viewer may see (a run in a conversation they may not see is hidden). */
async function runsVisible(req: Request, runs: Array<{ conversationId: string | null }>): Promise<boolean[]> {
  const clause = visibilityClause(viewerOf(req));
  if (!clause) return runs.map(() => true);
  const ids = [...new Set(runs.map((r) => r.conversationId).filter((x): x is string => !!x))];
  const visible = ids.length
    ? new Set((await prisma.conversation.findMany({ where: { tenantId: req.tenantId!, id: { in: ids }, OR: clause }, select: { id: true } })).map((c: any) => c.id))
    : new Set<string>();
  return runs.map((r) => !r.conversationId || visible.has(r.conversationId));
}

async function presentRuns(tenantId: string, runs: any[]) {
  const contactIds = [...new Set(runs.map((r) => r.contactId).filter(Boolean))] as string[];
  const contacts = contactIds.length
    ? await prisma.contact.findMany({ where: { tenantId, id: { in: contactIds } }, select: { id: true, displayName: true } })
    : [];
  const nameBy = new Map((contacts as any[]).map((c) => [c.id, c.displayName ?? null]));
  return runs.map((r) => ({
    id: r.id, automationId: r.flowId, triggerType: r.triggerType, status: r.status,
    conversationId: r.conversationId ?? null,
    contact: r.contactId ? { id: r.contactId, name: nameBy.get(r.contactId) ?? null } : null,
    startedAt: r.startedAt, endedAt: r.endedAt ?? null, error: r.error ?? null,
    answeredInbound: !!r.answeredInbound,
  }));
}

router.get("/:id/runs", async (req: Request, res: Response) => {
  try {
    const f = await findAutomation(req.tenantId!, String(req.params.id));
    if (!f) { res.status(404).json({ error: "Automation not found" }); return; }
    const take = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : null;
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status : null;
    const rows = await prisma.automationRun.findMany({
      where: { tenantId: req.tenantId!, flowId: f.id, ...(status ? { status } : {}) },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    // hasMore and the cursor come from the raw page, BEFORE hiding rows the
    // viewer may not see: filtering first would end paging early.
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const ok = await runsVisible(req, page as any);
    res.json({
      data: await presentRuns(req.tenantId!, page.filter((_, i) => ok[i])),
      nextCursor: hasMore ? (page[page.length - 1] as any).id : null,
    });
  } catch (err) { fail(res, err, "list runs"); }
});

router.get("/:id/node-stats", async (req: Request, res: Response) => {
  try {
    const f = await findAutomation(req.tenantId!, String(req.params.id));
    if (!f) { res.status(404).json({ error: "Automation not found" }); return; }
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await prisma.automationRunStep.groupBy({
      by: ["nodeId", "status", "branch"],
      where: { tenantId: req.tenantId!, run: { flowId: f.id }, at: { gte: since } },
      _count: { _all: true },
    });
    const out: Record<string, { reached: number; failed: number; branches: Record<string, number> }> = {};
    for (const r of rows as any[]) {
      const s = (out[r.nodeId] ??= { reached: 0, failed: 0, branches: {} });
      const n = r._count._all as number;
      if (r.status !== "waiting") s.reached += n; // a waiting step is completed by a later row
      if (r.status === "failed") s.failed += n;
      if (r.branch) s.branches[r.branch] = (s.branches[r.branch] ?? 0) + n;
    }
    res.json({ data: out, days });
  } catch (err) { fail(res, err, "read node stats"); }
});

export default router;
