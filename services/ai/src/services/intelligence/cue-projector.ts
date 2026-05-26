import type { ConversationStateFrame } from "@chatcenter/shared";
import {
  FIELD_PROMPTS,
  goalSchemas,
  type Goal,
  type LeadField,
  type LeadStateView,
} from "./goal-schemas";
import { goalStateMachine } from "./goal-state-machine";
import { trustWeights } from "./trust/trust-weights.service";
import type { CueOutcomeKind } from "./trust/cue-outcomes.repo";

/**
 * Cue Projector — turns the LLM's ConversationStateFrame into the cues the
 * rep actually sees.
 *
 * Responsibilities (deterministic, in order):
 *   1. Synthesize candidate cues from:
 *      - frame.missingFields    (LLM-observed gaps)
 *      - goalSchemas[currentGoal] (system-required next-step prompts —
 *        adds cues the LLM forgot; this is the gap-1 fix)
 *      - frame.suggestedActions (coaching nudges)
 *      - frame.risks            (compliance / churn signals)
 *   2. Map urgency → lane (pulse/direction/strategy)
 *   3. Apply trust weight: rawScore × weightFor(cueKind, cueText)
 *   4. Drop below lane threshold
 *   5. Dedup by (cueKind, dedupKey) — second cue is suppressed while the
 *      first is still live (TTL not expired AND not yet outcome-released)
 *   6. Rate-limit: ≥4s between surfaces per call, ≤8/min per call
 *   7. Accepted/rejected cues are suppressed for the rest of the call
 *
 * Lives in-process. One ProjectedCue stream per call. State cleans up on
 * endCall(). The runner calls project() then publishes the resulting list
 * as `copilot.cues.updated`; the existing granular events keep firing
 * unchanged for backward compatibility.
 */

export type CueLane = "pulse" | "direction" | "strategy";
export type CueKind = "missing_field" | "suggested_action" | "risk";

export interface ProjectedCue {
  id: string;
  conversationId: string;
  kind: CueKind;
  lane: CueLane;
  text: string;
  rationale: string;
  score: number;       // post trust-weight
  rawScore: number;    // pre trust-weight (for analytics)
  dedupKey: string;
  goal: Goal;
  expiresAt: string;   // ISO
  sourceFrameVersion: number;
}

const LANE_THRESHOLD: Record<CueLane, number> = {
  pulse: 0.70,
  direction: 0.50,
  strategy: 0.30,
};
const MIN_INTERVAL_MS = 4_000;
const MAX_PER_MIN = 8;
const DEFAULT_TTL_MS = 60_000;

function urgencyToLane(u: "low" | "medium" | "high"): CueLane {
  return u === "high" ? "pulse" : u === "medium" ? "direction" : "strategy";
}

function urgencyToBase(u: "low" | "medium" | "high"): number {
  return u === "high" ? 0.85 : u === "medium" ? 0.65 : 0.40;
}

interface CallProjectorState {
  lastSurfaceAt: number;
  surfacesInWindow: number[];                  // ms timestamps of last surfaces
  liveByDedup: Map<string, ProjectedCue>;      // active (TTL not expired) dedup map
  suppressedForCall: Set<string>;              // dedupKeys accepted or rejected this call
  observedFilled: Set<LeadField>;              // fields known answered — see absorbFrame
  /**
   * Fields the LLM has emitted as required=true at some point in the call.
   * Tracked separately so we can apply the "previously asked, now silent =
   * answered" heuristic: if a field appears in this set but is ABSENT from
   * the current frame's missingFields, the LLM has stopped asking → mark
   * as filled. Without this, the projector would only ever mark a field
   * filled if the LLM explicitly emits it with required=false, which is
   * rare in practice.
   */
  previouslyRequired: Set<LeadField>;
}

export class CueProjector {
  private readonly state = new Map<string, CallProjectorState>();

  /**
   * Project a frame into surface-ready cues. Returns ONLY cues that pass
   * every gate. Caller is responsible for publishing the result and
   * persisting cue rows if desired.
   */
  project(frame: ConversationStateFrame): ProjectedCue[] {
    const st = this.stateFor(frame.conversationId);
    this.absorbFrame(frame, st);

    const leadView = this.leadViewOf(st);
    const goal = goalStateMachine.advance(frame.conversationId, leadView);

    // Sort by score desc so when the rate-limit only allows one cue per
    // turn, it goes to the most important one — not whichever happened to
    // be first in the candidates array.
    const candidates = this.candidates(frame, goal, leadView)
      .sort((a, b) => b.score - a.score);
    const surfaced: ProjectedCue[] = [];
    for (const c of candidates) {
      if (this.shouldSurface(c, st)) {
        this.markSurfaced(c, st);
        surfaced.push(c);
      }
    }
    return surfaced;
  }

