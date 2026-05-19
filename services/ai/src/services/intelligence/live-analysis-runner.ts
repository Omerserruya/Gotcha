import {
  ConversationStateFrameSchema,
  type ConversationStateFrame,
  type TranscriptUtterance,
  type CopilotConfig,
} from "@chatcenter/shared";
import { randomUUID } from "crypto";
import { generateResponse } from "../ai.service";
import { getActionOrchestrator } from "../orchestrator";
import { ConversationMemory } from "./memory";
import { LiveCadence, type AnalysisCadence } from "./cadence";
import { LivePromptAssembler } from "./prompts";
import type { TranscriptSource } from "./sources";
import { CallAnalysisStore } from "./persistence/call-analysis-store";
import { publishConvEvent } from "./events";
import { cueProjector } from "./cue-projector";
import { detectSpellingMode } from "./analyzers/spelling-detector";

/**
 * Live Call Copilot's main-turn runner.
 *
 * Consumes a TranscriptSource (always LiveStreamingSource in Phase 3),
 * appends utterances to ConversationMemory, fires the LLM at LiveCadence
 * intervals, validates the structured output, persists it, and fans out
 * granular events.
 *
 * Phase 3 ships ONE LLM call per turn (the unified frame). The Tier B
 * rolling-summary side call is wired but disabled by default; it can be
 * enabled once the prompt cost vs benefit is measured in production.
 *
 * NOT YET INVOKED FROM voice-assist.service.ts in Phase 3 — the runner is
 * triggered by a parallel hook so the existing chat-shaped path keeps
 * running for backward compatibility. Phase 4 will switch the live path
 * over and delete the old call site.
 */

export interface LiveRunnerOptions {
  tenantId: string;
  conversationId: string;
  callSid: string;
  agentId?: string;
  /** Bias intent / coaching toward this stage if known. */
  playbookStageId?: string;
  /** Cap utterances fed into Tier A window per turn. Default 32. */
  tierAWindow?: number;
  /** Max LLM output tokens. Default 700. */
  maxOutputTokens?: number;
  /** Override the cadence policy (test injection point). */
  cadence?: AnalysisCadence;
  /**
   * Per-channel copilot config (language / goals / required questions /
   * data fields / persona). Resolved once at supervisor spawn-time so the
   * runner doesn't re-fetch on every turn.
   */
  copilotConfig?: CopilotConfig;
}

export class LiveAnalysisRunner {
  private memory: ConversationMemory | null = null;
  private readonly cadence: AnalysisCadence;
  private readonly assembler = new LivePromptAssembler();
  private version = 0;
  private running = false;
  private endedReason: string | null = null;

  constructor(
    private readonly source: TranscriptSource,
    private readonly opts: LiveRunnerOptions,
  ) {
    this.cadence = opts.cadence ?? new LiveCadence();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    console.log(
      `[live-runner] start conv=${this.opts.conversationId} tenant=${this.opts.tenantId} callSid=${this.opts.callSid ?? "-"}`,
    );

    await CallAnalysisStore.ensure({
      tenantId: this.opts.tenantId,
      conversationId: this.opts.conversationId,
      callSid: this.opts.callSid,
      mode: "live",
    });

    this.memory = await ConversationMemory.load(this.opts.conversationId, {
      tierAMax: this.opts.tierAWindow ?? 32,
    });

    // Run in the background; the caller does not await stream consumption.
    this.consume().catch((err: any) => {
      console.warn(
        "[live-runner] consume() crashed:",
        err?.message,
      );
    });
  }

