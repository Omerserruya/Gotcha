/**
 * Integration Tool Executor
 *
 * Executes tenant-scoped integration tools resolved via
 * TenantTool → CatalogTool. Uses the REAL schema fields:
 *
 *   CatalogTool.endpoint    — target URL (required)
 *   CatalogTool.method      — HTTP verb (default GET)
 *   CatalogTool.inputSchema — JSON-Schema-ish params contract
 *   CatalogTool.category    — READ | WRITE | DELETE | ACTION
 *
 * Credentials and per-tenant config come from TenantIntegration.
 * No silent fallback: missing endpoint, unreachable host, 4xx/5xx →
 * structured failure with { ok:false, error }.
 */
import { prisma, analyticsQueue } from "@chatcenter/shared";
import axios from "axios";
import { trackToolCall } from "./usage.service";
import { logAudit } from "./audit.service";

export async function getToolsForTenant(tenantId: string) {
  return prisma.tenantTool.findMany({
    where: {
      tenantId,
      isEnabled: true,
      tenantIntegration: { status: "CONNECTED" },
    },
    include: {
      catalogTool: true,
      tenantIntegration: {
        include: {
          integration: { select: { name: true, slug: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

export interface ToolExecutionResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  status?: number;
  durationMs?: number;
  executionId?: string;
}

/**
 * Validate `input` against a CatalogTool.inputSchema.
 * Very permissive intentionally — we only enforce presence of keys the
 * schema's top-level `required` array asks for. The LLM tool call surface
 * is otherwise loosely typed, so we refuse to invent stricter gates here.
 */
function validateInput(
  inputSchema: unknown,
  input: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  if (!inputSchema || typeof inputSchema !== "object") return { ok: true };
  const schema = inputSchema as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const key of required) {
    if (!(key in input) || input[key] === undefined || input[key] === null || input[key] === "") {
      return { ok: false, reason: `missing required param: ${key}` };
    }
  }
  return { ok: true };
}

export async function executeTool(params: {
  tenantId: string;
  conversationId: string;
  tenantToolId: string;
  input: Record<string, any>;
  triggeredBy: string;
}): Promise<ToolExecutionResult> {
  const { tenantId, conversationId, tenantToolId, input, triggeredBy } = params;

  const tenantTool = await prisma.tenantTool.findFirst({
    where: { id: tenantToolId, tenantId },
    include: {
      catalogTool: true,
      tenantIntegration: true,
    },
  });

  if (!tenantTool) {
    return { ok: false, error: "tool not found" };
  }
  if (!tenantTool.isEnabled) {
    return { ok: false, error: "tool is disabled" };
  }

  const catalogTool = tenantTool.catalogTool;
  const integration = tenantTool.tenantIntegration;
  const credentials = (integration.credentials as Record<string, any>) || {};
  const integrationConfig = (integration.config as Record<string, any>) || {};
  const overrides = (tenantTool.configOverrides as Record<string, any>) || {};

  // Fail loudly on missing endpoint — no silent fallback.
  if (!catalogTool.endpoint) {
    return { ok: false, error: `catalog tool "${catalogTool.slug}" has no endpoint configured` };
  }

  // Validate params against catalog schema before dispatching.
  const gate = validateInput(catalogTool.inputSchema, input);
  if (!gate.ok) {
    return { ok: false, error: gate.reason };
  }

  const method = (catalogTool.method || "GET").toUpperCase() as
    | "GET"
    | "POST"
    | "PUT"
    | "PATCH"
    | "DELETE";

  // URL template support: replace :param placeholders from `input` or
  // from integrationConfig.  e.g. "/contacts/:id" + { id: "c1" }.
  let url = catalogTool.endpoint;
  url = url.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, key: string) => {
    const v = input[key] ?? integrationConfig[key] ?? overrides[key];
    return v !== undefined && v !== null ? encodeURIComponent(String(v)) : "";
  });

  // Credential injection. Common patterns: bearer token, API key header,
  // or explicit headers from integration.config.headers.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof credentials.accessToken === "string") {
    headers["Authorization"] = `Bearer ${credentials.accessToken}`;
  } else if (typeof credentials.apiKey === "string") {
    headers["Authorization"] = `Bearer ${credentials.apiKey}`;
  }
  if (integrationConfig.headers && typeof integrationConfig.headers === "object") {
    Object.assign(headers, integrationConfig.headers);
  }

  const startTime = Date.now();
  let output: unknown = null;
  let success = false;
  let statusCode: number | undefined;
  let errorMessage: string | undefined;

  try {
    const axiosConfig: any = {
      url,
      method,
      headers,
      timeout: 10000,
    };
    if (method === "GET" || method === "DELETE") {
      axiosConfig.params = input;
    } else {
      axiosConfig.data = input;
    }
    const response = await axios(axiosConfig);
    statusCode = response.status;
    output = response.data;
    success = true;
  } catch (err: any) {
    if (err?.code === "ECONNABORTED" || err?.message?.includes("timeout")) {
      errorMessage = "tool execution timed out";
    } else if (err?.response) {
      statusCode = err.response.status;
      errorMessage = `upstream ${err.response.status}: ${
        typeof err.response.data === "string"
          ? err.response.data
          : JSON.stringify(err.response.data)
      }`;
      output = err.response.data;
    } else {
      errorMessage = err?.message ?? "tool execution failed";
    }
  }

  const durationMs = Date.now() - startTime;

  // Always record the execution — success or failure — for the audit
  // trail. Never silently swallow.
  const execution = await prisma.toolExecution.create({
    data: {
      tenantId,
      conversationId,
      tenantToolId,
      input,
      output: output as any,
      success,
      durationMs,
      triggeredBy,
    },
  });

  await analyticsQueue.add("tool-executed", {
    tenantId,
    event: "tool_executed",
    data: {
      conversationId,
      tenantToolId,
      toolName: catalogTool.name,
      success,
      durationMs,
    },
    timestamp: new Date().toISOString(),
  });

  trackToolCall(tenantId, { tool: catalogTool.name, conversationId }).catch((err) =>
    console.error("[ToolExec] Usage tracking failed:", err.message),
  );

  logAudit({
    tenantId,
    actor: { type: triggeredBy === "ai" ? "ai" : "user", id: triggeredBy !== "ai" ? triggeredBy : undefined },
    action: "tool.executed",
    target: { type: "tool", id: tenantToolId },
    metadata: {
      toolName: catalogTool.name,
      slug: catalogTool.slug,
      endpoint: catalogTool.endpoint,
      method,
      success,
      status: statusCode,
      durationMs,
      conversationId,
      error: errorMessage,
    },
  }).catch((err) => console.error("[ToolExec] Audit logging failed:", err.message));

  return {
    ok: success,
    output,
    error: errorMessage,
    status: statusCode,
    durationMs,
    executionId: execution.id,
  };
}

export async function getToolExecutions(tenantId: string, conversationId: string) {
  return prisma.toolExecution.findMany({
    where: { conversationId, tenantId },
    orderBy: { createdAt: "asc" },
    include: {
      tenantTool: {
        include: {
          catalogTool: { select: { name: true, slug: true, category: true } },
        },
      },
    },
  });
}
