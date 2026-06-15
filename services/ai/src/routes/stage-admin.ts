/**
 * Stage transition admin routes.
 *
 *   POST /stage-transitions/conversations/:id/override   - manual stage change
 *   GET  /stage-transitions/conversations/:id            - audit log for a conversation
 *   GET  /stage-transitions/contacts/:id                 - audit log for a contact
 *
 * Mounted under `/api/stage-transitions` so the nginx routing doesn't
 * collide with `/api/conversations` (which proxies to the conversation
 * service, not the AI service).
 *
 * Manual override path:
 *   - Resolve the active funnel for the conversation's department.
 *   - Validate the target stage exists in the funnel and has a crmValue.
 *   - Write the vendor stage via applyCrmPatchKindAware (same path the
 *     post-call auto-advance uses).
 *   - Update Contact.metadata.crmStageCache so the next call resolves
 *     immediately to the new stage.
 *   - Insert a StageTransition row with source=MANUAL, actorId=user.id.
 *   - Broadcast a `crm.stage.changed` event so the live workspace
 *     refreshes its stage card without a full reload.
 */

import { Router, type Request, type Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  publishEvent,
} from "@chatcenter/shared";
import { loadFunnelForTenant, invalidateFunnelCache } from "../services/funnel-config.repo";
import { applyCrmPatchKindAware } from "../services/post-conversation-crm.service";
import { recordStageTransition, listStageTransitions } from "../services/stage-transition-audit.service";
import { resolveActiveStage } from "../services/intelligence/stage-resolver.service";

const router = Router();

router.use(
  "/stage-transitions",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
);

// ─── POST /stage-transitions/conversations/:id/override ─────

router.post(
  "/stage-transitions/conversations/:id/override",
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    const conversationId = String(req.params.id);
    const body = req.body || {};
    const toStageId = typeof body.to === "string" ? body.to.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";

    if (!toStageId) {
      res.status(400).json({ error: "to is required" });
      return;
    }

    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { departmentId: true, channel: true, customerExternalId: true },
    });
    if (!conv) {
      res.status(404).json({ error: "conversation_not_found" });
      return;
    }

    const funnel = await loadFunnelForTenant({
      tenantId,
      departmentId: conv.departmentId ?? null,
    });
    if (!funnel) {
      res.status(400).json({ error: "no_funnel_configured" });
      return;
    }
    const target = funnel.stages.find((s) => s.id === toStageId);
    if (!target) {
      res.status(400).json({ error: "stage_not_in_funnel", details: { toStageId } });
      return;
    }
    if (!target.crmValue || target.crmValue.trim().length === 0) {
      res.status(400).json({
        error: "stage_has_no_vendor_value",
        details: { toStageId, hint: "Set crmValue on the funnel stage so the vendor knows which stage to write." },
      });
      return;
    }

    const current = await resolveActiveStage({
      tenantId,
      conversationId,
      departmentId: conv.departmentId ?? null,
    });

    const contactId = await findContactIdFor(tenantId, conv);

    // Vendor write - same path the post-call auto-advance uses, so the
    // CRM adapter / kind routing / activity logging stays consistent.
    let vendorOk = false;
    let vendorError: string | undefined;
    try {
      const r = await applyCrmPatchKindAware({
        tenantId,
        conversationId,
        fields: { stage: target.crmValue },
        sourceInteractionId: conversationId,
      });
      vendorOk = !!r.ok;
      vendorError = r.ok ? undefined : (r as any).reason ?? "vendor_write_failed";
    } catch (err: any) {
      vendorOk = false;
      vendorError = err?.message ?? "vendor_write_threw";
    }

    // Update the contact-side cache so the next live runner / panel
    // fetch sees the new value without waiting for a vendor re-poll.
    if (contactId && vendorOk) {
      try {
        const row = await (prisma as any).contact.findUnique({
          where: { id: contactId },
          select: { metadata: true },
        });
        const meta = (row?.metadata ?? {}) as Record<string, any>;
        meta.crmStageCache = {
          value: target.crmValue,
          vendor: meta.crmVendor ?? "manual",
          cachedAt: new Date().toISOString(),
        };
        await (prisma as any).contact.update({
          where: { id: contactId },
          data: { metadata: meta },
        });
      } catch (err: any) {
        // Non-fatal - vendor is authoritative. Log only.
        console.warn(
          "[stage-admin] contact cache update failed (non-fatal):",
          err?.message,
        );
      }
    }

    const audit = await recordStageTransition({
      tenantId,
      conversationId,
      contactId,
      funnelId: funnel.funnelId,
      fromStageId: current?.stage.id ?? null,
      fromStageLabel: current?.stage.label ?? null,
      toStageId: target.id,
      toStageLabel: target.label,
      source: "MANUAL",
      confidence: null,
      reason: reason || `manual override by ${(req as any).user?.email ?? "agent"}`,
      evidence: [],
      criteriaMet: [],
      criteriaMissed: [],
      vendorValue: target.crmValue,
      vendorWriteOk: vendorOk,
      vendorWriteError: vendorError ?? null,
      actorId: (req as any).user?.id ?? null,
    });

    // Broadcast so the live workspace can refresh its stage card without
    // a full CRM-context re-fetch (the card already subscribes to
    // socket events).
    try {
      await publishEvent({
        tenantId,
        event: "crm.stage.changed",
        data: {
          conversationId,
          fromStageId: current?.stage.id ?? null,
          toStageId: target.id,
          toStageLabel: target.label,
          source: "MANUAL",
          actorId: (req as any).user?.id ?? null,
        },
      });
    } catch {
      /* best-effort */
    }

    // Bump the cache so subsequent reads in this tenant pick up the new
    // funnel state (the funnel itself didn't change but its derived
    // active-stage view did).
    invalidateFunnelCache(tenantId);

    res.json({
      data: {
        ok: vendorOk,
        from: current
          ? { id: current.stage.id, label: current.stage.label }
          : null,
        to: { id: target.id, label: target.label },
        vendorValue: target.crmValue,
        vendorWriteOk: vendorOk,
        vendorWriteError: vendorError ?? null,
        auditId: audit.id,
      },
    });
  },
);

// ─── GET /stage-transitions/conversations/:id ───────────────

router.get(
  "/stage-transitions/conversations/:id",
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    const conversationId = String(req.params.id);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
    const rows = await listStageTransitions({
      tenantId,
      conversationId,
      limit,
    });
    res.json({ data: rows });
  },
);

// ─── GET /stage-transitions/contacts/:id ────────────────────

router.get(
  "/stage-transitions/contacts/:id",
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    const contactId = String(req.params.id);
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const rows = await listStageTransitions({
      tenantId,
      contactId,
      limit,
    });
    res.json({ data: rows });
  },
);

// ─── helpers ───────────────────────────────────────────────

async function findContactIdFor(
  tenantId: string,
  conv: { channel: string; customerExternalId: string | null },
): Promise<string | null> {
  if (!conv.customerExternalId) return null;
  const c = await (prisma as any).contact.findFirst({
    where: {
      tenantId,
      channel: conv.channel as any,
      externalId: conv.customerExternalId,
    },
    select: { id: true },
  });
  return c?.id ?? null;
}

export default router;
