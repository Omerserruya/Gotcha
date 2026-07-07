import { describe, it, expect } from "vitest";
import {
  decisionToControl,
  preReasonTermination,
  runtimeResultToTermination,
} from "../agent/loop";
import { DEFAULT_LOOP_POLICY, resolveLoopPolicy } from "../agent/loop-policy";
import { emptyWorkingMemory, mergeWorkingMemory } from "../agent/working-memory";
import { authorizeOperation } from "../agent/guardrails";
import { assembleFacts } from "../agent/oracle";
import type { Facts, CapabilityWorldView } from "../agent/facts";

// ── decisionToControl: EXECUTE is the ONLY continuing move. ──────────────────
describe("decisionToControl", () => {
  it("maps EXECUTE → propose (continue)", () => {
    expect(decisionToControl({ type: "EXECUTE", operation: "BOOK_MEETING", params: { t: 1 } })).toEqual({
      kind: "propose",
      operation: "BOOK_MEETING",
      params: { t: 1 },
    });
  });
  it("maps every non-EXECUTE decision to a terminal reason", () => {
    expect(decisionToControl({ type: "FINISH", reason: "done" })).toEqual({ kind: "terminate", reason: "finish" });
    expect(decisionToControl({ type: "REQUEST_INPUT", needed: "email" })).toEqual({ kind: "terminate", reason: "need_input" });
    expect(decisionToControl({ type: "ESCALATE", reason: "stuck" })).toEqual({ kind: "terminate", reason: "escalate" });
    expect(decisionToControl({ type: "CONVERSE" })).toEqual({ kind: "terminate", reason: "converse" });
    expect(decisionToControl({ type: "WAIT" })).toEqual({ kind: "terminate", reason: "converse" });
  });
});

// ── preReasonTermination: RESOURCE envelope only (no business judgment). ──────
describe("preReasonTermination", () => {
  const p = { maxIterations: 6, maxWallMs: 60_000, maxBudgetUnits: 1000 };
  it("returns null while within all resource bounds", () => {
    expect(preReasonTermination({ iteration: 3, elapsedMs: 1000, spentUnits: 100 }, p)).toBeNull();
  });
  it("fires each resource bound with correct precedence", () => {
    expect(preReasonTermination({ iteration: 7, elapsedMs: 0, spentUnits: 0 }, p)).toBe("max_iterations");
    expect(preReasonTermination({ iteration: 1, elapsedMs: 60_000, spentUnits: 0 }, p)).toBe("timeout");
    expect(preReasonTermination({ iteration: 1, elapsedMs: 0, spentUnits: 1000 }, p)).toBe("budget_exceeded");
  });
});

// ── runtimeResultToTermination: only genuine boundaries stop the loop. ────────
describe("runtimeResultToTermination", () => {
  it("stops ONLY on approval (async human) + unrecoverable failure", () => {
    expect(runtimeResultToTermination("AWAITING_APPROVAL", undefined)).toBe("awaiting_approval");
    expect(runtimeResultToTermination("FAILED", false)).toBe("failed");
  });
  it("re-enters on BLOCKED/denied (the Reasoner decides to give up, not the loop)", () => {
    expect(runtimeResultToTermination("BLOCKED", undefined)).toBeNull();
    expect(runtimeResultToTermination("FAILED", true)).toBeNull();
    expect(runtimeResultToTermination("EXECUTED", undefined)).toBeNull();
    expect(runtimeResultToTermination("NEEDS_INPUT", undefined)).toBeNull();
    expect(runtimeResultToTermination("RECOMMENDED", undefined)).toBeNull();
  });
});

// ── resolveLoopPolicy: capabilities TIGHTEN only. ────────────────────────────
describe("resolveLoopPolicy", () => {
  it("takes the min of base and every engaged capability's stated bound", () => {
    const eff = resolveLoopPolicy(DEFAULT_LOOP_POLICY, [{ maxIterations: 5 }, { maxIterations: 3, maxWallMs: 30_000 }]);
    expect(eff.maxIterations).toBe(3);
    expect(eff.maxWallMs).toBe(30_000);
  });
  it("a capability cannot LOOSEN a bound above the base", () => {
    const eff = resolveLoopPolicy({ ...DEFAULT_LOOP_POLICY, maxIterations: 4 }, [{ maxIterations: 999 }]);
    expect(eff.maxIterations).toBe(4);
  });
});

