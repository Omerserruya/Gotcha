import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";

const router = Router();

// Accept either `priority` or `position` from the client during the rename
// window. Remove priority-key acceptance once the frontend no longer emits it.
function normalizePositionInput<T extends { priority?: number; position?: number }>(body: T): T {
  if (typeof body.position !== "number" && typeof body.priority === "number") {
    (body as any).position = body.priority;
  }
  delete (body as any).priority;
  return body;
}

// ─── List Router Rules (ordered by position; defaults last) ──
router.get("/", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const rules = await prisma.routerRule.findMany({
      where: { tenantId: req.tenantId! as string },
      include: {
        aiAgent: { select: { id: true, name: true, role: true, status: true } },
      },
      orderBy: [{ isDefault: "asc" }, { position: "asc" as any }],
    });

    // Enrich flow targets with names
    const flowIds = rules
      .filter(r => r.routeType === "FLOW" && r.routeTarget)
      .map(r => r.routeTarget!);

    const flows = flowIds.length > 0
      ? await prisma.chatbotFlow.findMany({
          where: { tenantId: req.tenantId! as string, id: { in: flowIds } },
          select: { id: true, name: true },
        })
      : [];

    const flowMap = new Map(flows.map(f => [f.id, f.name]));

    const enriched = rules.map(rule => ({
      ...rule,
      routeTargetName: rule.routeType === "AI_AGENT" && rule.aiAgent
        ? rule.aiAgent.name
        : rule.routeType === "FLOW" && rule.routeTarget
        ? flowMap.get(rule.routeTarget) || rule.routeTarget
        : rule.routeTarget || "Unassigned",
    }));

    res.json({ data: enriched });
  } catch (err) {
    console.error("List router rules error:", err);
    res.status(500).json({ error: "Failed to list router rules" });
  }
});

// ─── Get Router Rule by ID ───────────────────────────────────
router.get("/:id", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const rule = await prisma.routerRule.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
      include: {
        aiAgent: { select: { id: true, name: true, role: true } },
      },
    });

    if (!rule) {
      res.status(404).json({ error: "Router rule not found" });
      return;
    }

    res.json({ data: rule });
  } catch (err) {
    console.error("Get router rule error:", err);
    res.status(500).json({ error: "Failed to get router rule" });
  }
});

// ─── Create Router Rule ──────────────────────────────────────
router.post("/", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const body = normalizePositionInput(req.body);
    const { name, conditions, logic, routeType, routeTarget, enabled, isDefault } = body;

    if (!name || !routeType) {
      res.status(400).json({ error: "Name and routeType are required" });
      return;
    }

    // Next position - appends to the end of the non-default list
    const maxPos = await prisma.routerRule.aggregate({
      where: { tenantId: req.tenantId! as string },
      _max: { position: true as any } as any,
    });
    const nextPosition = typeof body.position === "number" ? body.position : ((maxPos as any)._max.position ?? 0) + 1;

    // Determine aiAgentId for the relation
    const aiAgentId = routeType === "AI_AGENT" ? routeTarget : null;

    const rule = await prisma.routerRule.create({
      data: {
        tenantId: req.tenantId! as string,
        position: nextPosition as any,
        name,
        conditions: conditions || [],
        logic: logic || "AND",
        routeType,
        routeTarget: routeTarget || null,
        aiAgentId,
        enabled: enabled !== false,
        isDefault: isDefault || false,
      } as any,
    });

    res.status(201).json({ data: rule });
  } catch (err) {
    console.error("Create router rule error:", err);
    res.status(500).json({ error: "Failed to create router rule" });
  }
});

// ─── Update Router Rule ──────────────────────────────────────
router.patch("/:id", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.routerRule.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });

    if (!existing) {
      res.status(404).json({ error: "Router rule not found" });
      return;
    }

    const updateData: any = normalizePositionInput(req.body);

    // Sync aiAgentId with routeTarget when routeType is AI_AGENT
    if (updateData.routeType === "AI_AGENT" && updateData.routeTarget) {
      updateData.aiAgentId = updateData.routeTarget;
    } else if (updateData.routeType && updateData.routeType !== "AI_AGENT") {
      updateData.aiAgentId = null;
    }

    const rule = await prisma.routerRule.update({
      where: { id: req.params.id as string },
      data: updateData,
    });

    res.json({ data: rule });
  } catch (err) {
    console.error("Update router rule error:", err);
    res.status(500).json({ error: "Failed to update router rule" });
  }
});

// ─── Reorder Router Rules ────────────────────────────────────
// Client sends `ruleIds` in desired evaluation order. The server writes
// `position` = index + 1 for each. Default rules are automatically
// evaluated last by the live router regardless of their position value.
router.put("/reorder", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const { ruleIds } = req.body;

    if (!Array.isArray(ruleIds) || ruleIds.length === 0) {
      res.status(400).json({ error: "ruleIds array is required" });
      return;
    }

    const rules = await prisma.routerRule.findMany({
      where: { tenantId: req.tenantId! as string, id: { in: ruleIds } },
      select: { id: true },
    });

    if (rules.length !== ruleIds.length) {
      res.status(400).json({ error: "Some rule IDs are invalid" });
      return;
    }

    await prisma.$transaction(
      ruleIds.map((id: string, index: number) =>
        prisma.routerRule.update({
          where: { id },
          data: { position: (index + 1) as any } as any,
        })
      )
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Reorder router rules error:", err);
    res.status(500).json({ error: "Failed to reorder router rules" });
  }
});

