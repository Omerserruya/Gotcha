/**
 * Integration Tool Executor
 *
 * Executes tenant-scoped integration tools resolved via
 * TenantTool → CatalogTool. Uses the REAL schema fields:
 *
 *   CatalogTool.endpoint    - target URL (required)
 *   CatalogTool.method      - HTTP verb (default GET)
 *   CatalogTool.inputSchema - JSON-Schema-ish params contract
 *   CatalogTool.category    - READ | WRITE | DELETE | ACTION
 *
 * Credentials and per-tenant config come from TenantIntegration.
 * No silent fallback: missing endpoint, unreachable host, 4xx/5xx →
 * structured failure with { ok:false, error }.
 */
import { prisma, analyticsQueue, assertPublicUrl } from "@chatcenter/shared";
import axios from "axios";
import { trackToolCall } from "./usage.service";
import { logAudit } from "./audit.service";
import { maybeRefreshZohoToken } from "./zoho.service";

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
 * Very permissive intentionally - we only enforce presence of keys the
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
      tenantIntegration: {
        include: { integration: { select: { slug: true } } },
      },
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
  const integrationSlug = (integration as any).integration?.slug as string | undefined;
  const credentials = (integration.credentials as Record<string, any>) || {};
  const integrationConfig = (integration.config as Record<string, any>) || {};
  const overrides = (tenantTool.configOverrides as Record<string, any>) || {};

  // Provider-specific: Zoho access tokens live ~1h. Refresh pre-emptively
  // so the downstream request doesn't eat an avoidable 401. If the refresh
  // fails we fall through with the stale token - axios will surface the
  // eventual 401 and the audit log records it.
  if (integrationSlug === "zoho_crm") {
    try {
      const fresh = await maybeRefreshZohoToken(integration.id);
      if (fresh && fresh !== credentials.accessToken) {
        credentials.accessToken = fresh;
      }
    } catch (err: any) {
      console.warn("[ToolExec] Zoho token refresh failed:", err?.message ?? err);
    }
  }

  // Endpoint-less catalog tools are backed by a provider ADAPTER (HubSpot,
  // Salesforce, Monday, …) rather than an HTTP template. Route them to the
  // adapter framework instead of failing - otherwise the bot's CRM action tools
  // (create_lead/create_contact/create_deal on HubSpot/Salesforce) are dead and
  // every lead-creation attempt errors. Providers WITH an HTTP template (Zoho,
  // …) keep the endpoint path below.
  if (!catalogTool.endpoint) {
    if (!integrationSlug) {
      return { ok: false, error: `catalog tool "${catalogTool.slug}" has no endpoint configured` };
    }
    const { executeAdapterTool } = await import("./connectors/integration-framework");
    const adapterRes = await executeAdapterTool({
      tenantId,
      conversationId,
      toolFunctionName: `${integrationSlug}.${catalogTool.slug}`,
      args: input,
    });
    // Mutating writes change the lead/contact rows the prefetch cache is keyed
    // on - invalidate so the next bot turn rebuilds context against fresh data.
    if (adapterRes.ok && CRM_MUTATING_SLUGS.has(catalogTool.slug || "")) {
      try {
        const { invalidateCrmPrefetch } = await import("./crm-prefetch.service");
        invalidateCrmPrefetch(tenantId, conversationId);
      } catch (err: any) {
        console.warn("[ToolExec] crm-prefetch invalidate (adapter) failed:", err?.message);
      }
    }
    return adapterRes.ok
      ? { ok: true, output: (adapterRes as any).result ?? null, error: undefined }
      : { ok: false, output: null, error: (adapterRes as any).reason || "adapter_failed" };
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
  // If endpoint is relative ("/..."), prepend integrationConfig.baseUrl -
  // used for providers with per-tenant hosts (Zoho api_domain, Zendesk
  // subdomain, etc.). Absolute URLs in the catalog are honored as-is.
  let url = catalogTool.endpoint;
  if (url.startsWith("/") && typeof integrationConfig.baseUrl === "string" && integrationConfig.baseUrl) {
    url = integrationConfig.baseUrl.replace(/\/$/, "") + url;
  }
  url = url.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, key: string) => {
    const v = input[key] ?? integrationConfig[key] ?? overrides[key];
    return v !== undefined && v !== null ? encodeURIComponent(String(v)) : "";
  });

  // Credential injection. Default scheme is Bearer; providers that use a
  // custom scheme (Zoho: "Zoho-oauthtoken") override via integration.config.authScheme.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const authScheme: string = typeof integrationConfig.authScheme === "string" && integrationConfig.authScheme
    ? integrationConfig.authScheme
    : "Bearer";
  if (typeof credentials.accessToken === "string") {
    headers["Authorization"] = `${authScheme} ${credentials.accessToken}`;
  } else if (typeof credentials.apiKey === "string") {
    headers["Authorization"] = `${authScheme} ${credentials.apiKey}`;
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
    // SSRF guard: for relative catalog endpoints the host comes from tenant
    // integrationConfig.baseUrl. Block private/link-local/metadata targets at
    // DNS resolution before dispatching. (Absolute catalog URLs are platform-
    // authored, but validating uniformly costs nothing and is defense in depth.)
    await assertPublicUrl(url);
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

  // Always record the execution - success or failure - for the audit
  // trail. Never silently swallow.
  const execution = await prisma.toolExecution.create({
    data: {
      tenantId,
      conversationId,
      tenantToolId,
      // Denormalised on purpose. The FK is SET NULL, so when a tenant
      // disconnects the integration this row outlives its tenant_tool - and
      // without the name it could no longer say what had run. Analytics has
      // always recorded the name; the audit log did not.
      toolName: catalogTool.name,
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

  // CRM-mutating tools change the lead/contact rows the prefetch cache
  // is keyed on. Invalidate so the next bot turn rebuilds the prompt
  // context against fresh Zoho data instead of stale matches. Read-only
  // slugs (*_search, get_*, list_*) are intentionally skipped - they
  // already CAME from the cache or don't change anything.
  if (success) {
    const slug = catalogTool.slug || "";
    const isReadOnly = /(^|_)(search|get|list)(_|$)/i.test(slug);
    if (!isReadOnly && CRM_MUTATING_SLUGS.has(slug)) {
      try {
        const { invalidateCrmPrefetch } = await import("./crm-prefetch.service");
        invalidateCrmPrefetch(tenantId, conversationId);
        console.log(
          `[ToolExec] crm-prefetch invalidated tenant=${tenantId} conv=${conversationId} ` +
          `reason=tool_executed slug=${slug}`,
        );
      } catch (err: any) {
        console.warn("[ToolExec] crm-prefetch invalidate failed:", err?.message);
      }
    }
  }

  return {
    ok: success,
    output,
    error: errorMessage,
    status: statusCode,
    durationMs,
    executionId: execution.id,
  };
}

// Tool slugs that mutate CRM lead/contact rows. Anything not in this list
// (or matching the read-only pattern above) leaves the prefetch cache alone.
// Add new mutating slugs here when new connector tools land.
const CRM_MUTATING_SLUGS = new Set<string>([
  "create_lead",
  "update_lead",
  "delete_lead",
  "add_lead_note",
  "add_lead_tag",
  "remove_lead_tag",
  "convert_lead",
  "create_contact",
  "update_contact",
  "delete_contact",
  "add_contact_note",
  "add_contact_tag",
  "remove_contact_tag",
  "merge_contacts",
]);

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
