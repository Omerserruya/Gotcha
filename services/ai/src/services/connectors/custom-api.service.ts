/**
 * Custom API tool runtime.
 *
 *   - listCustomApiTools(tenantId)  — for the bot's tool surface
 *   - executeCustomApiTool({...})   — called by the dispatcher when the
 *     LLM picks a tool whose name is `custom.<slug>`
 *
 * Security guardrails:
 *   - Domain whitelist on the resolved URL.
 *   - Internal-network blocks (loopback, link-local, private CIDRs) by
 *     default to prevent SSRF.
 *   - Timeout enforced via AbortSignal (default 10s, configurable per tool).
 *   - Secrets decrypted only at execution time and dropped from logs.
 *
 * Idempotency: the framework's idempotencyKey() can be added as an
 * `Idempotency-Key` header for write requests by the tenant. The runtime
 * surfaces the computed key on the request so the model sees what was sent.
 */

import { prisma, encryptCredentials, decryptCredentials } from "@chatcenter/shared";
import { idempotencyKey } from "./integration-framework";

const PRIVATE_HOSTS = [/^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^::1$/, /^fc[0-9a-f]{2}:/i];

export interface CustomApiToolDefinition {
  id: string;
  slug: string;
  name: string;
  description: string;
  whenToUse: string;
  whenNotToUse: string | null;
  method: string;
  urlTemplate: string;
  parameters: Record<string, unknown>;
  category: string;
  riskLevel: string;
}

export async function listCustomApiTools(tenantId: string): Promise<CustomApiToolDefinition[]> {
  try {
    const rows: any[] = await (prisma as any).customApiTool.findMany({
      where: { tenantId, isActive: true },
      orderBy: { slug: "asc" },
    });
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      whenToUse: r.whenToUse,
      whenNotToUse: r.whenNotToUse,
      method: r.method,
      urlTemplate: r.urlTemplate,
      parameters: r.parameters || { type: "object", properties: {}, required: [] },
      category: r.category,
      riskLevel: r.riskLevel,
    }));
  } catch (err: any) {
    if (!/Unknown arg|Cannot read|undefined.*findMany/.test(err?.message || "")) {
      console.warn("[custom-api] list failed:", err?.message);
    }
    return [];
  }
}

export async function executeCustomApiTool(opts: {
  tenantId: string;
  slug: string;
  args: Record<string, unknown>;
  conversationId?: string;
}): Promise<{ ok: true; result: unknown; meta: { status: number; durationMs: number } } | { ok: false; reason: string; meta?: { status?: number } }> {
  const tool = await (prisma as any).customApiTool.findUnique({
    where: { tenantId_slug: { tenantId: opts.tenantId, slug: opts.slug } },
  });
  if (!tool || !tool.isActive) {
    return { ok: false, reason: `unknown_custom_api_tool:${opts.slug}` };
  }

  // 1) Render URL + body from args, validate host.
  let url: URL;
  try {
    url = new URL(renderTemplate(tool.urlTemplate, opts.args));
  } catch (err: any) {
    return { ok: false, reason: `invalid_url:${err?.message || ""}` };
  }

  const allowedHosts: string[] = Array.isArray(tool.allowedHosts) ? tool.allowedHosts : [];
  if (allowedHosts.length === 0) {
    return { ok: false, reason: "domain_whitelist_empty — set allowedHosts before enabling this tool" };
  }
  if (!allowedHosts.some((h) => h.toLowerCase() === url.hostname.toLowerCase())) {
    return { ok: false, reason: `domain_not_allowed:${url.hostname}` };
  }
  if (PRIVATE_HOSTS.some((re) => re.test(url.hostname))) {
    return { ok: false, reason: `private_host_blocked:${url.hostname}` };
  }

  // 2) Build headers + auth.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(typeof tool.headers === "object" && tool.headers ? renderTemplateMap(tool.headers, opts.args) : {}),
  };

  let secrets: Record<string, any> = {};
  if (tool.secrets) {
    try { secrets = decryptCredentials(tool.secrets); } catch { secrets = {}; }
  }
  const auth = tool.auth || { kind: "none" };
  switch (auth.kind) {
    case "bearer":
      if (secrets.bearer) headers.Authorization = `Bearer ${secrets.bearer}`;
      break;
    case "api_key":
      if (secrets.apiKey) {
        if (auth.in === "header") headers[auth.name || "X-API-Key"] = secrets.apiKey;
        else url.searchParams.set(auth.name || "api_key", secrets.apiKey);
      }
      break;
    case "basic":
      if (secrets.basicUser && secrets.basicPass) {
        headers.Authorization = `Basic ${Buffer.from(`${secrets.basicUser}:${secrets.basicPass}`).toString("base64")}`;
      }
      break;
    case "none":
    default:
      break;
  }

  // 3) Body + idempotency key for writes.
  let body: string | undefined;
  const method = String(tool.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "DELETE") {
    if (tool.bodyTemplate) {
      const rendered = renderTemplate(tool.bodyTemplate, opts.args);
      body = rendered;
    } else if (Object.keys(opts.args).length > 0) {
      body = JSON.stringify(opts.args);
    }
    if (!headers["Idempotency-Key"]) {
      headers["Idempotency-Key"] = idempotencyKey({
        tenantId: opts.tenantId,
        conversationId: opts.conversationId,
        toolName: `custom.${tool.slug}`,
        args: opts.args,
      });
    }
  }

  // 4) Fire request with timeout.
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), Number(tool.timeoutMs) || 10000);
  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(url.toString(), { method, headers, body, signal: ctrl.signal });
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name === "AbortError") return { ok: false, reason: `timeout_after_${tool.timeoutMs}ms` };
    return { ok: false, reason: `network_error:${err?.message || "unknown"}` };
  }
  clearTimeout(timeout);
  const dt = Date.now() - start;

  // 5) Parse response.
  let parsed: unknown;
  const ct = res.headers.get("content-type") || "";
  try {
    parsed = ct.includes("json") ? await res.json() : await res.text();
  } catch {
    parsed = await res.text().catch(() => null);
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: `upstream_${res.status}: ${typeof parsed === "string" ? parsed.slice(0, 240) : JSON.stringify(parsed).slice(0, 240)}`,
      meta: { status: res.status },
    };
  }

  // 6) Optional response field projection.
  let result: unknown = parsed;
  if (Array.isArray(tool.responseFields) && tool.responseFields.length > 0) {
    result = projectFields(parsed, tool.responseFields as string[]);
  }
  return { ok: true, result, meta: { status: res.status, durationMs: dt } };
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Render a `{{name}}` template with the given args. Missing keys fall
 * back to empty string (so partial templates don't crash). Args can also
 * use dotted paths (e.g. `{{customer.id}}`).
 */
export function renderTemplate(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const path = key.split(".");
    let v: any = args;
    for (const seg of path) {
      if (v == null) return "";
      v = v[seg];
    }
    return v == null ? "" : String(v);
  });
}

function renderTemplateMap(map: Record<string, any>, args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === "string") out[k] = renderTemplate(v, args);
  }
  return out;
}

function projectFields(obj: any, paths: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const segs = path.split(".");
    let v: any = obj;
    for (const seg of segs) {
      if (v == null) break;
      v = v[seg];
    }
    if (v !== undefined) out[path] = v;
  }
  return out;
}

// ─── Helper for storing secrets (used by admin route) ──────────

export function packSecrets(input: Record<string, any> | undefined | null): string | null {
  if (!input || Object.keys(input).length === 0) return null;
  return encryptCredentials(input);
}
