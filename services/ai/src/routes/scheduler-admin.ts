/**
 * Scheduler admin routes - meeting types + calendar account status.
 *
 * Used by the dashboard's Scheduler settings page:
 *   GET    /meeting-types?aiAgentId=...
 *   POST   /meeting-types
 *   PATCH  /meeting-types/:id
 *   DELETE /meeting-types/:id
 *   GET    /calendar-accounts?aiAgentId=...
 *
 * All endpoints require ADMIN role and an active tenant. Tokens are NEVER
 * returned to the client - only the connection status, provider, and
 * account email for display.
 */

import { Router, type Request, type Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";

const router = Router();

router.use(authenticate, resolveTenant, requireActiveTenant());

// ─── Meeting Types ─────────────────────────────────────────

router.get("/meeting-types", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const rows = await (prisma as any).meetingType.findMany({
    where: { tenantId: req.tenantId },
    orderBy: { createdAt: "asc" },
  });
  res.json({ data: rows });
});

router.post("/meeting-types", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const b = req.body || {};
  const required = ["slug", "name", "durationMinutes", "agentTimezone", "workingHours"];
  for (const k of required) {
    if (b[k] === undefined || b[k] === null || b[k] === "") {
      res.status(400).json({ error: `${k} is required` });
      return;
    }
  }
  if (![15, 30, 45, 60].includes(Number(b.durationMinutes))) {
    res.status(400).json({ error: "durationMinutes must be 15|30|45|60" });
    return;
  }
  try {
    const row = await (prisma as any).meetingType.create({
      data: {
        tenantId: req.tenantId,
        slug: String(b.slug),
        name: String(b.name),
        description: b.description ?? null,
        durationMinutes: Number(b.durationMinutes),
        agentTimezone: String(b.agentTimezone),
        workingHours: b.workingHours,
        meetingTypeWindows: b.meetingTypeWindows ?? null,
        bufferBeforeMinutes: Number(b.bufferBeforeMinutes ?? 15),
        bufferAfterMinutes: Number(b.bufferAfterMinutes ?? 15),
        minNoticeHours: Number(b.minNoticeHours ?? 4),
        maxHorizonDays: Number(b.maxHorizonDays ?? 30),
        slotResolutionMinutes: Number(b.slotResolutionMinutes ?? 30),
        autoGuests: Array.isArray(b.autoGuests) ? b.autoGuests : [],
        isActive: b.isActive !== false,
      },
    });
    res.status(201).json({ data: row });
  } catch (err: any) {
    if (/Unique/i.test(err?.message || "")) {
      res.status(409).json({ error: "slug already exists for this tenant" });
      return;
    }
    res.status(500).json({ error: err?.message || "create failed" });
  }
});

router.patch("/meeting-types/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const b = req.body || {};
  const data: any = {};
  for (const k of [
    "name", "description", "agentTimezone", "workingHours", "meetingTypeWindows",
    "bufferBeforeMinutes", "bufferAfterMinutes", "minNoticeHours",
    "maxHorizonDays", "slotResolutionMinutes", "isActive", "durationMinutes",
    "autoGuests",
  ]) {
    if (b[k] !== undefined) data[k] = b[k];
  }
  try {
    const row = await (prisma as any).meetingType.update({
      where: { id: req.params.id, tenantId: req.tenantId } as any,
      data,
    });
    res.json({ data: row });
  } catch (err: any) {
    res.status(404).json({ error: err?.message || "not found" });
  }
});

router.delete("/meeting-types/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  await (prisma as any).meetingType.deleteMany({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  res.json({ ok: true });
});

// ─── Calendar account status (no credentials returned) ─────

router.get("/calendar-accounts", requireRole("ADMIN"), async (req: Request, res: Response) => {
  // OPTIONAL since 20260923120000 made `aiAgentId` nullable.
  //
  // It used to be required and 400 without it, which meant an account whose
  // employee had been deleted was not merely unowned but UNREACHABLE: the only
  // listing was keyed by an agent id that no longer existed, so the merchant
  // kept a live Google grant with no route to see or disconnect it. Making the
  // column nullable without this change would have moved the row from "cannot
  // be null" to "null and invisible".
  //
  // Omitted now means "every calendar account this tenant has, owned or not".
  // Supplied keeps today's behaviour exactly, so no existing caller changes.
  const aiAgentId = String(req.query.aiAgentId || "");
  const rows = await (prisma as any).calendarAccount.findMany({
    where: { tenantId: req.tenantId, ...(aiAgentId ? { aiAgentId } : {}) },
    select: {
      id: true,
      // Returned so a caller listing everything can tell an OWNED account from
      // an orphaned one. Without it the unfiltered list is a set of rows nobody
      // can attribute, which is the same invisibility in a different shape.
      aiAgentId: true,
      provider: true,
      status: true,
      accountEmail: true,
      defaultCalendarId: true,
      tokenExpiresAt: true,
      lastError: true,
      lastSyncedAt: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  res.json({ data: rows });
});

export default router;