  async stop(reason = "normal"): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.endedReason = reason;
    try {
      await this.source.close();
    } catch {
      /* ignore */
    }
    if (this.memory) {
      await this.memory.flush();
    }
    await CallAnalysisStore.complete(this.opts.conversationId);
    // Clear per-call projector state (lastSurfaceAt, dedup map, suppressed set,
    // observed-filled set) so a stale entry can't bleed into the next call
    // that happens to share the conversationId.
    cueProjector.endCall(this.opts.conversationId);
  }

  // ── Internal ───────────────────────────────────────────────

  private async consume(): Promise<void> {
    if (!this.memory) return;
    for await (const utt of this.source.stream()) {
      if (!this.running) break;
      this.memory.append(utt);
      // Forward the utterance event on the conversation channel so the UI
      // can render the live transcript without depending on the legacy
      // voice.transcript event shape. Phase 3 emits BOTH (legacy continues
      // to fire from the voice-copilot StreamRouter).
      await publishConvEvent(
        { kind: "conversation", id: this.opts.conversationId },
        "transcript.delta",
        {
          tenantId: this.opts.tenantId,
          conversationId: this.opts.conversationId,
          utterance: utt,
          ts: new Date().toISOString(),
        },
      ).catch(() => {});

      if (!this.cadence.shouldFire(this.memory, utt)) continue;
      await this.runTurn();
    }
    if (this.endedReason === null) {
      await this.stop("source_ended");
    }
  }

  private async runTurn(): Promise<void> {
    if (!this.memory) return;

    const messages = this.assembler.build({
      rollingSummary: this.memory.tierB(),
      recentUtterances: this.memory.tierAWindow(),
      copilotConfig: this.opts.copilotConfig,
    });

    const t0 = Date.now();
    let raw: string | null = null;
    // Kick off the spelling/code-switch detector in parallel with the main
    // LLM call. The detector returns null when its cheap pre-filter sees
    // no triggers in the recent window, so the cost stays bounded.
    const spellingPromise = detectSpellingMode({
      tenantId: this.opts.tenantId,
      conversationId: this.opts.conversationId,
      recentUtterances: this.memory.tierAWindow(),
    }).catch(() => null);
    try {
      console.log(
        `[live-runner] LLM call begin conv=${this.opts.conversationId} v${this.version + 1} msgs=${messages.length}`,
      );
      const res = await generateResponse({
        tenantId: this.opts.tenantId,
        messages,
        responseFormat: { type: "json_object" },
        maxTokens: this.opts.maxOutputTokens ?? 700,
        metadata: {
          conversationId: this.opts.conversationId,
          type: "voice_copilot_frame",
        },
      });
      raw = res.content;
      console.log(
        `[live-runner] LLM call ok conv=${this.opts.conversationId} ms=${Date.now() - t0} chars=${raw?.length ?? 0}`,
      );
    } catch (err: any) {
      console.warn(
        `[live-runner] generateResponse failed conv=${this.opts.conversationId} ms=${Date.now() - t0}:`,
        err?.message,
      );
      return;
    }

    const frame = parseFrame(raw, {
      conversationId: this.opts.conversationId,
      version: ++this.version,
    });
    if (!frame) {
      console.warn(
        `[live-runner] parseFrame returned null conv=${this.opts.conversationId} rawHead=${(raw ?? "").slice(0, 120)}`,
      );
      return;
    }

    // Merge spelling-detector output into the frame before persistence so
    // downstream consumers (cue projector + frame subscribers) see it as
    // part of the same versioned frame.
    const spellingHints = await spellingPromise;
    if (spellingHints && spellingHints.spellingMode) {
      frame.spellingHints = spellingHints;
    }

    // Persist to durable mirror (frames JSONB), then fan out events.
    await CallAnalysisStore.appendFrame(this.opts.conversationId, frame);
    await this.fanOut(frame);
    await this.memory.flush();
  }

  private async fanOut(frame: ConversationStateFrame): Promise<void> {
    const convTarget = {
      kind: "conversation" as const,
      id: this.opts.conversationId,
    };
    const agentTarget = this.opts.agentId
      ? { kind: "agent" as const, userId: this.opts.agentId }
      : convTarget;
    const base = {
      tenantId: this.opts.tenantId,
      conversationId: this.opts.conversationId,
      mode: frame.mode,
      version: frame.version,
      ts: frame.ts,
    };

    // The full frame is the canonical event — frontend uses this for the
    // version-reducer pattern that eliminates the partial-reconciliation
    // race in VoiceCallContext.
    console.log(
      `[live-runner] publishing frame v${frame.version} conv=${this.opts.conversationId} intent=${frame.intent?.primary ?? "-"} suggestions=${frame.suggestedActions.length}`,
    );
    await publishConvEvent(convTarget, "voice.frame.updated", {
      ...base,
      frame,
    }).catch(() => {});

    // Granular events for systems that care about specific fields. All on
    // either conversation-room or agent-only — never tenant broadcast.
    if (frame.intent)
      await publishConvEvent(convTarget, "intent.updated", {
        ...base,
        intent: frame.intent,
      }).catch(() => {});

    if (frame.stage)
      await publishConvEvent(convTarget, "stage.changed", {
        ...base,
        stage: frame.stage,
      }).catch(() => {});

    if (frame.sentiment)
      await publishConvEvent(convTarget, "sentiment.updated", {
        ...base,
        sentiment: frame.sentiment,
      }).catch(() => {});

    if (frame.missingFields.length > 0)
      await publishConvEvent(agentTarget, "missing_fields.updated", {
        ...base,
        fields: frame.missingFields,
      }).catch(() => {});

    if (frame.risks.length > 0)
      await publishConvEvent(agentTarget, "risk.detected", {
        ...base,
        risks: frame.risks,
      }).catch(() => {});

    if (frame.suggestedActions.length > 0)
      await publishConvEvent(agentTarget, "coaching.hint", {
        ...base,
        suggestedActions: frame.suggestedActions,
      }).catch(() => {});

    // Granular event for the spelling/code-switch detector. Frontend uses
    // this to render "Confirm: omer@gmail.com" chips inline with the
    // current utterance, separate from the lane-routed copilot cues so
    // they're not deduped or rate-limited by the projector.
    if (frame.spellingHints && frame.spellingHints.normalizedEntities.length > 0)
      await publishConvEvent(agentTarget, "spelling.detected", {
        ...base,
        hints: frame.spellingHints,
      }).catch(() => {});

    // Projected, lane-routed, deduped, rate-limited cues. Frontend new-style
    // consumers subscribe to `copilot.cues.updated`; legacy listeners on
    // coaching.hint / missing_fields.updated / risk.detected (emitted above)
    // keep working unchanged.
    const cues = cueProjector.project(frame);
    if (cues.length > 0) {
      await publishConvEvent(agentTarget, "copilot.cues.updated", {
        ...base,
        cues,
      }).catch(() => {});
    }

    // Phase 4: every proposed tool goes through the ActionOrchestrator,
    // which persists a ToolExecutionRequest row, applies LiveCallToolPolicy,
    // and emits `tool.execution.proposed` per proposal. Live-mode mutating
    // tools always propose (never auto-execute) so the executor here is
    // a placeholder that's never invoked.
    if (frame.proposedTools.length > 0) {
      const orchestrator = getActionOrchestrator();
      for (const proposal of frame.proposedTools) {
        await orchestrator
          .submit(
            {
              id: randomUUID(),
              conversationId: this.opts.conversationId,
              tenantId: this.opts.tenantId,
              proposedBy: { mode: "live", system: "live-runner" },
              actor: { agentId: this.opts.agentId ?? "" },
              tool: proposal.tool,
              args: proposal.args,
              rationale: proposal.rationale,
              urgency: "medium",
            },
            async () => {
              // Live-mode mutating tools never auto-execute — the policy
              // gate routes everything through propose-and-await-approval.
              throw new Error(
                "live-runner: executor invoked unexpectedly (live mutating tools must propose)",
              );
            },
          )
          .catch((err: any) => {
            console.warn(
              "[liveRunner] orchestrator.submit failed:",
              err?.message,
            );
          });
      }
    }
  }
}

