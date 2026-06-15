/**
 * NotificationPreference admin CRUD.
 *
 *   GET    /notification-preferences          - list (optionally ?departmentId=...)
 *   POST   /notification-preferences          - create
 *   PATCH  /notification-preferences/:id      - update
 *   DELETE /notification-preferences/:id      - delete
 *
 * ADMIN role required.
 *
 * Validates the four free-form JSON fields (recipients, channels, priority,
 * conditions) before persisting so a malformed payload can't bring down the
 * dispatcher worker at runtime.
 */

import { Router, type Request, type Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";

const router = Router();

router.use("/notification-preferences", authenticate, resolveTenant, requireActiveTenant());

const VALID_PRIORITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
const VALID_CHANNELS = new Set(["email", "in_app", "slack", "sms", "webhook"]);
const VALID_RECIPIENT_TYPES = new Set(["tenant_owner", "department_manager", "users"]);
const VALID_CONDITION_OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains"]);

interface ValidationError { field: string; message: string }

function validateRecipients(v: unknown): ValidationError | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return { field: "recipients", message: "must be an object" };
  }
  const r = v as any;
  if (!VALID_RECIPIENT_TYPES.has(r.type)) {
    return { field: "recipients.type", message: `must be one of ${[...VALID_RECIPIENT_TYPES].join(", ")}` };
  }
  if (r.type === "users") {
    if (!Array.isArray(r.userIds) || r.userIds.length === 0) {
      return { field: "recipients.userIds", message: "non-empty array required when type=users" };
    }
    if (!r.userIds.every((id: unknown) => typeof id === "string")) {
      return { field: "recipients.userIds", message: "all entries must be strings" };
    }
  }
  return null;
}

function validateChannels(v: unknown): ValidationError | null {
  if (!Array.isArray(v) || v.length === 0) {
    return { field: "channels", message: "must be a non-empty string array" };
  }
  for (const c of v) {
    if (typeof c !== "string" || !VALID_CHANNELS.has(c)) {
      return { field: "channels", message: `unknown channel "${c}"` };
    }
  }
  return null;
}

function validatePriority(v: unknown): ValidationError | null {
  if (typeof v !== "string" || !VALID_PRIORITIES.has(v)) {
    return { field: "priority", message: `must be one of ${[...VALID_PRIORITIES].join(", ")}` };
  }
  return null;
}

function validateConditions(v: unknown): ValidationError | null {
  if (v === null || v === undefined) return null;
  // Accept the CEL-lite string form as a placeholder.
  if (typeof v === "string") return null;
  if (!Array.isArray(v)) return { field: "conditions", message: "must be an array of {field,op,value} or omitted" };
  for (let i = 0; i < v.length; i++) {
    const c = v[i] as any;
    if (!c || typeof c !== "object") return { field: `conditions[${i}]`, message: "must be an object" };
    if (typeof c.field !== "string" || c.field.length === 0) {
      return { field: `conditions[${i}].field`, message: "non-empty string required" };
    }
    if (!VALID_CONDITION_OPS.has(c.op)) {
      return { field: `conditions[${i}].op`, message: `must be one of ${[...VALID_CONDITION_OPS].join(", ")}` };
    }
  }
  return null;
}

// ─── List ─────────────────────────────────────────────────

router.get("/notification-preferences", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const where: any = { tenantId: req.tenantId };
  if (req.query.departmentId !== undefined) {
    where.departmentId = req.query.departmentId === "null" ? null : String(req.query.departmentId);
  }
  if (req.query.eventType !== undefined) where.eventType = String(req.query.eventType);
  const rows = await (prisma as any).notificationPreference.findMany({
    where,
    orderBy: [{ eventType: "asc" }, { departmentId: "asc" }],
  });
  res.json({ data: rows });
});

// ─── Create ───────────────────────────────────────────────

router.post("/notification-preferences", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const b = req.body || {};
  if (typeof b.eventType !== "string" || !b.eventType.trim()) {
    res.status(400).json({ error: "eventType is required" });
    return;
  }
  const recErr = validateRecipients(b.recipients);
  if (recErr) { res.status(400).json({ error: recErr }); return; }
  const channels = b.channels ?? ["email", "in_app"];
  const chErr = validateChannels(channels);
  if (chErr) { res.status(400).json({ error: chErr }); return; }
  const priority = b.priority ?? "MEDIUM";
  const prErr = validatePriority(priority);
  if (prErr) { res.status(400).json({ error: prErr }); return; }
  const condErr = validateConditions(b.conditions);
  if (condErr) { res.status(400).json({ error: condErr }); return; }

  const departmentId = b.departmentId != null ? String(b.departmentId) : null;
  // Validate department belongs to tenant if provided - prevents cross-tenant
  // FK by way of a stale id from another tenant's UI.
  if (departmentId) {
    const exists = await (prisma as any).department.findFirst({
      where: { id: departmentId, tenantId: req.tenantId },
      select: { id: true },
    });
    if (!exists) { res.status(400).json({ error: "departmentId not found in tenant" }); return; }
  }

  const row = await (prisma as any).notificationPreference.create({
    data: {
      tenantId: req.tenantId,
      departmentId,
      eventType: String(b.eventType).trim(),
      enabled: b.enabled !== false,
      conditions: b.conditions ?? null,
      recipients: b.recipients,
      channels,
      priority,
    },
  });
  res.status(201).json({ data: row });
});

// ─── Update ───────────────────────────────────────────────

router.patch("/notification-preferences/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const id = req.params.id;
  const existing = await (prisma as any).notificationPreference.findFirst({
    where: { id, tenantId: req.tenantId },
  });
  if (!existing) { res.status(404).json({ error: "not found" }); return; }

  const b = req.body || {};
  const data: any = {};
  if (b.recipients !== undefined) {
    const e = validateRecipients(b.recipients);
    if (e) { res.status(400).json({ error: e }); return; }
    data.recipients = b.recipients;
  }
  if (b.channels !== undefined) {
    const e = validateChannels(b.channels);
    if (e) { res.status(400).json({ error: e }); return; }
    data.channels = b.channels;
  }
  if (b.priority !== undefined) {
    const e = validatePriority(b.priority);
    if (e) { res.status(400).json({ error: e }); return; }
    data.priority = b.priority;
  }
  if (b.conditions !== undefined) {
    const e = validateConditions(b.conditions);
    if (e) { res.status(400).json({ error: e }); return; }
    data.conditions = b.conditions;
  }
  if (b.enabled !== undefined) data.enabled = !!b.enabled;
  if (b.eventType !== undefined && typeof b.eventType === "string") data.eventType = b.eventType;

  const row = await (prisma as any).notificationPreference.update({ where: { id }, data });
  res.json({ data: row });
});

// ─── Delete ───────────────────────────────────────────────

router.delete("/notification-preferences/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const id = req.params.id;
  const existing = await (prisma as any).notificationPreference.findFirst({
    where: { id, tenantId: req.tenantId },
    select: { id: true },
  });
  if (!existing) { res.status(404).json({ error: "not found" }); return; }
  await (prisma as any).notificationPreference.delete({ where: { id } });
  res.json({ data: { id, deleted: true } });
});

export default router;
