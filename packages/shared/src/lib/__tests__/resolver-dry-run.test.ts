/**
 * P1-4 — advisory vs dry_run split at the resolver.
 * advisory: writes → RECOMMENDED before the gate (never probed).
 * dry_run:  writes → RECOMMENDED, but the approval gate is PROBED (probe:true,
 *           nothing created) and the trace records whether approval would be
 *           required — shadow evidence for the HITL surface.
 */

import { describe, it, expect } from "vitest";
import { resolveExecution } from "../capability-runtime/resolver";
import type { OperationContract, ExecutionRequest, ExecutionTrace } from "../capability-runtime/contract";

const WRITE_CONTRACT: OperationContract = {
  id: "TEST_WRITE",
  meaning: "a write op used to test mode semantics",
  effect: "write",
  approval: "policy",
  params: [],
  invariants: [],
  success: { id: "done", statement: "it is done" },
} as unknown as OperationContract;

function makeReq(mode: ExecutionRequest["mode"]): ExecutionRequest {
  return {
    operation: "TEST_WRITE",
    params: { a: 1 },
    context: { tenantId: "t1", conversationId: "c1" } as any,
    mode,
  };
}

function bind(gateCalls: Array<{ probe?: boolean }>, executed: { n: number }, traces: ExecutionTrace[]) {
  return {
    verifiers: {},
    runSatisfier: async () => ({ ok: false as const, reason: "none" }),
    executeStrategy: async () => {
      executed.n++;
      return { ok: true as const, outcome: "wrote" };
    },
    approvalGate: async (_c: OperationContract, _r: ExecutionRequest, opts?: { probe?: boolean }) => {
      gateCalls.push({ probe: opts?.probe });
      return { required: true as const, ref: opts?.probe ? "dry_run_probe" : "real_ref" };
    },
    emitTrace: (t: ExecutionTrace) => traces.push(t),
  };
}

describe("resolver mode semantics", () => {
  it("advisory: RECOMMENDED, gate never consulted, nothing executed", async () => {
    const gateCalls: Array<{ probe?: boolean }> = [];
    const executed = { n: 0 };
    const traces: ExecutionTrace[] = [];
    const result = await resolveExecution(WRITE_CONTRACT, makeReq("advisory"), bind(gateCalls, executed, traces) as any);
    expect(result.status).toBe("RECOMMENDED");
    expect(gateCalls.length).toBe(0);
    expect(executed.n).toBe(0);
    expect(traces[0]?.approvalProbe).toBeUndefined();
  });

  it("dry_run: RECOMMENDED, gate probed (probe:true), trace records wouldRequire, nothing executed", async () => {
    const gateCalls: Array<{ probe?: boolean }> = [];
    const executed = { n: 0 };
    const traces: ExecutionTrace[] = [];
    const result = await resolveExecution(WRITE_CONTRACT, makeReq("dry_run"), bind(gateCalls, executed, traces) as any);
    expect(result.status).toBe("RECOMMENDED");
    expect(gateCalls).toEqual([{ probe: true }]);
    expect(executed.n).toBe(0);
    expect(traces[0]?.approvalProbe).toEqual({ wouldRequire: true });
  });

  it("autonomous: gate consulted for real (no probe flag) and blocks on required", async () => {
    const gateCalls: Array<{ probe?: boolean }> = [];
    const executed = { n: 0 };
    const traces: ExecutionTrace[] = [];
    const result = await resolveExecution(WRITE_CONTRACT, makeReq("autonomous"), bind(gateCalls, executed, traces) as any);
    expect(result.status).toBe("AWAITING_APPROVAL");
    expect(gateCalls).toEqual([{ probe: undefined }]);
    expect(executed.n).toBe(0);
  });
});