// ── guardrails: deterministic AUTHORIZE over Facts (money/security/permission). ─
describe("authorizeOperation (deterministic guardrails)", () => {
  const world: CapabilityWorldView[] = [
    { capability: "CALENDAR", summary: "connected", facts: {}, operations: [{ name: "BOOK_MEETING", meaning: "book", params: [] }] },
  ];
  const mk = (over: Partial<Parameters<typeof assembleFacts>[0]> = {}): Facts =>
    assembleFacts({
      customer: { knownFields: {}, identityResolved: false },
      billing: { status: "active", withinLimits: true },
      permissions: { allowedOperations: [] },
      world,
      now: "2026-07-01T00:00:00Z",
      ...over,
    });

  it("allows a permitted, available op on an active/in-budget tenant", () => {
    expect(authorizeOperation("BOOK_MEETING", mk())).toEqual({ allow: true });
  });
  it("hard-denies suspended billing (money is non-negotiable)", () => {
    expect(authorizeOperation("BOOK_MEETING", mk({ billing: { status: "suspended", withinLimits: true } })))
      .toEqual({ allow: false, reason: "billing_suspended" });
  });
  it("hard-denies an exhausted budget", () => {
    expect(authorizeOperation("BOOK_MEETING", mk({ billing: { status: "active", withinLimits: false } })))
      .toEqual({ allow: false, reason: "budget_exhausted" });
  });
  it("denies an op not on a non-empty permission allow-list", () => {
    expect(authorizeOperation("BOOK_MEETING", mk({ permissions: { allowedOperations: ["CHECK_AVAILABILITY"] } })))
      .toEqual({ allow: false, reason: "not_permitted" });
  });
  it("denies an invented / unavailable operation (subsumes off-menu)", () => {
    expect(authorizeOperation("LAUNCH_ROCKET", mk())).toEqual({ allow: false, reason: "capability_unavailable" });
  });
});

// ── menu derivation: union of world ops ∩ permissions, generic (no domains). ──
describe("assembleFacts menu derivation (capability-open)", () => {
  it("derives availableOperations from the world generically, deduped, ∩ permissions", () => {
    const f = assembleFacts({
      customer: { knownFields: {}, identityResolved: false },
      billing: { status: "active", withinLimits: true },
      permissions: { allowedOperations: [] },
      world: [
        { capability: "CALENDAR", summary: "", facts: {}, operations: [{ name: "BOOK_MEETING", meaning: "", params: [] }] },
        { capability: "CRM", summary: "", facts: {}, operations: [{ name: "CREATE_LEAD", meaning: "", params: [] }] },
      ],
      now: "t",
    });
    expect(f.availableOperations.map((o) => o.name).sort()).toEqual(["BOOK_MEETING", "CREATE_LEAD"]);
    expect(f.world.length).toBe(2); // kernel carries the world opaquely
  });
});

// ── working memory: bounded, dedup, ruled-out keyed by op, questions replace. ─
describe("mergeWorkingMemory", () => {
  it("accumulates established facts (deduped) and keys ruledOut by operation", () => {
    let wm = emptyWorkingMemory("booking");
    wm = mergeWorkingMemory(wm, { establishedFacts: ["booked"], ruledOut: [{ operation: "MOVE_MEETING", why: "no booking" }] });
    wm = mergeWorkingMemory(wm, { establishedFacts: ["booked", "invited"], ruledOut: [{ operation: "MOVE_MEETING", why: "still none" }] });
    expect(wm.establishedFacts).toEqual(["booked", "invited"]);
    expect(wm.ruledOut).toEqual([{ operation: "MOVE_MEETING", why: "still none" }]);
  });
  it("openQuestions REPLACE (they close as answered) and iterations append", () => {
    let wm = emptyWorkingMemory(null);
    wm = mergeWorkingMemory(wm, { openQuestions: ["email?", "time?"], iteration: { iteration: 1, decision: { type: "REQUEST_INPUT", needed: "email" } } });
    wm = mergeWorkingMemory(wm, { openQuestions: ["time?"], iteration: { iteration: 2, decision: { type: "EXECUTE", operation: "BOOK_MEETING", params: {} } } });
    expect(wm.openQuestions).toEqual(["time?"]);
    expect(wm.iterations.map((i) => i.iteration)).toEqual([1, 2]);
  });
});
