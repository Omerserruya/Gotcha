/**
 * MCP servers ("Your own tools"). Contract: docs/api/mcp-and-api-tools-contract.md.
 *   tenant ADMIN:  /api/mcp-servers ...
 *   SYSTEM_ADMIN:  /api/system/mcp-servers/pending | /:id/approve | /:id/reject
 * Every response is {data}; secrets are never returned (auth.hasSecret only).
 */
import { Router, type Request, type Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole, requireSystemAdmin, withCrossTenantAccess } from "@chatcenter/shared";
import {
  listServers, createServer, updateServer, deleteServer, setToolLevel, rediscover,
  listPending, approve, reject, McpInputError,
} from "../services/mcp-servers.service";

const router = Router();

function fail(res: Response, err: any) {
  if (err instanceof McpInputError) return res.status(err.status).json({ error: err.code, message: err.message });
  console.error("[mcp-servers] error:", err?.message ?? err);
  return res.status(500).json({ error: "internal_error" });
}

function audit(tenantId: string, userId: string | null, action: string, serverId: string, metadata: Record<string, unknown> = {}) {
  prisma.auditLog.create({
    data: { tenantId, actorType: "user", actorId: userId ?? undefined, action, targetType: "mcp_server", targetId: serverId, metadata: metadata as any },
  } as any).catch(() => undefined);
}

const tenantOf = (req: Request) => (req as any).tenantId as string;
const userOf = (req: Request) => ((req as any).user?.userId ?? null) as string | null;

// ── tenant ADMIN ──
router.use("/mcp-servers", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"));

router.get("/mcp-servers", async (req, res) => {
  try { res.json({ data: await listServers(tenantOf(req)) }); } catch (e) { fail(res, e); }
});

router.post("/mcp-servers", async (req, res) => {
  try {
    const v = await createServer(tenantOf(req), req.body, userOf(req));
    audit(tenantOf(req), userOf(req), "mcp_server.created", v.id, { name: v.name, authKind: v.auth.kind });
    res.status(201).json({ data: v });
  } catch (e) { fail(res, e); }
});

router.patch("/mcp-servers/:id", async (req, res) => {
  try {
    const v = await updateServer(tenantOf(req), String(req.params.id), req.body);
    audit(tenantOf(req), userOf(req), "mcp_server.updated", v.id, { status: v.status, fields: Object.keys(req.body ?? {}).filter((k) => k !== "auth").concat(req.body?.auth ? ["auth"] : []) });
    res.json({ data: v });
  } catch (e) { fail(res, e); }
});

router.delete("/mcp-servers/:id", async (req, res) => {
  try {
    const v = await deleteServer(tenantOf(req), String(req.params.id));
    audit(tenantOf(req), userOf(req), "mcp_server.deleted", v.id);
    res.json({ data: v });
  } catch (e) { fail(res, e); }
});

router.post("/mcp-servers/:id/rediscover", async (req, res) => {
  try { res.json({ data: await rediscover(tenantOf(req), String(req.params.id)) }); } catch (e) { fail(res, e); }
});

router.put("/mcp-servers/:id/tools/:toolName", async (req, res) => {
  try {
    const v = await setToolLevel(tenantOf(req), String(req.params.id), String(req.params.toolName), req.body?.level);
    audit(tenantOf(req), userOf(req), "mcp_server.tool_level", v.id, { tool: String(req.params.toolName), level: req.body?.level });
    res.json({ data: v });
  } catch (e) { fail(res, e); }
});

// ── SYSTEM_ADMIN (cross-tenant) ──
router.use("/system/mcp-servers", authenticate, requireSystemAdmin());

router.get("/system/mcp-servers/pending", async (_req, res) => {
  try { res.json({ data: await withCrossTenantAccess(() => listPending()) }); } catch (e) { fail(res, e); }
});

router.post("/system/mcp-servers/:id/approve", async (req, res) => {
  try {
    const v = await withCrossTenantAccess(() => approve(String(req.params.id), userOf(req) ?? "system_admin"));
    const row: any = await withCrossTenantAccess(() => (prisma as any).mcpServer.findUnique({ where: { id: v.id }, select: { tenantId: true } }));
    if (row) audit(row.tenantId, userOf(req), "mcp_server.approved", v.id);
    res.json({ data: v });
  } catch (e) { fail(res, e); }
});

router.post("/system/mcp-servers/:id/reject", async (req, res) => {
  try {
    const v = await withCrossTenantAccess(() => reject(String(req.params.id), req.body?.reason));
    const row: any = await withCrossTenantAccess(() => (prisma as any).mcpServer.findUnique({ where: { id: v.id }, select: { tenantId: true } }));
    if (row) audit(row.tenantId, userOf(req), "mcp_server.rejected", v.id, { reason: v.rejectReason });
    res.json({ data: v });
  } catch (e) { fail(res, e); }
});

export default router;
