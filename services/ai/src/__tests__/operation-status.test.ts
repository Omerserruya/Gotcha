import { describe, it, expect, afterEach } from "vitest";
import {
  isOperationAutonomous,
  operationStatus,
  operationStatusSummary,
  agentKernelEligible,
} from "../services/agent-loop/operation-status";

describe("migration ledger + deterministic routing floor (TEMPORARY)", () => {
  const prev = process.env.AGENT_LOOP_AGENTS;
  afterEach(() => { if (prev === undefined) delete process.env.AGENT_LOOP_AGENTS; else process.env.AGENT_LOOP_AGENTS = prev; });

  it("the whole calendar operation set is autonomous (verified live 2026-07-02)", () => {
    expect(isOperationAutonomous("CHECK_AVAILABILITY")).toBe(true);
    expect(isOperationAutonomous("BOOK_MEETING")).toBe(true);
    expect(isOperationAutonomous("MOVE_MEETING")).toBe(true);
    expect(isOperationAutonomous("CANCEL_MEETING")).toBe(true);
  });

  it("operations the kernel has no capability for are 'unknown'", () => {
    expect(operationStatus("SEND_EMAIL")).toBe("unknown"); // no connector owns it yet
    expect(isOperationAutonomous("SEND_EMAIL")).toBe(false);
    // SEARCH_CUSTOMER / UPSERT_CUSTOMER now exist in the kernel but are shadow (not autonomous).
    expect(operationStatus("SEARCH_CUSTOMER")).toBe("shadow");
    expect(isOperationAutonomous("UPSERT_CUSTOMER")).toBe(false);
  });

  it("agentKernelEligible: no agent routes to the Kernel unless explicitly opted in", () => {
    delete process.env.AGENT_LOOP_AGENTS;
    expect(agentKernelEligible("agent-1")).toBe(false); // safe default: empty ⇒ none
    process.env.AGENT_LOOP_AGENTS = "";
    expect(agentKernelEligible("agent-1")).toBe(false);
    process.env.AGENT_LOOP_AGENTS = "agent-1, agent-2";
    expect(agentKernelEligible("agent-1")).toBe(true);
    expect(agentKernelEligible("agent-2")).toBe(true);
    expect(agentKernelEligible("agent-3")).toBe(false);
    // no wildcard support — "*" is a literal id, never "all"
    process.env.AGENT_LOOP_AGENTS = "*";
    expect(agentKernelEligible("agent-1")).toBe(false);
  });

  it("summary counts reflect the ledger", () => {
    const s = operationStatusSummary();
    expect(s.autonomous).toBeGreaterThanOrEqual(1);
    expect(s.operations).toBe(s.autonomous + s.shadow);
  });
});
