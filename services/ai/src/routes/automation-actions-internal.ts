/**
 * Actions an automation (Studio > Automations) asks of the ai service, which
 * owns the CRM adapters. Internal only (X-Internal-Key): the caller is the
 * flow walker in incoming-worker, never a browser.
 *
 *   POST /api/internal/automation-actions/create-task
 *     { tenantId, conversationId, title, body?, dueInMinutes? }
 *     → 200 { ok: true, taskId } | 422 { ok: false, reason }
 *
 * The task goes to the customer's record in the tenant's CRM by the same
 * kind-aware path the post-conversation summary uses. No CRM link or a CRM
 * that cannot hold tasks is a reason, never a pretend success.
 */
import { Router, type Request, type Response } from "express";
import { requireInternalKey, writeAudit, prisma } from "@chatcenter/shared";
import { createCrmTaskKindAware } from "../services/post-conversation-crm.service";

const router = Router();
router.use(requireInternalKey);

router.post("/create-task", async (req: Request, res: Response) => {
  const { tenantId, conversationId, title, body, dueInMinutes } = req.body ?? {};
  if (!tenantId || !conversationId || typeof title !== "string" || !title.trim()) {
    res.status(400).json({ ok: false, reason: "tenantId, conversationId and title are required" });
    return;
  }
  try {
    const conv = await prisma.conversation.findFirst({ where: { id: String(conversationId), tenantId: String(tenantId) }, select: { id: true } });
    if (!conv) { res.status(404).json({ ok: false, reason: "conversation_not_found" }); return; }
    const due = Number(dueInMinutes) > 0 ? new Date(Date.now() + Number(dueInMinutes) * 60_000).toISOString() : undefined;
    const r = await createCrmTaskKindAware({
      tenantId: String(tenantId),
      conversationId: conv.id,
      task: { subject: title.trim().slice(0, 200), body: typeof body === "string" ? body.slice(0, 2000) : undefined, priority: "normal", due_at: due },
      sourceInteractionId: conv.id,
    });
    await writeAudit({
      tenantId: String(tenantId), actorType: "system", action: "automation.create_task",
      targetType: "conversation", targetId: conv.id,
      metadata: { ok: r.ok, reason: r.reason ?? null, kind: r.kind, taskId: r.taskId ?? null },
    });
    if (!r.ok) { res.status(422).json({ ok: false, reason: r.reason ?? "skipped" }); return; }
    res.json({ ok: true, taskId: r.taskId ?? null });
  } catch (err: any) {
    console.error("[automation-actions] create-task failed:", err?.message);
    res.status(500).json({ ok: false, reason: "failed" });
  }
});

export default router;