// ─── Dry-run test: send a fake message through the evaluator ──
//
// Body: { message: string, channel?: string, tags?: string[] }
// Returns: full routing trace + which rule (or fallback) would win.
// No DB mutation. Admin only.
router.post("/test", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const { message, channel, tags } = req.body || {};
    if (typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "message (string) is required" });
      return;
    }

    // Re-implement the evaluator here in read-only mode so we don't pull in
    // incoming-worker as a dep. Mirrors routing.service.ts::previewRouting.
    const all = await prisma.routerRule.findMany({
      where: { tenantId: req.tenantId! as string, enabled: true },
      orderBy: [{ position: "asc" as any }],
    });
    const rules = [...all.filter(r => !r.isDefault), ...all.filter(r => r.isDefault)];

    // Intent conditions - batched via the AI service
    const intents = Array.from(new Set(
      rules.flatMap(r => ((r.conditions as any) ?? []).filter((c: any) => c.type === "intent").map((c: any) => c.value))
    ));

    let intentHits = new Set<string>();
    if (intents.length) {
      try {
        const aiUrl = process.env.AI_SERVICE_URL || "http://ai:4006";
        const intentRes = await fetch(`${aiUrl}/api/ai-assist/intent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Key": process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026" },
          body: JSON.stringify({ message, intents, tenantId: req.tenantId }),
        });
        const j: any = await intentRes.json().catch(() => ({}));
        if (Array.isArray(j?.data?.matches)) intentHits = new Set(j.data.matches);
        else if (j?.data?.match && typeof j.data.intent === "string") intentHits = new Set([j.data.intent]);
      } catch { /* degrade gracefully */ }
    }

    const lowerChan = (channel ?? "whatsapp").toLowerCase();
    const tagsArr: string[] = Array.isArray(tags) ? tags : [];

    const trace: any[] = [];
    let matched: any = null;
    for (const rule of rules) {
      const conditions = (rule.conditions as any[]) ?? [];
      const entry: any = { ruleId: rule.id, name: rule.name, isDefault: rule.isDefault, matched: false, condResults: [] };

      if (rule.isDefault) {
        entry.matched = true;
      } else if (conditions.length === 0) {
        entry.matched = true;
      } else {
        const results = conditions.map(c => {
          let r = false;
          if (c.type === "intent") {
            const raw = intentHits.has(c.value);
            r = c.operator === "is_not" ? !raw : raw;
          } else if (c.type === "channel") {
            const ch = lowerChan;
            const v = String(c.value ?? "").toLowerCase();
            r = c.operator === "is_not" ? ch !== v : ch === v;
          } else if (c.type === "keyword") {
            const lowerMsg = message.toLowerCase();
            const v = String(c.value ?? "").toLowerCase();
            if (c.operator === "equals") r = lowerMsg === v;
            else if (c.operator === "is_not") r = !lowerMsg.includes(v);
            else r = lowerMsg.includes(v);
          } else if (c.type === "tag") {
            const v = String(c.value ?? "").toLowerCase();
            const hasTag = tagsArr.some(t => t.toLowerCase() === v);
            r = c.operator === "is_not" ? !hasTag : hasTag;
          }
          entry.condResults.push({ type: c.type, operator: c.operator, value: c.value, result: r });
          return r;
        });
        entry.matched = rule.logic === "OR" ? results.some(Boolean) : results.every(Boolean);
      }

      trace.push(entry);
      if (entry.matched) {
        entry.stopped = true;
        matched = rule;
        break;
      }
    }

    // Fallback ladder
    let fallback: string | null = null;
    let fallbackTarget: string | null = null;
    if (!matched) {
      const t = await prisma.tenant.findUnique({
        where: { id: req.tenantId! as string },
        select: { defaultAgentId: true, defaultRoutineId: true, defaultDepartmentId: true } as any,
      }) as any;
      if (t?.defaultAgentId)       { fallback = "default_agent";      fallbackTarget = t.defaultAgentId; }
      else if (t?.defaultRoutineId){ fallback = "default_routine";    fallbackTarget = t.defaultRoutineId; }
      else if (t?.defaultDepartmentId) { fallback = "default_department"; fallbackTarget = t.defaultDepartmentId; }
      else                         { fallback = "unassigned";         fallbackTarget = null; }
    }

    res.json({
      data: {
        matchedRuleId: matched?.id ?? null,
        matchedRule:   matched ? { id: matched.id, name: matched.name, routeType: matched.routeType, routeTarget: matched.routeTarget, aiAgentId: matched.aiAgentId } : null,
        fallback,
        fallbackTarget,
        intentHits: Array.from(intentHits),
        trace,
      },
    });
  } catch (err) {
    console.error("Test router rule error:", err);
    res.status(500).json({ error: "Failed to test routing" });
  }
});

// ─── Delete Router Rule ──────────────────────────────────────
router.delete("/:id", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.routerRule.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });

    if (!existing) {
      res.status(404).json({ error: "Router rule not found" });
      return;
    }

    if (existing.isDefault) {
      res.status(409).json({ error: "Cannot delete the default fallback rule" });
      return;
    }

    await prisma.routerRule.delete({ where: { id: req.params.id as string } });
    res.json({ success: true });
  } catch (err) {
    console.error("Delete router rule error:", err);
    res.status(500).json({ error: "Failed to delete router rule" });
  }
});

export default router;