  /**
   * Called by /api/copilot/cue-outcome when the rep acts on a cue.
   *   - accepted / rejected → suppress for the rest of the call
   *   - ignored             → remove from live dedup; cue may resurface
   *                           if its weight is still above threshold
   */
  release(conversationId: string, dedupKey: string, outcome: CueOutcomeKind): void {
    const st = this.state.get(conversationId);
    if (!st) return;
    st.liveByDedup.delete(dedupKey);
    if (outcome === "accepted" || outcome === "rejected") {
      st.suppressedForCall.add(dedupKey);
    }
  }

  endCall(conversationId: string): void {
    this.state.delete(conversationId);
    goalStateMachine.reset(conversationId);
  }

  /**
   * Returns the set of LeadFields the projector currently considers filled
   * for this call. Used by the live runner to render an "ALREADY ANSWERED
   * — DO NOT RE-ASK" block into the next prompt so the LLM stops
   * re-emitting missingFields for things the rep has already heard.
   */
  getObservedFilled(conversationId: string): LeadField[] {
    const st = this.state.get(conversationId);
    if (!st) return [];
    return [...st.observedFilled];
  }

  /** Test-only — inspect internal state without exposing the Map. */
  _stateForTest(conversationId: string): CallProjectorState | undefined {
    return this.state.get(conversationId);
  }

  // ─── internals ─────────────────────────────────────────────

  private stateFor(conversationId: string): CallProjectorState {
    let st = this.state.get(conversationId);
    if (!st) {
      st = {
        lastSurfaceAt: 0,
        surfacesInWindow: [],
        liveByDedup: new Map(),
        suppressedForCall: new Set(),
        observedFilled: new Set(),
        previouslyRequired: new Set(),
      };
      this.state.set(conversationId, st);
    }
    return st;
  }

  /**
   * Update the per-call "filled fields" tracker from this frame.
   *
   * Three signals are folded in (in increasing strength):
   *
   *  1. Field emitted with `required: false` → filled (explicit; the LLM is
   *     saying "this is no longer missing"). Weakest signal because the LLM
   *     rarely emits filled fields explicitly.
   *
   *  2. Field WAS previously emitted with `required: true` but is ABSENT
   *     from THIS frame's missingFields → filled (the LLM had been asking
   *     about it, then stopped — the practical interpretation is that the
   *     customer answered). This is the heuristic that fixes the "bot
   *     re-asks the same question two turns later" bug.
   *
   *  3. (future) frame.crmPatch entries → filled. Not in the schema yet,
   *     but when added, will be the strongest signal.
   *
   * Result accumulates into st.observedFilled for the lifetime of the
   * call. Cleared in endCall().
   */
  private absorbFrame(frame: ConversationStateFrame, st: CallProjectorState): void {
    const currentByField = new Map(frame.missingFields.map((m) => [m.field, m] as const));

    // Signal 1: explicit "required=false" → filled.
    for (const m of frame.missingFields) {
      if (!m.required) st.observedFilled.add(m.field as LeadField);
    }

    // Signal 2: previously seen as required but now silent → filled.
    for (const f of st.previouslyRequired) {
      if (!currentByField.has(f)) st.observedFilled.add(f);
    }

    // Update previouslyRequired AFTER the silence check so we never compare
    // a field against itself within the same frame.
    for (const m of frame.missingFields) {
      if (m.required) st.previouslyRequired.add(m.field as LeadField);
    }
  }

  private leadViewOf(st: CallProjectorState): LeadStateView {
    const view: LeadStateView = {};
    for (const f of st.observedFilled) {
      // Value is a sentinel; downstream only checks presence/absence.
      (view as Record<string, string>)[f] = "_seen_";
    }
    return view;
  }

