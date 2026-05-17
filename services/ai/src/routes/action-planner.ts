import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { authenticate, resolveTenant, requireActiveTenant } from "@chatcenter/shared";
import { generateResponse } from "../services/ai.service";
import { executeAction, PlannedAction as ExecPlannedAction } from "../services/action-executor.service";
import {
  getAvailableTools,
  renderPlannerTools,
  renderSystemCapabilities,
} from "../services/tool-registry";

/**
 * Command Center prompts live on disk as editable markdown files under
 * `services/ai/src/prompts/`. They are loaded once at module init. Edit the
 * .md files to tune the planner/classifier behavior — no code change needed.
 *
 *  - action-planner.md   : main ExecutionPlan system prompt. Must contain
 *                          `{{toolsBlock}}` and `{{capabilitiesBlock}}`
 *                          placeholders that are filled per-tenant at
 *                          request time by getAvailableTools().
 *  - intent-classifier.md: the chat/execution/ambiguous gate prompt.
 */
const PROMPTS_DIR = path.resolve(__dirname, "../prompts");
const ACTION_PLANNER_TEMPLATE = fs
  .readFileSync(path.join(PROMPTS_DIR, "action-planner.md"), "utf8")
  .trim();
const INTENT_CLASSIFIER_PROMPT = fs
  .readFileSync(path.join(PROMPTS_DIR, "intent-classifier.md"), "utf8")
  .trim();

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
  | "update_contact"
  | "create_ticket"
  | "create_task"
  | "schedule_followup"
  | "tag_contact"
  | "get_contact"
  | "get_conversation"
  | "list_recent_messages"
  | "preview_broadcast"
  | "schedule_broadcast"
  | "create_workflow"
  | "list_workflows"
  | "resolve_identity"
  | "merge_contacts"
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

function buildSystemPrompt(toolsBlock: string, capabilitiesBlock: string): string {
  return ACTION_PLANNER_TEMPLATE
    .replace("{{toolsBlock}}", toolsBlock)
    .replace("{{capabilitiesBlock}}", capabilitiesBlock);
}

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

    const tools = await getAvailableTools(req.tenantId!, context);
    const systemPrompt = buildSystemPrompt(
      renderPlannerTools(tools),
      renderSystemCapabilities(tools),
    );
    const response = await generateResponse({
      tenantId: req.tenantId!,
      messages: [
        { role: "system", content: systemPrompt },
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

// POST /classify — decide chat vs execution mode for a prompt.
router.post("/classify", async (req: Request, res: Response) => {
  try {
    const { prompt, context } = req.body ?? {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt (string) is required" });
    }
    const result = await classifyIntent(req.tenantId!, prompt, context);
    return res.json(result);
  } catch (err: any) {
    console.error("action-planner.classify error:", err);
    return res.status(500).json({ error: "Failed to classify", detail: err?.message });
  }
});

async function classifyIntent(
  tenantId: string,
  prompt: string,
  context?: unknown,
): Promise<{ mode: "chat" | "execution"; confidence: number; answer: string | null; clarification: string | null }> {
  try {
    const resp = await generateResponse({
      tenantId,
      messages: [
        { role: "system", content: INTENT_CLASSIFIER_PROMPT },
        {
          role: "user",
          content:
            `Input: ${prompt}` +
            (context ? `\n\nContext:\n${JSON.stringify(context).slice(0, 2000)}` : ""),
        },
      ],
      temperature: 0.1,
      responseFormat: { type: "json_object" },
      metadata: { type: "intent_classify" },
    });
    const parsed = JSON.parse(resp.content);
    const mode: "chat" | "execution" = parsed.mode === "execution" ? "execution" : "chat";
    return {
      mode,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      answer: typeof parsed.answer === "string" ? parsed.answer : null,
      clarification: typeof parsed.clarification === "string" ? parsed.clarification : null,
    };
  } catch {
    // Fallback: treat as execution so existing behavior is preserved.
    return { mode: "execution", confidence: 0.3, answer: null, clarification: null };
  }
}

// POST /simulate — dual-mode. Classifies first: chat-mode returns a natural
// answer with no plan; execution-mode plans + dry-run executes as before.
router.post("/simulate", async (req: Request, res: Response) => {
  try {
    const { prompt, context } = req.body ?? {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt (string) is required" });
    }

    // Dual-mode gate: question vs action.
    const intent = await classifyIntent(req.tenantId!, prompt, context);
    if (intent.mode === "chat") {
      return res.json({
        mode: "chat",
        answer: intent.answer ?? intent.clarification ?? "",
        clarification: intent.clarification,
        plan: null,
        results: [],
      });
    }

    const tools = await getAvailableTools(req.tenantId!, context);
    const systemPrompt = buildSystemPrompt(
      renderPlannerTools(tools),
      renderSystemCapabilities(tools),
    );
    const planResp = await generateResponse({
      tenantId: req.tenantId!,
      messages: [
        { role: "system", content: systemPrompt },
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
    const authToken = (req.headers.authorization as string | undefined) ?? undefined;
    const results: any[] = [];
    for (const step of plan.steps as ExecPlannedAction[]) {
      results.push(
        await executeAction(req.tenantId!, step, {
          actorId,
          dryRun: true,
          approved: true,
          approvedBy: actorId,
          authToken,
        }),
      );
    }
    return res.json({ mode: "execution", plan, results, usage: planResp.usage });
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
    const { plan, approved, approvedBy, dryRun, idempotencyKey } = req.body ?? {};
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
    const authToken = (req.headers.authorization as string | undefined) ?? undefined;
    const results: any[] = [];
    // approvedBy comes from the request body when the caller is the
    // approvals-dispatch path (records WHO approved, not who is currently
    // making the HTTP call). Falls back to the authenticated user when the
    // body doesn't carry it (legacy /simulate-style callers).
    const effectiveApprovedBy =
      approved === true
        ? (typeof approvedBy === "string" && approvedBy ? approvedBy : actorId)
        : undefined;
    for (const step of plan.steps as ExecPlannedAction[]) {
      const r = await executeAction(req.tenantId!, step, {
        actorId,
        approved: approved === true,
        approvedBy: effectiveApprovedBy,
        dryRun: dryRun === true,
        idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : undefined,
        authToken,
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
