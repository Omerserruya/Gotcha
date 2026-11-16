/**
 * MCP servers ("Your own tools"): the client (JSON and SSE, errors), the
 * lifecycle (approval, re-approval on a url/auth change, discovery merge, the
 * level ceiling, no secret in a read), and the policy gate's mcp. branch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.CHANNEL_ENCRYPTION_KEY = "a".repeat(64);

const rows = vi.hoisted(() => ({ servers: [] as any[], agents: {} as Record<string, string[]> }));

vi.mock("../../../../packages/shared/src/lib/prisma", () => {
  const match = (r: any, where: any) => Object.entries(where ?? {}).every(([k, v]: any) => {
    if (k === "tenantId_slug") return r.tenantId === v.tenantId && r.slug === v.slug;
    if (v && typeof v === "object" && "in" in v) return v.in.includes(r[k]);
    return r[k] === v;
  });
  const mcpServer = {
    findMany: vi.fn(async ({ where }: any = {}) => rows.servers.filter((r) => match(r, where))),
    findFirst: vi.fn(async ({ where }: any) => rows.servers.find((r) => match(r, where)) ?? null),
    findUnique: vi.fn(async ({ where }: any) => rows.servers.find((r) => match(r, where)) ?? null),
    create: vi.fn(async ({ data }: any) => { const r = { id: `s${rows.servers.length + 1}`, tools: [], createdAt: new Date(), updatedAt: new Date(), discoveredAt: null, ...data }; rows.servers.push(r); return r; }),
    update: vi.fn(async ({ where, data }: any) => { const r = rows.servers.find((x) => x.id === where.id); Object.assign(r, data); return r; }),
    delete: vi.fn(async ({ where }: any) => { rows.servers = rows.servers.filter((x) => x.id !== where.id); return {}; }),
  };
  return {
    prisma: {
      mcpServer,
      aIAgent: { findFirst: vi.fn(async ({ where }: any) => ({ integrationAccess: rows.agents[where.id] ?? [] })) },
      tenantToolPermission: { findUnique: vi.fn(async () => null) },
      tenantSetting: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
    },
  };
});
vi.mock("../../../../packages/shared/src/lib/durable-settings", () => ({ readDurableSetting: async () => null, writeDurableSetting: async () => undefined, settingCacheKey: (t: string, k: string) => `${t}:${k}` }));

import { evaluatePolicies } from "@chatcenter/shared";
import { McpSession, McpError, readRpcBody, mcpToolEffect } from "../services/connectors/mcp-client";
import {
  createServer, updateServer, setToolLevel, toView, mergeDiscovered, discover, approve, reject, listServers, mcpToolDefinitions, maxLevel, McpInputError,
} from "../services/mcp-servers.service";

beforeEach(() => { rows.servers = []; rows.agents = {}; });

// A fake MCP server behind fetch.
function fakeFetch(opts: { status?: number; sse?: boolean; tools?: any[][]; callText?: string } = {}) {
  const seen: any[] = [];
  const f = vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    seen.push({ body, headers: init.headers, redirect: init.redirect });
    if (opts.status) return new Response("no", { status: opts.status });
    if (!("id" in body)) return new Response(null, { status: 202 });
    let result: any = {};
    if (body.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "x" } };
    if (body.method === "tools/list") {
      const pages = opts.tools ?? [[{ name: "get_order", description: "read an order", annotations: { readOnlyHint: true } }]];
      const page = body.params?.cursor ? Number(body.params.cursor) : 0;
      result = { tools: pages[page], ...(page + 1 < pages.length ? { nextCursor: String(page + 1) } : {}) };
    }
    if (body.method === "tools/call") result = { content: [{ type: "text", text: opts.callText ?? "order 12 shipped" }] };
    const msg = { jsonrpc: "2.0", id: body.id, result };
    return opts.sse
      ? new Response(`event: message\ndata: ${JSON.stringify(msg)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-1" } })
      : new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "sess-1" } });
  });
  return { f: f as any, seen };
}
const PUBLIC = "https://93.184.216.34/mcp";

describe("the MCP client", () => {
  it("initialize, list (paged) and call, over JSON; the session id rides along; redirects refused", async () => {
    const { f, seen } = fakeFetch({ tools: [[{ name: "a" }], [{ name: "b" }]] });
    const s = new McpSession({ url: PUBLIC, headers: { authorization: "Bearer t" } }, f);
    await s.initialize();
    expect((await s.listTools()).map((t) => t.name)).toEqual(["a", "b"]);
    expect(await s.callTool("a", {})).toEqual({ isError: false, text: "order 12 shipped" });
    expect(seen.at(-1).headers["mcp-session-id"]).toBe("sess-1");
    expect(seen.every((x) => x.redirect === "error")).toBe(true);
    expect(seen[0].headers.authorization).toBe("Bearer t");
  });
  it("reads an SSE answer", async () => {
    const { f } = fakeFetch({ sse: true });
    const s = new McpSession({ url: PUBLIC, headers: {} }, f);
    await s.initialize();
    expect((await s.listTools())[0].name).toBe("get_order");
    expect(readRpcBody('data: {"jsonrpc":"2.0","id":7,"result":{"x":1}}\n\n', "text/event-stream", 7).result).toEqual({ x: 1 });
  });
  it("classifies refusals: 401 -> auth_rejected, 404 -> not_mcp, junk -> not_mcp, a private host -> unreachable", async () => {
    await expect(new McpSession({ url: PUBLIC, headers: {} }, fakeFetch({ status: 401 }).f).initialize()).rejects.toMatchObject({ code: "auth_rejected" });
    await expect(new McpSession({ url: PUBLIC, headers: {} }, fakeFetch({ status: 404 }).f).initialize()).rejects.toMatchObject({ code: "not_mcp" });
    expect(() => readRpcBody("<html>", "text/html", 1)).toThrow(McpError);
    const never = vi.fn();
    await expect(new McpSession({ url: "https://127.0.0.1/mcp", headers: {} }, never as any).initialize()).rejects.toMatchObject({ code: "unreachable" });
    await expect(new McpSession({ url: "https://169.254.169.254/latest", headers: {} }, never as any).initialize()).rejects.toMatchObject({ code: "unreachable" });
    expect(never).not.toHaveBeenCalled();
  });
  it("effect: money and destructive first, then the read hint, unknown is change", () => {
    expect(mcpToolEffect({ name: "issue_refund", annotations: { readOnlyHint: true } })).toBe("money");
    expect(mcpToolEffect({ name: "x", annotations: { destructiveHint: true } })).toBe("irreversible");
    expect(mcpToolEffect({ name: "delete_note" })).toBe("irreversible");
    expect(mcpToolEffect({ name: "get_order" })).toBe("read");
    expect(mcpToolEffect({ name: "tag_customer" })).toBe("change");
    expect(maxLevel("read")).toBe("execute");
    expect(maxLevel("money")).toBe("ask");
  });
});

describe("the lifecycle", () => {
  it("a new server waits for approval; https only; a read never carries a secret", async () => {
    await expect(createServer("t1", { name: "X", url: "http://x.com", auth: { kind: "none" } }, "u1")).rejects.toBeInstanceOf(McpInputError);
    const v = await createServer("t1", { name: "Orders API", url: PUBLIC, auth: { kind: "bearer", token: "secret-token" } }, "u1");
    expect(v.status).toBe("PENDING_APPROVAL");
    expect(v.slug).toBe("orders_api");
    expect(v.auth).toEqual({ kind: "bearer", hasSecret: true });
    expect(JSON.stringify(await listServers("t1"))).not.toContain("secret-token");
    expect(rows.servers[0].secrets).not.toContain("secret-token");
  });
  it("forbidden auth header names are refused", async () => {
    await expect(createServer("t1", { name: "X", url: PUBLIC, auth: { kind: "header", headerName: "Host", headerValue: "v" } }, null)).rejects.toMatchObject({ code: "invalid_auth" });
  });
  it("a url or a new secret sends it back to approval; a name alone does not", async () => {
    const v = await createServer("t1", { name: "A", url: PUBLIC, auth: { kind: "bearer", token: "t" } }, null);
    rows.servers[0].status = "READY";
    expect((await updateServer("t1", v.id, { name: "B" })).status).toBe("READY");
    expect((await updateServer("t1", v.id, { name: "B", auth: { kind: "bearer" } })).status).toBe("READY");
    expect((await updateServer("t1", v.id, { auth: { kind: "bearer", token: "new" } })).status).toBe("PENDING_APPROVAL");
    rows.servers[0].status = "READY";
    expect((await updateServer("t1", v.id, { url: "https://93.184.216.34/other" })).status).toBe("PENDING_APPROVAL");
  });
  it("another tenant cannot touch it", async () => {
    const v = await createServer("t1", { name: "A", url: PUBLIC, auth: { kind: "none" } }, null);
    await expect(updateServer("t2", v.id, { name: "x" })).rejects.toMatchObject({ status: 404 });
  });
  it("approve -> discovery -> READY with every tool at never; reject needs a reason", async () => {
    const v = await createServer("t1", { name: "A", url: PUBLIC, auth: { kind: "none" } }, null);
    await expect(reject(v.id, "")).rejects.toMatchObject({ code: "reason_required" });
    const { f } = fakeFetch();
    await approve(v.id, "admin");
    await discover(v.id, { session: (row) => new McpSession({ url: row.url, headers: {} }, f) });
    const after = toView(rows.servers[0]);
    expect(after.status).toBe("READY");
    expect(after.tools).toEqual([expect.objectContaining({ name: "get_order", effect: "read", level: "never", changedSinceLastDiscovery: null })]);
  });
  it("a failed discovery is FAILED with the classified error", async () => {
    const v = await createServer("t1", { name: "A", url: PUBLIC, auth: { kind: "none" } }, null);
    await approve(v.id, "admin");
    await discover(v.id, { session: (row) => new McpSession({ url: row.url, headers: {} }, fakeFetch({ status: 401 }).f) });
    expect(rows.servers[0]).toMatchObject({ status: "FAILED", lastError: "auth_rejected" });
  });
  it("re-discovery keeps levels, marks added and removed, caps a tool whose effect rose", () => {
    const prev: any[] = [
      { name: "get_order", effect: "read", level: "execute", changedSinceLastDiscovery: null },
      { name: "tag", effect: "change", level: "execute", changedSinceLastDiscovery: null },
      { name: "old", effect: "read", level: "ask", changedSinceLastDiscovery: null },
    ];
    const next = mergeDiscovered(prev, [{ name: "get_order" }, { name: "tag", annotations: { destructiveHint: true } }, { name: "new_one" }], false);
    expect(next.find((t) => t.name === "get_order")).toMatchObject({ level: "execute", changedSinceLastDiscovery: null });
    expect(next.find((t) => t.name === "tag")).toMatchObject({ effect: "irreversible", level: "ask" });
    expect(next.find((t) => t.name === "new_one")).toMatchObject({ level: "never", changedSinceLastDiscovery: "added" });
    expect(next.find((t) => t.name === "old")).toMatchObject({ level: "never", changedSinceLastDiscovery: "removed" });
  });
  it("the level ceiling: execute only for read and change", async () => {
    const v = await createServer("t1", { name: "A", url: PUBLIC, auth: { kind: "none" } }, null);
    rows.servers[0].tools = [{ name: "refund", effect: "money", level: "never" }, { name: "get", effect: "read", level: "never" }];
    await expect(setToolLevel("t1", v.id, "refund", "execute")).rejects.toMatchObject({ code: "level_above_ceiling" });
    expect((await setToolLevel("t1", v.id, "refund", "ask")).tools[0].level).toBe("ask");
    expect((await setToolLevel("t1", v.id, "get", "execute")).tools[1].level).toBe("execute");
  });
});

describe("the gate and the surface", () => {
  const ready = (tools: any[]) => { rows.servers.push({ id: "s1", tenantId: "t1", slug: "crm", name: "CRM", status: "READY", tools }); };
  it("never offered and denied until the server is READY, the tool raised, and the employee allowed", async () => {
    ready([{ name: "get_order", effect: "read", level: "never" }]);
    rows.agents.ag1 = ["mcp:s1"];
    expect((await evaluatePolicies({ tenantId: "t1", toolName: "mcp.crm.get_order", aiAgentId: "ag1" })).decision).toBe("DENY");
    expect(await mcpToolDefinitions("t1", "ag1")).toEqual([]);
    rows.servers[0].tools[0].level = "execute";
    expect((await evaluatePolicies({ tenantId: "t1", toolName: "mcp.crm.get_order", aiAgentId: "ag1" })).decision).toBe("ALLOW");
    expect((await mcpToolDefinitions("t1", "ag1")).map((t) => t.function.name)).toEqual(["mcp.crm.get_order"]);
    rows.agents.ag1 = [];
    expect((await evaluatePolicies({ tenantId: "t1", toolName: "mcp.crm.get_order", aiAgentId: "ag1" })).decision).toBe("DENY");
    expect(await mcpToolDefinitions("t1", "ag1")).toEqual([]);
  });
  it("ask -> a person approves; a money tool never auto-runs even if stored as execute", async () => {
    ready([{ name: "tag", effect: "change", level: "ask" }, { name: "refund", effect: "money", level: "execute" }]);
    rows.agents.ag1 = ["mcp:s1"];
    expect((await evaluatePolicies({ tenantId: "t1", toolName: "mcp.crm.tag", aiAgentId: "ag1" })).decision).toBe("REQUIRE_APPROVAL");
    expect((await evaluatePolicies({ tenantId: "t1", toolName: "mcp.crm.refund", aiAgentId: "ag1" })).decision).toBe("REQUIRE_APPROVAL");
  });
  it("a pending, failed or other tenant's server is denied; a removed tool is denied", async () => {
    ready([{ name: "get_order", effect: "read", level: "execute", changedSinceLastDiscovery: "removed" }]);
    rows.agents.ag1 = ["mcp:s1"];
    expect((await evaluatePolicies({ tenantId: "t1", toolName: "mcp.crm.get_order", aiAgentId: "ag1" })).decision).toBe("DENY");
    rows.servers[0].tools[0].changedSinceLastDiscovery = null;
    rows.servers[0].status = "FAILED";
    expect((await evaluatePolicies({ tenantId: "t1", toolName: "mcp.crm.get_order", aiAgentId: "ag1" })).decision).toBe("DENY");
    rows.servers[0].status = "READY";
    expect((await evaluatePolicies({ tenantId: "t2", toolName: "mcp.crm.get_order", aiAgentId: "ag1" })).decision).toBe("DENY");
  });
});