/**
 * Parse and validate the LLM's JSON output as a ConversationStateFrame.
 * Returns null on any parse / validation failure (logged) so the runner
 * can keep going.
 */
function parseFrame(
  raw: string | null,
  args: { conversationId: string; version: number },
): ConversationStateFrame | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err: any) {
    console.warn("[intelligence.liveRunner] frame JSON parse failed:", err?.message);
    return null;
  }
  // Inject runner-owned fields the model is told NOT to fill.
  const candidate = {
    ...(obj as Record<string, unknown>),
    conversationId: args.conversationId,
    mode: "live",
    version: args.version,
    ts: new Date().toISOString(),
  };
  // Normalize common LLM synonyms before strict enum validation. The model
  // sometimes emits "now"/"asap"/"urgent" for urgency despite the prompt
  // saying low|medium|high; one drop per call is enough to feel broken.
  normalizeUrgencyEnums(candidate);
  const result = ConversationStateFrameSchema.safeParse(candidate);
  if (!result.success) {
    console.warn(
      "[intelligence.liveRunner] frame validation failed:",
      result.error.issues.slice(0, 3),
    );
    return null;
  }
  return result.data;
}

/**
 * Best-effort coercion of common LLM synonyms onto the canonical urgency
 * enum (low|medium|high). Mutates `candidate` in place. Only touches values
 * the schema would otherwise reject — leaves valid ones alone.
 */
function normalizeUrgencyEnums(candidate: Record<string, unknown>): void {
  const map = (v: unknown): "low" | "medium" | "high" | unknown => {
    if (typeof v !== "string") return v;
    const k = v.toLowerCase().trim();
    if (k === "low" || k === "medium" || k === "high") return k;
    if (["now", "immediate", "immediately", "asap", "urgent", "critical"].includes(k)) return "high";
    if (["soon", "important", "elevated"].includes(k)) return "medium";
    if (["later", "minor", "trivial"].includes(k)) return "low";
    return v; // unknown — let the schema flag it
  };
  if (typeof candidate.urgency === "string") {
    candidate.urgency = map(candidate.urgency);
  }
  const sa = candidate.suggestedActions;
  if (Array.isArray(sa)) {
    for (const item of sa) {
      if (item && typeof item === "object" && "urgency" in (item as any)) {
        (item as any).urgency = map((item as any).urgency);
      }
    }
  }
  const risks = candidate.risks;
  if (Array.isArray(risks)) {
    for (const r of risks) {
      if (r && typeof r === "object" && "severity" in (r as any)) {
        (r as any).severity = map((r as any).severity);
      }
    }
  }
}
