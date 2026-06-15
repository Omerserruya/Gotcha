/**
 * Field Definitions - CRUD API for the scope-aware intelligence field
 * registry (Customer Intelligence V2, Phase 1). Backs the Fields Builder UI.
 *
 * Routes (mounted at /api/field-definitions):
 *   GET    /            - list fields (optional ?scope=customer|opportunity|conversation)
 *   POST   /            - create a custom field
 *   PUT    /:id         - update a field
 *   DELETE /:id         - delete a field
 *
 * Auth: tenant ADMIN only.
 */

import { Router, type Request, type Response } from "express";
import {
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requireRole,
} from "@chatcenter/shared";
import {
  listFields,
  createField,
  updateField,
  deleteField,
  keyExists,
  validateFieldInput,
  FIELD_SCOPES,
  type FieldScope,
} from "../services/intelligence-registry.service";

const router = Router();

const guards = [authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN")];

router.get("/", ...guards, async (req: Request, res: Response) => {
  const tenantId = req.tenantId;
  if (!tenantId) {
    res.status(400).json({ error: "tenant required" });
    return;
  }
  const scopeRaw = typeof req.query.scope === "string" ? req.query.scope : undefined;
  const scope = scopeRaw && FIELD_SCOPES.includes(scopeRaw as FieldScope) ? (scopeRaw as FieldScope) : undefined;
  const fields = await listFields(tenantId, scope);
  res.json({ ok: true, fields });
});

router.post("/", ...guards, async (req: Request, res: Response) => {
  const tenantId = req.tenantId;
  if (!tenantId) {
    res.status(400).json({ error: "tenant required" });
    return;
  }
  const validated = validateFieldInput(req.body ?? {}, { partial: false });
  if (!validated.ok) {
    res.status(400).json({ error: validated.error });
    return;
  }
  if (await keyExists(tenantId, validated.value.key)) {
    res.status(409).json({ error: `a field with key "${validated.value.key}" already exists` });
    return;
  }
  // Always created as a tenant CUSTOM field (packs use the apply route).
  const field = await createField(tenantId, { ...validated.value, origin: "custom" });
  res.status(201).json({ ok: true, field });
});

router.put("/:id", ...guards, async (req: Request, res: Response) => {
  const tenantId = req.tenantId;
  if (!tenantId) {
    res.status(400).json({ error: "tenant required" });
    return;
  }
  const id = String(req.params.id);
  const validated = validateFieldInput(req.body ?? {}, { partial: true });
  if (!validated.ok) {
    res.status(400).json({ error: validated.error });
    return;
  }
  if (validated.value.key && (await keyExists(tenantId, validated.value.key, id))) {
    res.status(409).json({ error: `a field with key "${validated.value.key}" already exists` });
    return;
  }
  const field = await updateField(tenantId, id, validated.value);
  if (!field) {
    res.status(404).json({ error: "field not found" });
    return;
  }
  res.json({ ok: true, field });
});

router.delete("/:id", ...guards, async (req: Request, res: Response) => {
  const tenantId = req.tenantId;
  if (!tenantId) {
    res.status(400).json({ error: "tenant required" });
    return;
  }
  const ok = await deleteField(tenantId, String(req.params.id));
  if (!ok) {
    res.status(404).json({ error: "field not found" });
    return;
  }
  res.json({ ok: true });
});

export default router;
