import { describe, it, expect, beforeEach } from "vitest";
import type { ConversationStateFrame } from "@chatcenter/shared";
import { CueProjector } from "../services/intelligence/cue-projector";
import { trustWeights } from "../services/intelligence/trust/trust-weights.service";
import { goalStateMachine } from "../services/intelligence/goal-state-machine";

/**
 * Pure unit tests - projector logic should not touch the DB. trustWeights
 * is seeded via the _setForTest hook so we don't hit Postgres.
 */

function frame(over: Partial<ConversationStateFrame> = {}): ConversationStateFrame {
  return {
    conversationId: over.conversationId ?? "c-1",
    mode: "live",
    version: over.version ?? 1,
    ts: new Date().toISOString(),
    intent: null,
    stage: null,
    summary: null,
    sentiment: null,
    missingFields: over.missingFields ?? [],
    suggestedActions: over.suggestedActions ?? [],
    proposedTools: [],
    risks: over.risks ?? [],
    urgency: "medium",
    confidence: 0.8,
  };
}

describe("CueProjector", () => {
  let p: CueProjector;

  beforeEach(() => {
    p = new CueProjector();
    trustWeights._resetForTest();
    goalStateMachine.reset("c-1");
  });

  it("emits a high-urgency suggested action as a pulse cue", () => {
    const cues = p.project(
      frame({
        suggestedActions: [{ text: "anchor on annual plan", rationale: "price talk", urgency: "high" }],
      }),
    );
    const sa = cues.find((c) => c.kind === "suggested_action");
    expect(sa?.lane).toBe("pulse");
  });

  it("dedups identical cues across frames within TTL", () => {
    const f1 = frame({
      suggestedActions: [{ text: "ask budget", rationale: "qual", urgency: "high" }],
    });
    const f2 = { ...f1, version: 2 };

    expect(p.project(f1)).toHaveLength(1);
    expect(p.project(f2)).toHaveLength(0); // suppressed by dedup
  });

  it("enforces min-interval between surfaces (no second cue within 4s)", () => {
    const a = frame({
      suggestedActions: [{ text: "ask budget", rationale: "x", urgency: "high" }],
    });
    const b = frame({
      version: 2,
      suggestedActions: [{ text: "ask team size", rationale: "x", urgency: "high" }],
    });
    expect(p.project(a)).toHaveLength(1);
    // No clock advance between calls → rate-limit must drop the second.
    expect(p.project(b)).toHaveLength(0);
  });

  it("suppresses accepted cues for the rest of the call", () => {
    const f1 = frame({
      suggestedActions: [{ text: "ask budget", rationale: "x", urgency: "high" }],
    });
    expect(p.project(f1).find((c) => c.text === "ask budget")).toBeDefined();

    p.release("c-1", "suggested_action:ask budget", "accepted");

    // Even after the live TTL would expire, an accepted cue stays suppressed.
    const f2 = { ...f1, version: 2 };
    const st = p._stateForTest("c-1")!;
    st.liveByDedup.clear();          // simulate TTL expiry
    st.lastSurfaceAt = 0;            // bypass rate-limit
    st.surfacesInWindow = [];
    expect(p.project(f2).find((c) => c.text === "ask budget")).toBeUndefined();
  });

  it("ignored cue can resurface after dedup clears", () => {
    const f1 = frame({
      suggestedActions: [{ text: "ask budget", rationale: "x", urgency: "high" }],
    });
    expect(p.project(f1)).toHaveLength(1);

    p.release("c-1", "suggested_action:ask budget", "ignored");

    const st = p._stateForTest("c-1")!;
    st.lastSurfaceAt = 0;
    st.surfacesInWindow = [];
    const f2 = { ...f1, version: 2 };
    expect(p.project(f2)).toHaveLength(1);
  });

  it("drops below-threshold cues when trust weight tanks them", () => {
    // Low urgency → strategy lane (threshold 0.30). Bad reputation
    // (weight 0) → multiplier 0.5 → 0.40 × 0.5 = 0.20 < 0.30 → drops.
    trustWeights._setForTest("suggested_action", "small talk", 0);
    const cues = p.project(
      frame({
        suggestedActions: [{ text: "small talk", rationale: "warmup", urgency: "low" }],
      }),
    );
    expect(cues.find((c) => c.text === "small talk")).toBeUndefined();
  });

  it("trust weight dampens cues reps reject", () => {
    trustWeights._setForTest("suggested_action", "ask budget", 0.1);
    // High urgency base = 0.85 × (0.5 + 0.1) = 0.51 < pulse threshold 0.70.
    // Other unrelated cues (goal-schema gap-fill) may still surface in the
    // same project() call - we only assert the dampened cue is dropped.
    const cues = p.project(
      frame({
        suggestedActions: [{ text: "ask budget", rationale: "x", urgency: "high" }],
      }),
    );
    expect(cues.find((c) => c.text === "ask budget")).toBeUndefined();
  });

  it("synthesizes a goal-schema missing-field cue when LLM forgot", () => {
    // No frame.missingFields; goal is lookup_lead → schema requires
    // fullName + email. Projector should fill the gap.
    const cues = p.project(frame({}));
    const fields = cues.filter((c) => c.kind === "missing_field").map((c) => c.dedupKey);
    expect(fields).toContain("missing_field:fullName");
  });

  it("endCall clears per-call state", () => {
    p.project(
      frame({
        suggestedActions: [{ text: "ask budget", rationale: "x", urgency: "high" }],
      }),
    );
    expect(p._stateForTest("c-1")).toBeDefined();
    p.endCall("c-1");
    expect(p._stateForTest("c-1")).toBeUndefined();
  });
});
