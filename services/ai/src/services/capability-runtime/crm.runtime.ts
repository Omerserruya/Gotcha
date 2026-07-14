/**
 * CRM runtime - binds the CRM contracts to a concrete CrmPort and runs them through
 * the SHARED resolver (the sole executor). Every CRM business rule lives here as a
 * verifier over the port's concrete reads - NOT in the port, NOT in the adapter. The
 * driver stays a thin wrapper: the runtime calls the port, the port calls existing
 * production CRM code, the result comes back with a structured trace.
 */

import {
  resolveExecution,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionTrace,
  type RuntimeBindings,
  type StrategyResult,
} from "@chatcenter/shared";
import { CRM_CONTRACTS } from "./crm.contracts";
import type { CrmPort, CrmOpContext } from "./crm.port";
import { kernelApprovalGate } from "./approval-gate";

export interface ExecuteCrmOptions {
  port: CrmPort;
  logger?: (trace: ExecutionTrace) => void;
  strategyId?: string;
}

function defaultTraceLogger(trace: ExecutionTrace): void {
  const inv = trace.invariants.map((i) => `${i.id}:${i.outcome}`).join(",");
  console.log(
    `[capability-runtime] op=${trace.operation} mode=${trace.mode} strategy=${trace.strategy ?? "-"} ` +
      `result=${trace.result}${trace.reason ? `(${trace.reason})` : ""} executed=${trace.executed} ` +
      `successVerified=${trace.successVerified ?? "-"} invariants=[${inv}]`,
  );
}

/** Execute one CRM operation: load the contract, build port-backed bindings, resolve. */
export async function executeCrmOperation(
  req: ExecutionRequest,
  opts: ExecuteCrmOptions,
): Promise<{ result: ExecutionResult; trace: ExecutionTrace }> {
  const log = opts.logger ?? defaultTraceLogger;
  const contract = CRM_CONTRACTS[req.operation];
  if (!contract) {
    const result: ExecutionResult = { status: "BLOCKED", reason: `unknown_operation:${req.operation}` };
    const trace: ExecutionTrace = {
      operation: req.operation, capability: "CRM", mode: req.mode, strategy: opts.strategyId,
      invariants: [], optimizations: [], executed: false, result: "BLOCKED", reason: result.reason,
    };
    log(trace);
    return { result, trace };
  }

  let captured: ExecutionTrace | undefined;
  const bind = buildCrmBindings(req, opts, (t) => { captured = t; log(t); });
  try {
    const result = await resolveExecution(contract, req, bind);
    return { result, trace: captured! };
  } catch (err: any) {
    const reason = `runtime_error:${String(err?.message || err)}`;
    const result: ExecutionResult = { status: "FAILED", reason, recoverable: true };
    const trace: ExecutionTrace = {
      operation: contract.id, capability: contract.capability, mode: req.mode,
      strategy: opts.strategyId ?? "crm", invariants: captured?.invariants ?? [],
      optimizations: captured?.optimizations ?? [], executed: false, result: "FAILED", reason,
    };
    log(trace);
    return { result, trace };
  }
}

