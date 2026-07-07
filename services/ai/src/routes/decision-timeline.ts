/**
 * Decision Timeline (P1-5) — the read surface that turns the kernel's persisted
 * loop trace into an owner-facing "why did the AI do that?" story. Read-only
 * over agent_loop_runs + agent_loop_iterations (already written every turn);
 * it never triggers reasoning.
 *
 *   GET /conversation/:id  — the ordered runs for one conversation, each with
 *                            its iterations projected to a compact trace:
 *                            what it read (situation), what it decided, which
 *                            operation ran, what it observed, tokens/latency.
 *
 * Tenant-scoped + ADMIN-only, matching sibling admin routes.
 */

import { Router, type Request, type Response } from "express";
import { authenticate, resolveTenant, requireActiveTenant, requireRole, prisma } from "@chatcenter/shared";

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

/** A facts snapshot is large; project only what the timeline shows. */
function projectFacts(f: any): { billing?: unknown; withinLimits?: boolean; menu: string[]; allowed: string[] } {
  return {
    billing: f?.billing?.status,
    withinLimits: f?.entitlements?.withinLimits,
    menu: Array.isArray(f?.availableOperations) ? f.availableOperations.map((o: any) => o.name) : [],
    allowed: Array.isArray(f?.permissions?.allowedOperations) ? f.permissions.allowedOperations : [],
  };
}

function observationText(o: unknown): string | undefined {
  if (o == null) return undefined;
  if (typeof o === "string") return o;
  const obj = o as any;
  const detail = obj.outcome ?? obj.reason ?? "";
  const data = obj.data ? ` | data: ${obj.data}` : "";
  return `${obj.operation ?? ""} → ${obj.status ?? ""}${detail ? `: ${detail}` : ""}${data}`.trim();
}

router.get("/conversation/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const conversationId = req.params.id as string;

    const runs = await (prisma as any).agentLoopRun.findMany({
      where: { tenantId, conversationId },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    if (runs.length === 0) { res.json({ data: { conversationId, runs: [] } }); return; }

    const loopIds = runs.map((r: any) => r.loopId);
    const iters = await (prisma as any).agentLoopIteration.findMany({
      where: { tenantId, loopId: { in: loopIds } },
      orderBy: [{ loopId: "asc" }, { iteration: "asc" }],
      take: 1000,
    });
    const byLoop = new Map<string, any[]>();
    for (const it of iters) {
      (byLoop.get(it.loopId) ?? byLoop.set(it.loopId, []).get(it.loopId)!).push(it);
    }

    const data = runs.map((r: any) => ({
      loopId: r.loopId,
      turnId: r.turnId,
      mode: r.mode,
      goal: r.goal,
      terminationReason: r.terminationReason,
      iterationCount: r.iterationCount,
      spentUnits: r.spentUnits,
      wallMs: r.wallMs,
      model: r.model,
      provider: r.provider,
      reply: r.reply,
      createdAt: r.createdAt,
      iterations: (byLoop.get(r.loopId) ?? []).map((it: any) => ({
        iteration: it.iteration,
        reasoningSummary: it.reasoningSummary,
        decisionType: it.decisionType,
        proposedOperation: it.proposedOperation,
        runtimeResult: it.runtimeResult,
        observation: observationText(it.observation),
        progressed: it.progressed,
        facts: it.iteration === 1 ? projectFacts(it.oracleFactsSnapshot) : undefined,
        inputTokens: it.inputTokens,
        outputTokens: it.outputTokens,
        latencyMs: it.latencyMs,
      })),
    }));

    res.json({ data: { conversationId, runs: data } });
  } catch (err: any) {
    console.error("[decision-timeline] failed:", err?.message);
    res.status(500).json({ error: "Failed to load decision timeline" });
  }
});

export default router;
