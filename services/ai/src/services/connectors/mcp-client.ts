/**
 * A minimal MCP client over Streamable HTTP (JSON-RPC 2.0), no SDK (no new
 * dependencies): initialize -> notifications/initialized -> tools/list | tools/call.
 * A server may answer with JSON or with an SSE stream; both are read.
 *
 * Every request goes to a PUBLIC address only (assertPublicUrl: no private,
 * loopback or metadata hosts) and never follows a redirect, so a tenant's URL
 * cannot be turned into a probe of our network.
 */
import { assertPublicUrl } from "@chatcenter/shared";

export type McpErrorCode = "unreachable" | "tls" | "auth_rejected" | "not_mcp" | "timeout" | "protocol";

export class McpError extends Error {
  constructor(public code: McpErrorCode, message: string) { super(message); }
}

export interface McpConnection {
  url: string;
  /** Extra request headers (the auth): { Authorization: "Bearer ..." } or { [headerName]: value }. */
  headers: Record<string, string>;
  timeoutMs?: number;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string };
}

const PROTOCOL_VERSION = "2025-06-18";
const MAX_BYTES = 2_000_000;

function classify(err: any): McpError {
  if (err instanceof McpError) return err;
  const msg = String(err?.message ?? err);
  const code = String(err?.cause?.code ?? err?.code ?? "");
  if (err?.name === "AbortError" || /timeout/i.test(msg)) return new McpError("timeout", "the server did not answer in time");
  if (/CERT|SSL|TLS|self.signed/i.test(code + msg)) return new McpError("tls", "the server's TLS certificate was not accepted");
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|fetch failed|private|not allowed|blocked/i.test(code + msg)) {
    return new McpError("unreachable", "the server could not be reached");
  }
  return new McpError("protocol", msg.slice(0, 200));
}

/** The JSON-RPC response with this id, from a JSON body or an SSE stream. */
export function readRpcBody(text: string, contentType: string | null, id: number): any {
  if (/text\/event-stream/i.test(contentType ?? "")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg && msg.id === id) return msg;
      } catch { /* not JSON: skip */ }
    }
    throw new McpError("not_mcp", "no JSON-RPC response in the event stream");
  }
  let msg: any;
  try { msg = JSON.parse(text); } catch { throw new McpError("not_mcp", "the server did not answer JSON-RPC"); }
  if (Array.isArray(msg)) msg = msg.find((m) => m?.id === id);
  if (!msg || msg.jsonrpc !== "2.0") throw new McpError("not_mcp", "the server did not answer JSON-RPC");
  return msg;
}

export class McpSession {
  private sessionId: string | null = null;
  private nextId = 1;
  constructor(private conn: McpConnection, private fetchImpl: typeof fetch = fetch) {}

  private async post(body: Record<string, unknown>, expectReply: boolean): Promise<any> {
    const url = await assertPublicUrl(this.conn.url).catch((e: any) => { throw new McpError("unreachable", String(e?.message ?? "address not allowed")); });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.conn.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: "POST",
        redirect: "error",
        signal: ctrl.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": PROTOCOL_VERSION,
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
          ...this.conn.headers,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw classify(err);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw new McpError("auth_rejected", `the server refused the credentials (${res.status})`);
    if (res.status === 404 || res.status === 405 || res.status === 406) throw new McpError("not_mcp", `not an MCP endpoint (${res.status})`);
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!expectReply) return null;
    if (!res.ok) throw new McpError("protocol", `HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new McpError("protocol", "response too large");
    const msg = readRpcBody(buf.toString("utf8"), res.headers.get("content-type"), body.id as number);
    if (msg.error) throw new McpError("protocol", String(msg.error?.message ?? "error").slice(0, 200));
    return msg.result;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.post({ jsonrpc: "2.0", id: this.nextId++, method, params }, true);
  }

  async initialize(): Promise<void> {
    const r = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "gotcha", version: "1.0" },
    });
    if (!r || typeof r !== "object" || !("capabilities" in r)) throw new McpError("not_mcp", "initialize returned no capabilities");
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, false).catch(() => undefined);
  }

  async listTools(): Promise<McpToolDef[]> {
    const out: McpToolDef[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await this.request("tools/list", cursor ? { cursor } : {});
      for (const t of Array.isArray(r?.tools) ? r.tools : []) if (t && typeof t.name === "string") out.push(t);
      cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const r = await this.request("tools/call", { name, arguments: args });
    const parts = Array.isArray(r?.content) ? r.content : [];
    const text = parts.map((p: any) => (p?.type === "text" ? String(p.text ?? "") : p?.type ? `[${p.type}]` : "")).filter(Boolean).join("\n");
    const structured = r?.structuredContent ? JSON.stringify(r.structuredContent) : "";
    return { isError: !!r?.isError, text: (text || structured).slice(0, 20_000) };
  }
}

export type ToolEffect = "read" | "change" | "irreversible" | "money";

const MONEY = /(?:^|[_.\-\s])(refund|charge|pay|payment|payout|invoice|transfer|withdraw|price|discount|coupon)(?:[_.\-\s]|$)/i;

/** The effect of a discovered tool: the server's own hints first, then its name. Unknown stays "change". */
export function mcpToolEffect(t: McpToolDef): ToolEffect {
  if (MONEY.test(t.name)) return "money";
  if (t.annotations?.destructiveHint === true) return "irreversible";
  if (t.annotations?.readOnlyHint === true) return "read";
  if (/(?:^|[_.\-])(delete|remove|destroy|drop|purge|cancel)(?:[_.\-]|$)/i.test(t.name)) return "irreversible";
  if (/^(get|list|search|find|read|fetch|lookup|query|describe)(?:[_.\-]|$)/i.test(t.name)) return "read";
  return "change";
}
