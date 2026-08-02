import { describe, it, expect } from "vitest";
import {
  plannerMoveToDecision,
  compareDecisions,
  summarizeShadowBatch,
  SHADOW_EVAL_SCHEMA_VERSION,
  type PlannerMove,
  type ShadowEvalRecord,
} from "../agent/shadow-eval";
import { parseReasonerOutput } from "../agent/reasoner-provider";
import type { ReasonerDecision } from "../agent/cognition";

// ── plannerMoveToDecision: the ONE bridge from the temporary Planner vocabulary
//    into the permanent Reasoner decision vocabulary. ──────────────────────────
describe("plannerMoveToDecision", () => {
  it("maps act/propose → EXECUTE(operation)", () => {
    expect(plannerMoveToDecision({ kind: "act", operation: "BOOK_MEETING" })).toEqual({
      type: "EXECUTE",
      operation: "BOOK_MEETING",
      params: {},
    });
    expect(plannerMoveToDecision({ kind: "propose", operation: "CREATE_DEAL" })).toEqual({
      type: "EXECUTE",
      operation: "CREATE_DEAL",
      params: {},
    });
  });

  it("maps ask → REQUEST_INPUT(field), escalate → ESCALATE, none → CONVERSE", () => {
    expect(plannerMoveToDecision({ kind: "ask", field: "email" })).toEqual({
      type: "REQUEST_INPUT",
      needed: "email",
    });
    expect(plannerMoveToDecision({ kind: "escalate" })).toEqual({
      type: "ESCALATE",
      reason: "planner_escalate",
    });
    expect(plannerMoveToDecision({ kind: "none" })).toEqual({ type: "CONVERSE" });
  });

  it("never throws on a missing operation/field (empty string, not undefined)", () => {
    expect(plannerMoveToDecision({ kind: "act" } as PlannerMove)).toEqual({
      type: "EXECUTE",
      operation: "",
      params: {},
    });
  });
});

// ── compareDecisions: agreement is defined ONCE here. ────────────────────────
describe("compareDecisions", () => {
  const execA: ReasonerDecision = { type: "EXECUTE", operation: "BOOK_MEETING", params: {} };
  const execB: ReasonerDecision = { type: "EXECUTE", operation: "CANCEL_MEETING", params: {} };

  it("agrees when move type + operation match", () => {
    expect(compareDecisions(execA, { ...execA })).toEqual({
      agree: true,
      moveTypeMatch: true,
      detailMatch: true,
      axis: "none",
    });
  });

  it("diverges on operation when both EXECUTE but different op", () => {
    expect(compareDecisions(execA, execB)).toEqual({
      agree: false,
      moveTypeMatch: true,
      detailMatch: false,
      axis: "operation",
    });
  });

  it("diverges on move_type when discriminants differ", () => {
    const ask: ReasonerDecision = { type: "REQUEST_INPUT", needed: "email" };
    expect(compareDecisions(execA, ask)).toEqual({
      agree: false,
      moveTypeMatch: false,
      detailMatch: false,
      axis: "move_type",
    });
  });

  it("diverges on field when both REQUEST_INPUT but different needed", () => {
    expect(
      compareDecisions({ type: "REQUEST_INPUT", needed: "email" }, { type: "REQUEST_INPUT", needed: "phone" }),
    ).toEqual({ agree: false, moveTypeMatch: true, detailMatch: false, axis: "field" });
  });

  it("treats same-type CONVERSE / ESCALATE / WAIT as full agreement (reason not compared)", () => {
    expect(compareDecisions({ type: "CONVERSE" }, { type: "CONVERSE" }).agree).toBe(true);
    expect(
      compareDecisions({ type: "ESCALATE", reason: "a" }, { type: "ESCALATE", reason: "b" }).agree,
    ).toBe(true);
    expect(compareDecisions({ type: "WAIT" }, { type: "WAIT" }).agree).toBe(true);
  });
});

// ── summarizeShadowBatch: the pure rollup behind the dashboard. ──────────────
describe("summarizeShadowBatch", () => {
  const row = (agree: boolean, axis: ShadowEvalRecord["divergence"]["axis"]): ShadowEvalRecord =>
    ({
      schemaVersion: SHADOW_EVAL_SCHEMA_VERSION,
      createdAt: "2026-07-01T00:00:00.000Z",
      tenantId: "t",
      conversationId: "c",
      turnId: "turn",
      reasonerInput: {} as any,
      plannerDecision: { type: "CONVERSE" },
      reasonerDecision: { type: "CONVERSE" },
      divergence: { agree, moveTypeMatch: agree, detailMatch: agree, axis },
      provider: "openai",
      model: "gpt-5-mini",
      promptVersion: "reasoner-v0.1",
    }) as ShadowEvalRecord;

  it("computes agreement rate + per-axis buckets", () => {
    const s = summarizeShadowBatch([
      row(true, "none"),
      row(true, "none"),
      row(false, "operation"),
      row(false, "move_type"),
    ]);
    expect(s.total).toBe(4);
    expect(s.agreementRate).toBe(0.5);
    expect(s.byAxis).toEqual({ none: 2, move_type: 1, operation: 1, field: 0 });
  });

  it("empty batch is vacuously full agreement (no false alarms)", () => {
    expect(summarizeShadowBatch([]).agreementRate).toBe(1);
  });
});

// ── parseReasonerOutput: strict on the business decision, coercive on the rest. ─
describe("parseReasonerOutput", () => {
  it("fails closed on a missing/invalid decision (never guesses a move)", () => {
    expect(parseReasonerOutput(null).ok).toBe(false);
    expect(parseReasonerOutput({}).ok).toBe(false);
    expect(parseReasonerOutput({ decision: { type: "NONSENSE" } }).ok).toBe(false);
    // EXECUTE without an operation is not a decision.
    expect(parseReasonerOutput({ decision: { type: "EXECUTE" } }).ok).toBe(false);
  });

  it("accepts a valid EXECUTE and coerces missing read/reply/memory to safe shapes", () => {
    const res = parseReasonerOutput({ decision: { type: "EXECUTE", operation: "BOOK_MEETING" } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.output.decision).toEqual({ type: "EXECUTE", operation: "BOOK_MEETING", params: {} });
    expect(res.output.read.missingInformation).toEqual([]);
    expect(res.output.replyIntent.keyPoints).toEqual([]);
    expect(Array.isArray(res.output.memoryUpdate.workingHypotheses)).toBe(true);
  });

  it("coerces a well-formed but loosely-typed output without dropping the decision", () => {
    const res = parseReasonerOutput({
      read: { situation: "s", goal: "BOOK_MEETING", missingInformation: [{ what: "email", why: "to invite", source: "customer" }] },
      decision: { type: "REQUEST_INPUT", needed: "email" },
      replyIntent: { purpose: "ask", keyPoints: ["one", 2, "three"] },
      memoryUpdate: { workingHypotheses: ["h1"], priorReads: [{ turn: 1, situation: "x" }] },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.output.decision).toEqual({ type: "REQUEST_INPUT", needed: "email" });
    // non-string keyPoints filtered out, not throwing.
    expect(res.output.replyIntent.keyPoints).toEqual(["one", "three"]);
    expect(res.output.read.missingInformation[0]).toEqual({ what: "email", why: "to invite", source: "customer" });
  });
});
