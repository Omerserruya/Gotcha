import { Router, Request, Response } from "express";
import { authenticate, resolveTenant, requireActiveTenant } from "@chatcenter/shared";
import { generateResponse } from "../services/ai.service";

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
- If the request is ambiguous, return a single "noop" step with reason explaining the ambiguity.
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

export default router;
