/**
 * Custom API tool admin — CRUD + test + meta endpoints.
 *
 *   GET    /custom-api-tools
 *   POST   /custom-api-tools
 *   PATCH  /custom-api-tools/:id
 *   DELETE /custom-api-tools/:id
 *   POST   /custom-api-tools/:id/test     — fire the request with a sample payload
 *
 * ADMIN role required. Secrets are encrypted before storage and stripped
 * from every response.
 */

import { Router, type Request, type Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";
import { executeCustomApiTool, packSecrets } from "../services/connectors/custom-api.service";

const router = Router();
// Path-scoped — see funnel-admin.ts for the rationale.
router.use("/custom-api-tools", authenticate, resolveTenant, requireActiveTenant());

const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const VALID_AUTH = new Set(["none", "bearer", "api_key", "basic"]);

function sanitize(row: any) {
  if (!row) return null;
  const { secrets, ...safe } = row;
  return { ...safe, hasSecrets: !!secrets };
}

router.get("/custom-api-tools", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const rows = await (prisma as any).customApiTool.findMany({
    where: { tenantId: req.tenantId },
    orderBy: [{ isActive: "desc" }, { slug: "asc" }],
  });
  res.json({ data: rows.map(sanitize) });
});

router.post("/custom-api-tools", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const b = req.body || {};
  for (const k of ["slug", "name", "description", "whenToUse", "method", "urlTemplate", "allowedHosts"]) {
    if (b[k] === undefined || b[k] === null || b[k] === "") {
      res.status(400).json({ error: `${k} is required` });
      return;
    }
  }
  if (!VALID_METHODS.has(String(b.method).toUpperCase())) {
    res.status(400).json({ error: "method must be GET|POST|PUT|PATCH|DELETE" });
    return;
  }
  if (b.auth && !VALID_AUTH.has(b.auth.kind)) {
    res.status(400).json({ error: "auth.kind must be none|bearer|api_key|basic" });
    return;
  }
  if (!Array.isArray(b.allowedHosts) || b.allowedHosts.length === 0) {
    res.status(400).json({ error: "allowedHosts must be a non-empty array of hostnames" });
    return;
  }
  try {
    const row = await (prisma as any).customApiTool.create({
      data: {
        tenantId: req.tenantId,
        slug: String(b.slug),
        name: String(b.name),
        description: String(b.description),
        whenToUse: String(b.whenToUse),
        whenNotToUse: b.whenNotToUse || null,
        method: String(b.method).toUpperCase(),
        urlTemplate: String(b.urlTemplate),
        headers: b.headers ?? {},
        auth: b.auth ?? { kind: "none" },
        secrets: packSecrets(b.secrets),
        parameters: b.parameters ?? { type: "object", properties: {}, required: [] },
        bodyTemplate: b.bodyTemplate || null,
        responseFields: b.responseFields ?? null,
        allowedHosts: b.allowedHosts,
        category: b.category || "READ",
        riskLevel: b.riskLevel || "MEDIUM",
        isActive: b.isActive !== false,
        timeoutMs: Number(b.timeoutMs ?? 10000),
      },
    });
    res.status(201).json({ data: sanitize(row) });
  } catch (err: any) {
    if (/Unique/i.test(err?.message || "")) {
      res.status(409).json({ error: "slug already exists for this tenant" });
      return;
    }
    res.status(500).json({ error: err?.message || "create failed" });
  }
});

router.patch("/custom-api-tools/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const b = req.body || {};
  const data: any = {};
  for (const k of [
    "name", "description", "whenToUse", "whenNotToUse", "method", "urlTemplate",
    "headers", "auth", "parameters", "bodyTemplate", "responseFields",
    "allowedHosts", "category", "riskLevel", "isActive", "timeoutMs",
  ]) {
    if (b[k] !== undefined) data[k] = b[k];
  }
  if (b.method !== undefined) {
    if (!VALID_METHODS.has(String(b.method).toUpperCase())) {
      res.status(400).json({ error: "method invalid" });
      return;
    }
    data.method = String(b.method).toUpperCase();
  }
  if (b.secrets !== undefined) {
    data.secrets = packSecrets(b.secrets);
  }
  try {
    const row = await (prisma as any).customApiTool.update({
      where: { id: req.params.id, tenantId: req.tenantId } as any,
      data,
    });
    res.json({ data: sanitize(row) });
  } catch (err: any) {
    res.status(404).json({ error: err?.message || "not found" });
  }
});

router.delete("/custom-api-tools/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  await (prisma as any).customApiTool.deleteMany({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  res.json({ ok: true });
});

router.post("/custom-api-tools/:id/test", requireRole("ADMIN"), async (req: Request, res: Response) => {
  const tool = await (prisma as any).customApiTool.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  if (!tool) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const args = (req.body && req.body.args) || {};
  const result = await executeCustomApiTool({
    tenantId: req.tenantId!,
    slug: tool.slug,
    args,
  });
  res.json(result);
});

export default router;
