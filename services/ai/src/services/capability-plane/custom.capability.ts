/**
 * CUSTOM operation set - tenant-defined HTTP + DB-query tools as generic
 * Operations. The menu is DYNAMIC per tenant: `describeWorld` lists the tenant's
 * active custom tools (the same `listCustomApiTools`/`listCustomDbQueryTools`
 * the legacy surface uses); `execute` delegates to the EXISTING production
 * executors (`executeCustomApiTool` / `executeCustomDbQueryTool` - host
 * whitelists, template rendering, SQL/Mongo runners all untouched).
 *
 * Operation ids are the EXACT legacy names (`custom.<slug>` / `custom_db.<slug>`)
 * so the production policy layer prices them natively: `evaluatePolicies` has a
 * dedicated custom-tool branch (risk-based floor - read+non-HIGH auto-runs,
 * write/HIGH requires approval). The approval mapping is therefore IDENTITY.
 *
 * Contracts are built from tenant data at read time - still contracts-as-data,
 * the data just lives in the DB. Nothing in the kernel changes.
 */

import type {
  AvailableOperation,
  CapabilityWorldView,
  ExecutionRequest,
  ExecutionResult,
  ExecutionTrace,
  OperationContract,
} from "@chatcenter/shared";
import { resolveExecution } from "@chatcenter/shared";
import { listCustomApiTools, executeCustomApiTool } from "../connectors/custom-api.service";
import { listCustomDbQueryTools, executeCustomDbQueryTool } from "../connectors/custom-db.service";
import { kernelApprovalGate } from "../capability-runtime/approval-gate";
import type { CapabilityRegistration } from "./registry";

interface CustomToolDef {
  opName: string; // custom.<slug> | custom_db.<slug>
  kind: "api" | "db";
  slug: string;
  description: string;
  whenToUse: string;
  whenNotToUse: string | null;
  parameters: Record<string, unknown>; // JSON schema
  category: string;
  riskLevel: string;
}

async function listAll(tenantId: string): Promise<CustomToolDef[]> {
  const [api, db] = await Promise.all([
    listCustomApiTools(tenantId).catch(() => []),
    listCustomDbQueryTools(tenantId).catch(() => []),
  ]);
  return [
    ...api.map((t): CustomToolDef => ({
      opName: `custom.${t.slug}`, kind: "api", slug: t.slug, description: t.description,
      whenToUse: t.whenToUse, whenNotToUse: t.whenNotToUse, parameters: t.parameters,
      category: t.category, riskLevel: t.riskLevel,
    })),
    ...db.map((t: any): CustomToolDef => ({
      opName: `custom_db.${t.slug}`, kind: "db", slug: t.slug, description: t.description,
      whenToUse: t.whenToUse, whenNotToUse: t.whenNotToUse ?? null, parameters: t.parameters ?? { type: "object", properties: {}, required: [] },
      category: t.category ?? "READ", riskLevel: t.riskLevel ?? "LOW",
    })),
  ];
}

/** JSON-schema properties → meaning-level param hints. */
function paramsOf(def: CustomToolDef): AvailableOperation["params"] {
  const props = (def.parameters as any)?.properties ?? {};
  const required = new Set<string>(Array.isArray((def.parameters as any)?.required) ? (def.parameters as any).required : []);
  return Object.entries(props).map(([name, p]: [string, any]) => ({
    name,
    meaning: String(p?.description ?? name),
    required: required.has(name),
  }));
}

