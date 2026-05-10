import type { ConversationStateFrame } from "@chatcenter/shared";
import type { AnalysisContext } from "./analyzers/types";
import type { TranscriptSource } from "./sources/transcript-source";
import { LiveAnalysisRunner } from "./live-analysis-runner";

/**
 * Generic transcript analysis entry point.
 *
 * Phase 3 lights up the live path: a TranscriptSource of mode "live" runs
 * through LiveAnalysisRunner and emits a stream of ConversationStateFrames
 * via the bus. The async iterable returned by this function is currently
 * a placeholder — Phase 3 callers do not iterate it, they `start` the
 * runner via the integration hook in voice-assist.service.ts.
 *
 * Phase 5 (Mode A QA) and Phase 6 (Mode B async) will branch on
 * `source.mode` and route to their own runners.
 */
export async function* runAnalysis(
  source: TranscriptSource,
  ctx: AnalysisContext & {
    /** Required for live mode — the call SID drives the LiveStreamingSource. */
    callSid?: string;
    agentId?: string;
    playbookStageId?: string;
  },
): AsyncIterable<ConversationStateFrame> {
  if (source.mode === "live") {
    if (!ctx.callSid) {
      throw new Error("runAnalysis(live): callSid is required");
    }
    const runner = new LiveAnalysisRunner(source, {
      tenantId: ctx.tenantId,
      conversationId: ctx.conversationId,
      callSid: ctx.callSid,
      agentId: ctx.agentId,
      playbookStageId: ctx.playbookStageId,
    });
    await runner.start();
    // Frames are emitted via the bus, not via this iterator. Returning
    // here keeps the function signature stable; Phase 5/6 may switch to
    // yielding frames directly when callers want pull-based consumption.
    return;
  }

  // QA / async modes ship in Phase 5/6.
  throw new Error(
    `runAnalysis: mode "${source.mode}" not yet implemented (Phase 5/6)`,
  );
  // eslint-disable-next-line no-unreachable
  yield undefined as unknown as ConversationStateFrame;
}