function buildCrmBindings(
  req: ExecutionRequest,
  opts: ExecuteCrmOptions,
  emitTrace: (t: ExecutionTrace) => void,
): RuntimeBindings {
  const port = opts.port;
  const ctx: CrmOpContext = {
    tenantId: req.context.tenantId,
    conversationId: req.context.conversationId,
    customerExternalId: req.context.customerExternalId,
    customerEmail: req.context.customerEmail as string | undefined,
    customerPhone: req.context.customerPhone as string | undefined,
  };

  // Search identifiers: explicit params win, else fall back to the conversation's
  // known identity (email / external id) so an ambient lookup needs no extra input.
  const email = () => (req.params.email as string) || ctx.customerEmail || undefined;
  const phone = () => (req.params.phone as string) || ctx.customerPhone || undefined;
  const externalId = () => ctx.customerExternalId || undefined;
  const hasKey = () => !!(email() || phone() || externalId());

  const name = () => (req.params.name as string) || undefined;

  const verifiers: RuntimeBindings["verifiers"] = {
    search_key_known: () => hasKey(),
    // Success: the search ran and established a (possibly empty) result set.
    customer_search_established: () => true,
    // UPSERT: a strong identifier (email or phone) is needed to resolve OR create.
    identity_known: () => !!(email() || phone()),
    // Success: the identity flow returned a single resolved contact (strategy ok).
    customer_record_resolved: () => true,
    // ADD_NOTE / GET_CONTEXT / UPDATE / TASK preconditions + successes.
    contact_known: () => !!(req.params.contact_id as string),
    note_body_present: () => !!(req.params.note as string),
    note_recorded: () => true,
    customer_context_established: () => true,
    fields_present: () => {
      const f = req.params.fields;
      return !!f && typeof f === "object" && Object.keys(f as object).length > 0;
    },
    record_updated: () => true,
    subject_present: () => !!String(req.params.subject ?? "").trim(),
    task_created: () => true,
  };

  const executeStrategy = async (contract: { id: string }): Promise<StrategyResult> => {
    try {
      switch (contract.id) {
        case "SEARCH_CUSTOMER": {
          const res = await port.searchCustomer(ctx, { email: email(), phone: phone(), external_id: externalId() });
          if (!res.ok) return { ok: false, reason: res.reason || "crm_search_failed", recoverable: true };
          const n = res.contacts.length;
          const who = res.contacts.map((c) => c.displayName || c.email || c.phone || c.id).slice(0, 3).join(", ");
          return {
            ok: true,
            outcome: n === 0 ? "no matching customer in CRM" : `${n} match(es): ${who}`,
            data: { contacts: res.contacts, matchCount: n },
          };
        }
        case "UPSERT_CUSTOMER": {
          const r = await port.upsertCustomer(ctx, { email: email(), phone: phone(), name: name() });
          switch (r.status) {
            case "created":
              return { ok: true, outcome: "created a new CRM contact", data: { contact: r.contact, resolution: "created" } };
            case "linked":
              return { ok: true, outcome: `matched existing CRM contact${r.wasEnriched ? " (enriched)" : ""}`, data: { contact: r.contact, resolution: "linked", enriched: !!r.wasEnriched } };
            case "merged":
              return { ok: true, outcome: "reconciled duplicate CRM contacts", data: { contact: r.contact, resolution: "merged" } };
            case "needs_approval":
              // Don't guess an identity - stop for an operator (recoverable → loop escalates).
              return { ok: false, reason: `ambiguous_identity_needs_operator:${r.candidates?.length ?? 0}_candidates`, data: { candidates: r.candidates }, recoverable: true };
            case "not_found":
              return { ok: false, reason: "not_found", recoverable: true };
            default:
              return { ok: false, reason: r.reason || "crm_upsert_failed", recoverable: true };
          }
        }
        case "ADD_NOTE": {
          const r = await port.addNote(ctx, {
            contactId: req.params.contact_id as string,
            kind: req.params.kind as string | undefined,
            body: req.params.note as string,
          });
          if (!r.ok) return { ok: false, reason: r.reason || "crm_note_failed", recoverable: true };
          return { ok: true, outcome: "recorded a note on the customer's CRM timeline", data: { noteId: r.id } };
        }
        case "GET_CUSTOMER_CONTEXT": {
          const r = await port.getContext(ctx, {
            contactId: req.params.contact_id as string,
            kind: req.params.kind as string | undefined,
          });
          if (!r.ok || !r.context) return { ok: false, reason: r.reason || "crm_context_failed", recoverable: true };
          const c = r.context;
          return {
            ok: true,
            outcome: `context loaded: ${c.activities} recent activities, ${c.deals.length} open deal(s), ${c.tickets.length} open ticket(s)`,
            data: { context: c },
          };
        }
        case "UPDATE_RECORD": {
          const r = await port.updateRecord(ctx, {
            contactId: req.params.contact_id as string,
            kind: req.params.kind as string | undefined,
            fields: (req.params.fields ?? {}) as Record<string, unknown>,
          });
          if (!r.ok) return { ok: false, reason: r.reason || "crm_update_failed", recoverable: true };
          const keys = Object.keys((req.params.fields ?? {}) as object).join(", ");
          return { ok: true, outcome: `updated ${keys} on the customer's CRM record (sparse patch)`, data: { recordId: r.id } };
        }
        case "CREATE_TASK": {
          const r = await port.createTask(ctx, {
            contactId: req.params.contact_id as string,
            kind: req.params.kind as string | undefined,
            subject: String(req.params.subject ?? ""),
            body: req.params.body as string | undefined,
            dueAt: req.params.due_at as string | undefined,
          });
          if (!r.ok) return { ok: false, reason: r.reason || "crm_task_failed", recoverable: true };
          return { ok: true, outcome: "created a follow-up task for the human team", data: { taskId: r.id } };
        }
        default:
          return { ok: false, reason: `unhandled_operation:${contract.id}` };
      }
    } catch (err: any) {
      return { ok: false, reason: String(err?.message || err || "crm_error"), recoverable: true };
    }
  };

  // HITL: which legacy tool's policy governs each CRM WRITE. UPSERT maps to the
  // governed vendor-neutral semantic create (same policy home the legacy brain
  // consults); ADD_NOTE is a static-policy name (floor "never", tenant-overridable
  // via TenantToolPermission).
  const OP_POLICY_TOOL: Record<string, string> = {
    UPSERT_CUSTOMER: "integration_create_lead",
    ADD_NOTE: "add_note",
    UPDATE_RECORD: "update_record",
    CREATE_TASK: "create_task",
  };

  return {
    verifiers,
    runSatisfier: async (operationId: string) => ({ ok: false, reason: `no_satisfier_for:${operationId}` }),
    executeStrategy: (contract) => executeStrategy(contract),
    // Real HITL via the shared production gate (evaluatePolicies + Approvals inbox).
    approvalGate: async (contract, _req, gateOpts) => {
      const policyTool = OP_POLICY_TOOL[contract.id];
      if (!policyTool) return { required: false as const };
      return kernelApprovalGate(contract, req, { policyTool, args: { ...req.params } }, gateOpts);
    },
    strategyId: opts.strategyId ?? "crm",
    emitTrace,
  };
}