/** Build the (dynamic) contract for one tenant-defined tool. */
function contractOf(def: CustomToolDef): OperationContract {
  const isRead = String(def.category).toUpperCase() === "READ";
  return {
    id: def.opName,
    capability: "CUSTOM",
    effect: isRead ? "read" : "write",
    meaning: `${def.description} - when to use: ${def.whenToUse}${def.whenNotToUse ? `; do NOT use: ${def.whenNotToUse}` : ""}`,
    params: paramsOf(def).map((p) => ({ key: p.name, meaning: p.meaning, required: p.required })),
    outcome: "the tool's result, verbatim from the business's own system",
    success: { id: "custom_tool_completed", statement: "the tenant-defined tool ran and returned its result" },
    invariants: [
      {
        id: "required_params_present",
        statement: "every required input of the tool is provided",
        strength: "MUST",
        checkpoint: "PRE",
        enforcement: "RUNTIME_VERIFIED",
        onUnsatisfied: { kind: "NEEDS_INPUT", field: "missing_required_params" },
      },
    ],
    failureModes: ["tool_unavailable", "execution_failed"],
    recoveryPosture: { retries: "bounded", alternatives: false, askCustomer: true, escalate: "last_resort" },
    approval: "configurable", // priced by the production custom-tool policy branch (identity mapping)
  };
}

async function execute(req: ExecutionRequest): Promise<{ result: ExecutionResult; trace: ExecutionTrace }> {
  const tenantId = req.context.tenantId;
  const defs = await listAll(tenantId);
  const def = defs.find((d) => d.opName === req.operation);

  let captured: ExecutionTrace | undefined;
  const emptyTrace = (result: ExecutionTrace["result"], reason?: string): ExecutionTrace => ({
    operation: req.operation, capability: "CUSTOM", mode: req.mode, strategy: "custom",
    invariants: [], optimizations: [], executed: false, result, reason,
  });

  if (!def) {
    const result: ExecutionResult = { status: "BLOCKED", reason: `unknown_operation:${req.operation}` };
    return { result, trace: emptyTrace("BLOCKED", result.reason) };
  }

  const contract = contractOf(def);
  const required = new Set<string>(Array.isArray((def.parameters as any)?.required) ? (def.parameters as any).required : []);
  const missing = [...required].filter((k) => req.params[k] == null || String(req.params[k]).trim() === "");

  try {
    const result = await resolveExecution(contract, req, {
      verifiers: {
        required_params_present: () => missing.length === 0,
        custom_tool_completed: () => true,
      },
      runSatisfier: async (operationId: string) => ({ ok: false, reason: `no_satisfier_for:${operationId}` }),
      executeStrategy: async () => {
        const exec = def.kind === "api"
          ? await executeCustomApiTool({ tenantId, slug: def.slug, args: req.params, conversationId: req.context.conversationId })
          : await executeCustomDbQueryTool({ tenantId, slug: def.slug, args: req.params, conversationId: req.context.conversationId });
        if (!exec.ok) return { ok: false, reason: exec.reason, recoverable: true };
        return {
          ok: true,
          outcome: `tool ran successfully`,
          data: { result: (exec as any).result },
        };
      },
      // IDENTITY policy mapping: evaluatePolicies has a native custom./custom_db. branch.
      approvalGate: (c, r, o) => kernelApprovalGate(c, r, { policyTool: def.opName, args: { ...req.params } }, o),
      strategyId: "custom",
      emitTrace: (t) => { captured = t; },
    });
    return { result, trace: captured ?? emptyTrace(result.status) };
  } catch (err: any) {
    const reason = `runtime_error:${String(err?.message || err)}`;
    return { result: { status: "FAILED", reason, recoverable: true }, trace: emptyTrace("FAILED", reason) };
  }
}

export const CustomCapability: CapabilityRegistration = {
  name: "CUSTOM",

  ownsOperation: (op) => op.startsWith("custom.") || op.startsWith("custom_db."),

  async describeWorld(ctx): Promise<CapabilityWorldView> {
    const defs = await listAll(ctx.tenantId);
    return {
      capability: "CUSTOM",
      summary: defs.length
        ? `${defs.length} business-specific tool(s) are available - each description says when to use it.`
        : "No business-specific tools are configured.",
      facts: { customToolCount: defs.length },
      operations: defs.map((d) => ({
        name: d.opName,
        meaning: `${d.description} - when to use: ${d.whenToUse}${d.whenNotToUse ? `; do NOT use: ${d.whenNotToUse}` : ""}`,
        params: paramsOf(d),
      })),
    };
  },

  execute,
};
