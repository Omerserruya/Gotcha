/**
 * MCP servers a tenant connects ("Your own tools"). Contract:
 * docs/api/mcp-and-api-tools-contract.md.
 *
 * Lifecycle: PENDING_APPROVAL -> (SYSTEM_ADMIN) approve -> DISCOVERING -> READY | FAILED,
 * or -> REJECTED. A change of url or auth sends it back to PENDING_APPROVAL.
 * Tools start at "never"; the workspace raises them (execute only for read /
 * change; irreversible, money and unknown are capped at ask). The policy gate
 * (tool-gate.ts, the mcp. branch) reads the same row, so the level is enforced
 * at dispatch, not only on the surface.
 */
import { prisma, encryptCredentials, decryptCredentials, loadIntegrationAccess, mcpAccessKey } from "@chatcenter/shared";
import { McpSession, McpError, mcpToolEffect, type McpToolDef, type ToolEffect } from "./connectors/mcp-client";

export type McpStatus = "PENDING_APPROVAL" | "REJECTED" | "DISCOVERING" | "READY" | "FAILED";
export type ToolLevel = "execute" | "ask" | "never";

export interface StoredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: ToolEffect;
  level: ToolLevel;
  changedSinceLastDiscovery: "added" | "removed" | null;
}

export type AuthInput =
  | { kind: "none" }
  | { kind: "bearer"; token?: string }
  | { kind: "header"; headerName: string; headerValue?: string };

export class McpInputError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type", "accept", "cookie", "mcp-session-id", "mcp-protocol-version"]);

export function slugify(name: string): string {
  const s = String(name ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return s || "server";
}

/** The ceiling a tool's effect allows. */
export function maxLevel(effect: ToolEffect | string): ToolLevel {
  return effect === "read" || effect === "change" ? "execute" : "ask";
}

function parseUrl(raw: unknown): string {
  let u: URL;
  try { u = new URL(String(raw ?? "")); } catch { throw new McpInputError("invalid_url", "url must be a valid https URL"); }
  if (u.protocol !== "https:") throw new McpInputError("invalid_url", "url must be https");
  if (u.username || u.password) throw new McpInputError("invalid_url", "put credentials in auth, not in the url");
  return u.toString();
}

function parseAuth(raw: any, existing?: { authKind: string; authHeaderName: string | null; secrets: string | null }): { authKind: string; authHeaderName: string | null; secrets: string | null } {
  const kind = String(raw?.kind ?? "none");
  if (kind === "none") return { authKind: "none", authHeaderName: null, secrets: null };
  const old = existing?.secrets ? safeDecrypt(existing.secrets) : {};
  if (kind === "bearer") {
    const token = typeof raw.token === "string" && raw.token.trim() ? raw.token.trim() : existing?.authKind === "bearer" ? old.token : undefined;
    if (!token) throw new McpInputError("invalid_auth", "bearer auth needs a token");
    return { authKind: "bearer", authHeaderName: null, secrets: encryptCredentials({ token }) };
  }
  if (kind === "header") {
    const name = String(raw.headerName ?? "").trim();
    if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) throw new McpInputError("invalid_auth", "headerName is not an allowed header");
    const value = typeof raw.headerValue === "string" && raw.headerValue.trim() ? raw.headerValue.trim()
      : existing?.authKind === "header" && existing.authHeaderName === name ? old.headerValue : undefined;
    if (!value) throw new McpInputError("invalid_auth", "header auth needs headerValue");
    return { authKind: "header", authHeaderName: name, secrets: encryptCredentials({ headerValue: value }) };
  }
  throw new McpInputError("invalid_auth", "auth.kind must be none, bearer or header");
}

function safeDecrypt(s: string): Record<string, any> {
  try { return decryptCredentials(s) as any; } catch { return {}; }
}

export function connectionOf(row: any): { url: string; headers: Record<string, string> } {
  const sec = row.secrets ? safeDecrypt(row.secrets) : {};
  const headers: Record<string, string> = {};
  if (row.authKind === "bearer" && sec.token) headers.authorization = `Bearer ${sec.token}`;
  if (row.authKind === "header" && row.authHeaderName && sec.headerValue) headers[row.authHeaderName] = String(sec.headerValue);
  return { url: row.url, headers };
}

const toolsOf = (row: any): StoredTool[] => (Array.isArray(row?.tools) ? row.tools : []);

/** The read shape: never a secret. */
export function toView(row: any) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    status: row.status as McpStatus,
    rejectReason: row.rejectReason ?? null,
    lastError: row.lastError ?? null,
    auth: { kind: row.authKind, ...(row.authHeaderName ? { headerName: row.authHeaderName } : {}), hasSecret: !!row.secrets },
    tools: toolsOf(row).map((t) => ({
      name: t.name,
      wireName: `mcp.${row.slug}.${t.name}`,
      description: t.description,
      effect: t.effect,
      risk: t.effect,
      level: t.level,
      maxLevel: maxLevel(t.effect),
      changedSinceLastDiscovery: t.changedSinceLastDiscovery ?? null,
    })),
    discoveredAt: row.discoveredAt ?? null,
    approvedAt: row.approvedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const db = () => (prisma as any).mcpServer;

