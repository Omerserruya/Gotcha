/**
 * Action-honesty validator - the deterministic block on "I'm searching now /
 * here are the options / I sent it / I'll get back to you" when nothing
 * actually executed. Phrases are the real ones from the 2026-07-21 incident
 * (conv cmrui5rr30001a9y6xk4rhd3h), where 14 turns made these claims with
 * ZERO tool calls.
 */
import { describe, it, expect } from "vitest";
import {
  detectActionClaims,
  turnHasExecutionEvidence,
  validateActionHonesty,
} from "../services/action-honesty.service";

const EXECUTED = [{ tool: "shopify.search_products", decision: "executed", sideEffect: undefined }];
const NO_TOOLS: any[] = [];
const ONLY_MARKERS = [{ tool: "__redundant_info__", decision: "already_provided" }];

describe("detectActionClaims (Hebrew incident phrases)", () => {
  it("flags in-progress, results, sent and follow-up claims", () => {
    expect(detectActionClaims("אני בודקת עכשיו ומחזירה תוך רגע")[0].kind).toBe("in_progress");
    expect(detectActionClaims("הנה 3 אופציות שמתאימות").some((c) => c.kind === "results")).toBe(true);
    expect(detectActionClaims("שלחתי לך קבלה").some((c) => c.kind === "sent")).toBe(true);
    expect(detectActionClaims("אחזור אליך תוך דקה").some((c) => c.kind === "followup")).toBe(true);
    expect(detectActionClaims("checking now, I'll get back to you").map((c) => c.kind).sort())
      .toEqual(["followup", "in_progress"]);
  });

  it("does not flag an honest question or a plain answer", () => {
    expect(detectActionClaims("מה התקציב שלך?")).toEqual([]);
    expect(detectActionClaims("הלוח מתאים לגובה שלך.")).toEqual([]);
  });
});

describe("turnHasExecutionEvidence", () => {
  it("true only for a real executed tool", () => {
    expect(turnHasExecutionEvidence(EXECUTED)).toBe(true);
    expect(turnHasExecutionEvidence(NO_TOOLS)).toBe(false);
    expect(turnHasExecutionEvidence(ONLY_MARKERS)).toBe(false);
    expect(turnHasExecutionEvidence([{ tool: "shopify.cancel_order", decision: "executed", sideEffect: "awaiting_approval" }])).toBe(false);
  });
});

describe("validateActionHonesty (the incident)", () => {
  it("BLOCKS 'אני בודקת עכשיו... הנה 3 אופציות' when no tool ran (tests 16/26/27)", () => {
    const v = validateActionHonesty("אני בודקת עכשיו ומחזירה תוך רגע עם 3 אופציות", NO_TOOLS);
    expect(v.ok).toBe(false);
    expect(v.unsupported.map((c) => c.kind)).toContain("in_progress");
  });

  it("BLOCKS a results claim with no provider call", () => {
    expect(validateActionHonesty("הנה 3 אופציות שמצאתי לך", NO_TOOLS).ok).toBe(false);
  });

  it("ALLOWS a results claim once a product search actually executed", () => {
    expect(validateActionHonesty("הנה 3 אופציות שמצאתי לך", EXECUTED).ok).toBe(true);
  });

  it("ALWAYS blocks a 'I'll get back to you' promise - the bot has no async job (test 17)", () => {
    expect(validateActionHonesty("אחזור אליך תוך דקה עם קישורים", EXECUTED).ok).toBe(false);
    // …unless a real background job was created
    expect(validateActionHonesty("אחזור אליך תוך דקה", EXECUTED, { hasBackgroundJob: true }).ok).toBe(true);
  });

  it("BLOCKS a false 'I sent it' with no email tool execution", () => {
    expect(validateActionHonesty("שלחתי לך את הקבלה", NO_TOOLS).ok).toBe(false);
  });
});
