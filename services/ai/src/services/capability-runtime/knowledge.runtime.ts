/**
 * KNOWLEDGE runtime — binds the KNOWLEDGE contracts to a concrete KnowledgePort
 * and runs them through the SHARED resolver (the sole executor). READ-only set;
 * no approval gate needed.
 */

import {
  resolveExecution,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionTrace,
  type RuntimeBindings,
  type StrategyResult,
} from "@chatcenter/shared";
import { KNOWLEDGE_CONTRACTS } from "./knowledge.contracts";
import type { KnowledgePort, KnowledgeOpContext } from "./knowledge.port";

const TOP_K = 5; // parity with the legacy brain's retrieveRelevantChunks(…, 5)

export interface ExecuteKnowledgeOptions {
  port: KnowledgePort;
  logger?: (trace: ExecutionTrace) => void;
  strategyId?: string;
}

function defaultTraceLogger(trace: ExecutionTrace): void {
  const inv = trace.invariants.map((i) => `${i.id}:${i.outcome}`).join(",");
  console.log(
    `[capability-runtime] op=${trace.operation} mode=${trace.mode} strategy=${trace.strategy ?? "-"} ` +
      `result=${trace.result}${trace.reason ? `(${trace.reason})` : ""} executed=${trace.executed} invariants=[${inv}]`,
  );
}

export async function executeKnowledgeOperation(
  req: ExecutionRequest,
  opts: ExecuteKnowledgeOptions,
): Promise<{ result: ExecutionResult; trace: ExecutionTrace }> {
  const log = opts.logger ?? defaultTraceLogger;
  const contract = KNOWLEDGE_CONTRACTS[req.operation];
  if (!contract) {
    const result: ExecutionResult = { status: "BLOCKED", reason: `unknown_operation:${req.operation}` };
    const trace: ExecutionTrace = {
      operation: req.operation, capability: "KNOWLEDGE", mode: req.mode, strategy: opts.strategyId,
      invariants: [], optimizations: [], executed: false, result: "BLOCKED", reason: result.reason,
    };
    log(trace);
    return { result, trace };
  }

  let captured: ExecutionTrace | undefined;
  const ctx: KnowledgeOpContext = { tenantId: req.context.tenantId, conversationId: req.context.conversationId };
  const query = () => String(req.params.query ?? "").trim();

  const bind: RuntimeBindings = {
    verifiers: {
      query_present: () => query().length > 0,
      knowledge_search_established: () => true,
    },
    runSatisfier: async (operationId: string) => ({ ok: false, reason: `no_satisfier_for:${operationId}` }),
    executeStrategy: async (): Promise<StrategyResult> => {
      try {
        const passages = await opts.port.search(ctx, query(), TOP_K);
        const n = passages.length;
        return {
          ok: true,
          outcome: n === 0
            ? "the knowledge base has nothing on this — treat it as unknown, do not guess"
            : `${n} relevant passage(s) found`,
          data: { passages },
        };
      } catch (err: any) {
        return { ok: false, reason: String(err?.message || err || "knowledge_error"), recoverable: true };
      }
    },
    approvalGate: async () => ({ required: false as const }),
    strategyId: opts.strategyId ?? "knowledge",
    emitTrace: (t) => { captured = t; log(t); },
  };

  try {
    const result = await resolveExecution(contract, req, bind);
    return { result, trace: captured! };
  } catch (err: any) {
    const reason = `runtime_error:${String(err?.message || err)}`;
    const result: ExecutionResult = { status: "FAILED", reason, recoverable: true };
    const trace: ExecutionTrace = {
      operation: contract.id, capability: contract.capability, mode: req.mode,
      strategy: opts.strategyId ?? "knowledge", invariants: captured?.invariants ?? [],
      optimizations: captured?.optimizations ?? [], executed: false, result: "FAILED", reason,
    };
    log(trace);
    return { result, trace };
  }
}