export async function listServers(tenantId: string) {
  const rows = await db().findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
  return rows.map(toView);
}

async function getOwn(tenantId: string, id: string) {
  const row = await db().findFirst({ where: { id, tenantId } });
  if (!row) throw new McpInputError("not_found", "no such server", 404);
  return row;
}

export async function createServer(tenantId: string, body: any, userId: string | null) {
  const name = String(body?.name ?? "").trim().slice(0, 80);
  if (!name) throw new McpInputError("invalid_name", "name is required");
  const url = parseUrl(body?.url);
  const auth = parseAuth(body?.auth);
  let slug = slugify(name);
  for (let i = 2; await db().findUnique({ where: { tenantId_slug: { tenantId, slug } } }); i++) slug = `${slugify(name).slice(0, 36)}_${i}`;
  const row = await db().create({ data: { tenantId, slug, name, url, ...auth, status: "PENDING_APPROVAL", createdBy: userId } });
  return toView(row);
}

export async function updateServer(tenantId: string, id: string, body: any) {
  const row = await getOwn(tenantId, id);
  const data: Record<string, unknown> = {};
  if (body?.name !== undefined) {
    const name = String(body.name ?? "").trim().slice(0, 80);
    if (!name) throw new McpInputError("invalid_name", "name is required");
    data.name = name;
  }
  let reapprove = false;
  if (body?.url !== undefined) {
    const url = parseUrl(body.url);
    if (url !== row.url) { data.url = url; reapprove = true; }
  }
  if (body?.auth !== undefined) {
    const auth = parseAuth(body.auth, row);
    const changed = auth.authKind !== row.authKind || auth.authHeaderName !== row.authHeaderName
      || typeof body.auth?.token === "string" || typeof body.auth?.headerValue === "string";
    Object.assign(data, auth);
    if (changed) reapprove = true;
  }
  if (reapprove) Object.assign(data, { status: "PENDING_APPROVAL", approvedAt: null, approvedBy: null, rejectReason: null, lastError: null });
  const next = await db().update({ where: { id: row.id }, data });
  return toView(next);
}

export async function deleteServer(tenantId: string, id: string) {
  const row = await getOwn(tenantId, id);
  await db().delete({ where: { id: row.id } });
  return { id: row.id, deleted: true };
}

export async function setToolLevel(tenantId: string, id: string, toolName: string, level: unknown) {
  if (level !== "execute" && level !== "ask" && level !== "never") throw new McpInputError("invalid_level", "level must be execute, ask or never");
  const row = await getOwn(tenantId, id);
  const tools = toolsOf(row);
  const t = tools.find((x) => x.name === toolName && x.changedSinceLastDiscovery !== "removed");
  if (!t) throw new McpInputError("unknown_tool", "no such tool on this server", 404);
  const cap = maxLevel(t.effect);
  if (level === "execute" && cap !== "execute") throw new McpInputError("level_above_ceiling", `a ${t.effect} tool can be at most ask`);
  t.level = level;
  const next = await db().update({ where: { id: row.id }, data: { tools: tools as any } });
  return toView(next);
}

/** Merge a fresh discovery into the stored tools: levels kept, new tools at never, vanished ones marked removed. */
export function mergeDiscovered(previous: StoredTool[], found: McpToolDef[], firstDiscovery: boolean): StoredTool[] {
  const byName = new Map(previous.map((t) => [t.name, t]));
  const out: StoredTool[] = [];
  for (const f of found.slice(0, 100)) {
    const old = byName.get(f.name);
    const effect = mcpToolEffect(f);
    const level: ToolLevel = old && old.changedSinceLastDiscovery !== "removed"
      ? (old.level === "execute" && maxLevel(effect) !== "execute" ? "ask" : old.level)
      : "never";
    out.push({
      name: String(f.name).slice(0, 64),
      description: String(f.description ?? f.annotations?.title ?? "").slice(0, 600),
      inputSchema: f.inputSchema && typeof f.inputSchema === "object" ? f.inputSchema : { type: "object", properties: {} },
      effect,
      level,
      changedSinceLastDiscovery: old ? null : firstDiscovery ? null : "added",
    });
  }
  for (const p of previous) if (!found.some((f) => f.name === p.name) && p.changedSinceLastDiscovery !== "removed") out.push({ ...p, level: "never", changedSinceLastDiscovery: "removed" });
  return out;
}

