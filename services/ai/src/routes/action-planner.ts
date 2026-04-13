import { Router, Request, Response } from "express";
import { authenticate, resolveTenant, requireActiveTenant } from "@chatcenter/shared";
import { generateResponse } from "../services/ai.service";
import { executeAction, PlannedAction as ExecPlannedAction } from "../services/action-executor.service";

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

/**
 * ActionSchema — structured tool-calling format consumed by the
 * Action Engine (F3). Every AI-driven operation flows through this shape.
 */
export type ActionTool =
  | "send_message"
  | "create_broadcast"
  | "update_crm"
  | "create_ticket"
  | "schedule_followup"
  | "tag_contact"
  | "noop";

export interface PlannedAction {
  tool: ActionTool;
  params: Record<string, unknown>;
  reason: string;
  riskLevel: "low" | "medium" | "high";
}

export interface ExecutionPlan {
  summary: string;
  steps: PlannedAction[];
  requiresApproval: boolean;
}

const SYSTEM_PROMPT = `You are the GOTCHA Action Planner.
You convert a user's natural-language request into a structured ExecutionPlan.

Rules:
- Respect service boundaries — only use the documented tools.
- Prefer the simplest correct plan. Reuse existing data, do not invent state.
- Use the provided Context (conversationId, contactId) whenever present —
  the user already selected it. Do not ask the user to specify it again.
- Be PROACTIVE: even if the prompt is terse, infer the most likely intent
  and propose a plan. Only return a single "noop" step when the request
  genuinely cannot map to any available tool.
- Mark riskLevel="high" for anything financial, external-facing broadcasts, or irreversible.
- Set requiresApproval=true if ANY step is high-risk.

Return STRICT JSON with shape:
{
  "summary": string,
  "steps": [
    { "tool": string, "params": object, "reason": string, "riskLevel": "low"|"medium"|"high" }
  ],
  "requiresApproval": boolean
}

Available tools:
- send_message(contactId, channel, body)
- create_broadcast(name, audience, templateId)
- update_crm(contactId, fields)
- create_ticket(contactId, subject, body, priority)
- schedule_followup(contactId, delayHours, body)
- tag_contact(contactId, tags[])
- noop(note)`;

// POST /plan — produce an ExecutionPlan for a prompt (dry-run by default)
router.post("/plan", async (req: Request, res: Response) => {
  try {
    const { prompt, context } = req.body ?? {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt (string) is required" });
    }

    const userContent =
      `Request: ${prompt}` +
      (context ? `\n\nContext:\n${JSON.stringify(context).slice(0, 4000)}` : "");

    const response = await generateResponse({
      tenantId: req.tenantId!,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.1,
      responseFormat: { type: "json_object" },
      metadata: { type: "action_plan" },
    });

    let plan: ExecutionPlan;
    try {
      plan = JSON.parse(response.content);
    } catch {
      return res.status(502).json({ error: "Planner returned non-JSON", raw: response.content });
    }

    // Defensive normalization
    plan.steps = Array.isArray(plan.steps) ? plan.steps : [];
    plan.requiresApproval =
      plan.requiresApproval === true || plan.steps.some((s) => s?.riskLevel === "high");

    return res.json({ plan, usage: response.usage });
  } catch (err: any) {
    console.error("action-planner.plan error:", err);
    return res.status(500).json({ error: "Failed to generate plan", detail: err?.message });
  }
});

// POST /simulate — one-shot "plan + dry-run execute". Handy for the F2.5
// dry-run preview: the UI sends a prompt, gets back the plan AND the
// executor's predicted outcomes without touching real state.
router.post("/simulate", async (req: Request, res: Response) => {
  try {
    const { prompt, context } = req.body ?? {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt (string) is required" });
    }

    const planResp = await generateResponse({
      tenantId: req.tenantId!,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `Request: ${prompt}` +
            (context ? `\n\nContext:\n${JSON.stringify(context).slice(0, 4000)}` : ""),
        },
      ],
      temperature: 0.1,
      responseFormat: { type: "json_object" },
      metadata: { type: "action_simulate" },
    });

    let plan: ExecutionPlan;
    try {
      plan = JSON.parse(planResp.content);
    } catch {
      return res.status(502).json({ error: "Planner returned non-JSON", raw: planResp.content });
    }
    plan.steps = Array.isArray(plan.steps) ? plan.steps : [];
    plan.requiresApproval =
      plan.requiresApproval === true || plan.steps.some((s) => s?.riskLevel === "high");

    const actorId = (req as any).user?.id;
    const results: any[] = [];
    for (const step of plan.steps as ExecPlannedAction[]) {
      results.push(
        await executeAction(req.tenantId!, step, { actorId, dryRun: true, approved: true, approvedBy: actorId }),
      );
    }
    return res.json({ plan, results, usage: planResp.usage });
  } catch (err: any) {
    console.error("action-planner.simulate error:", err);
    return res.status(500).json({ error: "Failed to simulate", detail: err?.message });
  }
});

// F4.2 — Approval queue: list pending high-risk actions that were blocked
router.get("/approvals", async (req: Request, res: Response) => {
  try {
    const { prisma } = await import("@chatcenter/shared");
    const rows = await prisma.auditLog.findMany({
      where: {
        tenantId: req.tenantId!,
        actorType: "ai",
        action: { startsWith: "action." },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const pending = rows.filter((r) => {
      const m = (r.metadata as any) || {};
      return m.blocked === true && m.reason === "high-risk action requires approval";
    });
    return res.json({ data: pending });
  } catch (err: any) {
    console.error("action-planner.approvals error:", err);
    return res.status(500).json({ error: "Failed to list approvals" });
  }
});

// POST /execute — run a previously planned ExecutionPlan (F3 Action Engine)
router.post("/execute", async (req: Request, res: Response) => {
  try {
    const { plan, approved, dryRun, idempotencyKey } = req.body ?? {};
    if (!plan || !Array.isArray(plan.steps)) {
      return res.status(400).json({ error: "plan.steps[] required" });
    }

    // Scenario 3 chaos fix: honor idempotency key to prevent double execution.
    // If we already have any AuditLog entry with this key for this tenant,
    // short-circuit and return the cached response.
    if (typeof idempotencyKey === "string" && idempotencyKey.length > 0) {
      const { prisma } = await import("@chatcenter/shared");
      const prior = await prisma.auditLog.findFirst({
        where: {
          tenantId: req.tenantId!,
          action: { startsWith: "action." },
          metadata: { path: ["idempotencyKey"], equals: idempotencyKey } as any,
        },
      });
      if (prior) {
        return res.json({ results: [], replayed: true, idempotencyKey });
      }
    }

    const actorId = (req as any).user?.id;
    const results: any[] = [];
    for (const step of plan.steps as ExecPlannedAction[]) {
      const r = await executeAction(req.tenantId!, step, {
        actorId,
        approved: approved === true,
        approvedBy: approved === true ? actorId : undefined,
        dryRun: dryRun === true,
        idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : undefined,
      });
      results.push(r);
    }
    return res.json({ results });
  } catch (err: any) {
    console.error("action-planner.execute error:", err);
    return res.status(500).json({ error: "Failed to execute plan", detail: err?.message });
  }
});

export default router;
