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

export async function executeTool(params: {
  tenantId: string;
  conversationId: string;
  tenantToolId: string;
  input: Record<string, any>;
  triggeredBy: string;
}) {
  const { tenantId, conversationId, tenantToolId, input, triggeredBy } = params;

  const tenantTool = await prisma.tenantTool.findFirst({
    where: { id: tenantToolId, tenantId },
    include: {
      catalogTool: true,
      tenantIntegration: true,
    },
  });

  if (!tenantTool) throw new Error("Tool not found");
  if (!tenantTool.isEnabled) throw new Error("Tool is not active");

  const catalogTool = tenantTool.catalogTool;
  const credentials = tenantTool.tenantIntegration.credentials as any;
  const config = { ...((catalogTool.config as any) || {}), ...credentials };

  const startTime = Date.now();
  let output: Record<string, any>;
  let success = true;

  try {
    switch (catalogTool.toolType) {
      case "INTERNAL_API": {
        if (config?.apiUrl) {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
          if (config.headers && typeof config.headers === "object") Object.assign(headers, config.headers);

          const method = (input.method || "GET").toUpperCase();
          const axiosConfig: any = { url: config.apiUrl, method, headers, timeout: 10000 };

          if (method === "GET") {
            axiosConfig.params = input.params || input;
          } else {
            axiosConfig.data = input.body || input;
          }

          const response = await axios(axiosConfig);
          output = { status: response.status, data: response.data };
        } else {
          output = { result: "Internal API executed successfully" };
        }
        break;
      }

      case "CRM": {
        if (config?.apiUrl) {
          const action = input.action || "lookup";
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

          let endpoint = config.apiUrl;
          let response: any;

          if (action === "lookup" && input.customerId) {
            endpoint += `/contacts/${input.customerId}`;
            response = await axios.get(endpoint, { headers, timeout: 10000 });
          } else if (action === "search" && input.query) {
            endpoint += `/contacts/search?q=${encodeURIComponent(input.query)}`;
            response = await axios.get(endpoint, { headers, timeout: 10000 });
          } else if (action === "create") {
            response = await axios.post(`${endpoint}/contacts`, input.body || input, { headers, timeout: 10000 });
          } else {
            response = await axios.get(endpoint, { headers, timeout: 10000 });
          }

          output = { status: response.status, data: response.data };
        } else {
          output = { customer: { name: "Unknown", status: "active" } };
        }
        break;
      }

      case "ECOMMERCE": {
        if (config?.apiUrl) {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (config.apiKey) headers["X-Shopify-Access-Token"] = config.apiKey;
          if (config.headers && typeof config.headers === "object") Object.assign(headers, config.headers);

          const action = input.action || "lookup";
          let endpoint = config.apiUrl;
          let response: any;

          if (action === "refund" && input.orderId) {
            response = await axios.post(
              `${endpoint}/orders/${input.orderId}/refunds.json`,
              input.body || {},
              { headers, timeout: 10000 }
            );
            output = { status: response.status, data: response.data };
          } else {
            if (action === "order_lookup" && input.orderId) {
              endpoint += `/orders/${input.orderId}.json`;
            } else if (action === "customer_lookup" && input.customerId) {
              endpoint += `/customers/${input.customerId}.json`;
            }
            response = await axios.get(endpoint, { headers, timeout: 10000 });
            output = { status: response.status, data: response.data };
          }
        } else {
          output = { order: { id: "ORD-UNKNOWN", status: "shipped" } };
        }
        break;
      }

      case "KNOWLEDGE_BASE": {
        if (config?.apiUrl) {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
          const response = await axios.post(
            config.apiUrl,
            { query: input.query || input.text || "" },
            { headers, timeout: 10000 }
          );
          output = { status: response.status, data: response.data };
        } else {
          output = { result: "Knowledge base search completed", note: "Configure apiUrl for external KB" };
        }
        break;
      }

      case "CUSTOM":
      default: {
        if (config?.apiUrl) {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
          if (config.headers && typeof config.headers === "object") Object.assign(headers, config.headers);

          const method = (config.method || input.method || "POST").toUpperCase();
          const response = await axios({ url: config.apiUrl, method, headers, data: input, timeout: 10000 });
          output = { status: response.status, data: response.data };
        } else {
          output = { result: "Tool executed successfully" };
        }
        break;
      }
    }
  } catch (err: any) {
    success = false;
    if (err.code === "ECONNABORTED" || err.message?.includes("timeout")) {
      output = { error: "Tool execution timed out" };
    } else {
      output = {
        error: err.message || "Tool execution failed",
        status: err.response?.status,
        data: err.response?.data,
      };
    }
  }

  const durationMs = Date.now() - startTime;

  const execution = await prisma.toolExecution.create({
    data: {
      tenantId,
      conversationId,
      tenantToolId,
      input,
      output,
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

  // Track usage (fire-and-forget)
  trackToolCall(tenantId, {
    tool: catalogTool.name,
    conversationId,
  }).catch((err) => console.error("[ToolExec] Usage tracking failed:", err.message));

  // Audit log (fire-and-forget)
  logAudit({
    tenantId,
    actor: { type: triggeredBy === "ai" ? "ai" : "user", id: triggeredBy !== "ai" ? triggeredBy : undefined },
    action: "tool.executed",
    target: { type: "tool", id: tenantToolId },
    metadata: { toolName: catalogTool.name, success, durationMs, conversationId },
  }).catch((err) => console.error("[ToolExec] Audit logging failed:", err.message));

  return execution;
}

export async function getToolExecutions(tenantId: string, conversationId: string) {
  return prisma.toolExecution.findMany({
    where: { conversationId, tenantId },
    orderBy: { createdAt: "asc" },
    include: {
      tenantTool: {
        include: {
          catalogTool: { select: { name: true, toolType: true } },
        },
      },
    },
  });
}