/** Read the server's tools; READY or FAILED with the classified error. */
export async function discover(serverId: string, deps: { session?: (row: any) => McpSession } = {}): Promise<void> {
  const row = await db().findUnique({ where: { id: serverId } });
  if (!row || row.status === "PENDING_APPROVAL" || row.status === "REJECTED") return;
  await db().update({ where: { id: row.id }, data: { status: "DISCOVERING", lastError: null } });
  try {
    const session = deps.session ? deps.session(row) : new McpSession({ ...connectionOf(row), timeoutMs: 15_000 });
    await session.initialize();
    const found = await session.listTools();
    const tools = mergeDiscovered(toolsOf(row), found, !row.discoveredAt);
    await db().update({ where: { id: row.id }, data: { status: "READY", tools: tools as any, discoveredAt: new Date(), lastError: null } });
  } catch (err: any) {
    const code = err instanceof McpError ? err.code : "protocol";
    await db().update({ where: { id: row.id }, data: { status: "FAILED", lastError: code } });
  }
}

export async function rediscover(tenantId: string, id: string) {
  const row = await getOwn(tenantId, id);
  if (!["READY", "FAILED", "DISCOVERING"].includes(row.status)) throw new McpInputError("not_approved", "the server is not approved yet", 409);
  const next = await db().update({ where: { id: row.id }, data: { status: "DISCOVERING" } });
  void discover(row.id).catch(() => undefined);
  return toView(next);
}

// ── SYSTEM_ADMIN ──

export async function listPending() {
  const rows = await db().findMany({ where: { status: "PENDING_APPROVAL" }, orderBy: { createdAt: "asc" }, include: { tenant: { select: { id: true, name: true } } } });
  return rows.map((r: any) => ({ ...toView(r), tenant: r.tenant ? { id: r.tenant.id, name: r.tenant.name } : null }));
}

export async function approve(id: string, approvedBy: string) {
  const row = await db().findUnique({ where: { id } });
  if (!row) throw new McpInputError("not_found", "no such server", 404);
  if (row.status !== "PENDING_APPROVAL") throw new McpInputError("not_pending", "the server is not waiting for approval", 409);
  const next = await db().update({ where: { id }, data: { status: "DISCOVERING", approvedBy, approvedAt: new Date(), rejectReason: null } });
  void discover(id).catch(() => undefined);
  return toView(next);
}

export async function reject(id: string, reason: unknown) {
  const why = String(reason ?? "").trim().slice(0, 500);
  if (!why) throw new McpInputError("reason_required", "a reason is required");
  const row = await db().findUnique({ where: { id } });
  if (!row) throw new McpInputError("not_found", "no such server", 404);
  if (row.status !== "PENDING_APPROVAL") throw new McpInputError("not_pending", "the server is not waiting for approval", 409);
  const next = await db().update({ where: { id }, data: { status: "REJECTED", rejectReason: why } });
  return toView(next);
}

// ── Runtime (reply engine v2) ──

/** The function definitions of every MCP tool this employee may be offered (the gate re-checks at dispatch). */
export async function mcpToolDefinitions(tenantId: string, aiAgentId: string): Promise<any[]> {
  const access = await loadIntegrationAccess(tenantId, aiAgentId);
  const rows = await db()?.findMany?.({ where: { tenantId, status: "READY" } }).catch(() => []) ?? [];
  const out: any[] = [];
  for (const row of rows) {
    if (!access.has(mcpAccessKey(row.id))) continue;
    for (const t of toolsOf(row)) {
      if (t.level === "never" || t.changedSinceLastDiscovery === "removed") continue;
      out.push({
        type: "function",
        function: {
          name: `mcp.${row.slug}.${t.name}`,
          description: `${t.description || t.name} (from ${row.name})`.slice(0, 700),
          parameters: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
        },
      });
    }
  }
  return out;
}

/** Run an MCP tool (after Gate 2). Returns the content for the model. */
export async function runMcpTool(tenantId: string, wireName: string, args: Record<string, unknown>, deps: { session?: (row: any) => McpSession } = {}): Promise<{ ok: boolean; content: string }> {
  const rest = wireName.slice("mcp.".length);
  const dot = rest.indexOf(".");
  const slug = rest.slice(0, dot);
  const name = rest.slice(dot + 1);
  const row = await db().findUnique({ where: { tenantId_slug: { tenantId, slug } } });
  if (!row || row.status !== "READY") return { ok: false, content: JSON.stringify({ ok: false, reason: "server_not_ready" }) };
  try {
    const session = deps.session ? deps.session(row) : new McpSession({ ...connectionOf(row), timeoutMs: 15_000 });
    await session.initialize();
    const r = await session.callTool(name, args);
    return { ok: !r.isError, content: JSON.stringify({ ok: !r.isError, result: r.text }) };
  } catch (err: any) {
    const code = err instanceof McpError ? err.code : "protocol";
    return { ok: false, content: JSON.stringify({ ok: false, reason: code }) };
  }
}