  private candidates(
    frame: ConversationStateFrame,
    goal: Goal,
    lead: LeadStateView,
  ): ProjectedCue[] {
    const out: ProjectedCue[] = [];
    const emitted = new Set<string>();

    // 1. LLM-observed missing fields (authoritative for cue urgency)
    for (const mf of frame.missingFields) {
      if (!mf.required) continue;
      const dedupKey = `missing_field:${mf.field}`;
      emitted.add(dedupKey);
      const text = mf.suggestedQuestion
        ?? FIELD_PROMPTS[mf.field as LeadField]?.text
        ?? `ask about ${mf.field}`;
      const rationale = FIELD_PROMPTS[mf.field as LeadField]?.rationale
        ?? `${mf.field} not captured`;
      out.push(
        this.buildCue({
          frame,
          kind: "missing_field",
          dedupKey,
          text,
          rationale,
          rawScore: 0.70,
          urgency: "medium",
          goal,
        }),
      );
    }

    // 2. Goal-schema fields the LLM forgot (gap-1 fix). Lower base score
    //    so the LLM's calls take priority when both fire.
    for (const f of goalSchemas[goal]) {
      if (lead[f]) continue;
      const dedupKey = `missing_field:${f}`;
      if (emitted.has(dedupKey)) continue;
      const prompt = FIELD_PROMPTS[f];
      out.push(
        this.buildCue({
          frame,
          kind: "missing_field",
          dedupKey,
          text: prompt.text,
          rationale: prompt.rationale,
          rawScore: 0.50,
          urgency: "low",
          goal,
        }),
      );
    }

    // 3. Coaching suggestions
    for (const sa of frame.suggestedActions) {
      out.push(
        this.buildCue({
          frame,
          kind: "suggested_action",
          dedupKey: `suggested_action:${sa.text}`,
          text: sa.text,
          rationale: sa.rationale,
          rawScore: urgencyToBase(sa.urgency),
          urgency: sa.urgency,
          goal,
        }),
      );
    }

    // 4. Risks
    for (const r of frame.risks) {
      out.push(
        this.buildCue({
          frame,
          kind: "risk",
          dedupKey: `risk:${r.kind}`,
          text: `risk: ${r.kind}`,
          rationale: `${r.severity} severity`,
          rawScore: urgencyToBase(r.severity),
          urgency: r.severity,
          goal,
        }),
      );
    }

    return out;
  }

  private buildCue(args: {
    frame: ConversationStateFrame;
    kind: CueKind;
    dedupKey: string;
    text: string;
    rationale: string;
    rawScore: number;
    urgency: "low" | "medium" | "high";
    goal: Goal;
  }): ProjectedCue {
    const lane = urgencyToLane(args.urgency);
    // Trust factor maps Laplace weight 0..1 → multiplier 0.5..1.5, capped
    // at 1.0 final score. Unknown cue (weight=0.5) → multiplier 1.0 → no
    // dampening, so a brand-new high-urgency cue can still clear the pulse
    // gate. Rejected cues (weight→0) → ×0.5; consistently-accepted cues
    // (weight→1) → ×1.5 but cap prevents runaway.
    const weight = trustWeights.weightFor(args.kind, args.text);
    const multiplier = 0.5 + weight;
    const score = Math.min(1, args.rawScore * multiplier);
    return {
      id: `${args.frame.conversationId}:${args.dedupKey}:v${args.frame.version}`,
      conversationId: args.frame.conversationId,
      kind: args.kind,
      lane,
      text: args.text,
      rationale: args.rationale,
      score,
      rawScore: args.rawScore,
      dedupKey: args.dedupKey,
      goal: args.goal,
      expiresAt: new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
      sourceFrameVersion: args.frame.version,
    };
  }

  private shouldSurface(cue: ProjectedCue, st: CallProjectorState): boolean {
    if (st.suppressedForCall.has(cue.dedupKey)) return false;

    const existing = st.liveByDedup.get(cue.dedupKey);
    if (existing && new Date(existing.expiresAt).getTime() > Date.now()) return false;

    if (cue.score < LANE_THRESHOLD[cue.lane]) return false;

    const now = Date.now();
    if (now - st.lastSurfaceAt < MIN_INTERVAL_MS) return false;
    const window = st.surfacesInWindow.filter((t) => now - t < 60_000);
    if (window.length >= MAX_PER_MIN) return false;

    return true;
  }

  private markSurfaced(cue: ProjectedCue, st: CallProjectorState): void {
    st.liveByDedup.set(cue.dedupKey, cue);
    const now = Date.now();
    st.lastSurfaceAt = now;
    st.surfacesInWindow = st.surfacesInWindow.filter((t) => now - t < 60_000);
    st.surfacesInWindow.push(now);
  }
}

export const cueProjector = new CueProjector();
