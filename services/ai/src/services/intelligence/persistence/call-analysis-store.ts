import { prisma, type ConversationStateFrame } from "@chatcenter/shared";

/**
 * Durable mirror for ConversationStateFrames.
 *
 * Phase 3 writes one CallAnalysis row per conversation when the runner
 * starts and appends frames as they're produced. Mode A (Phase 5) reads
 * from this store directly. Mode B (Phase 6) writes here too; the schema
 * is shared.
 *
 * Frames are appended via JSONB array concat (`frames || $1::jsonb`) at the
 * SQL level so concurrent appenders don't clobber each other. With one
 * runner per conversation in Phase 3, contention is unlikely, but the SQL
 * pattern future-proofs Mode A QA replay running alongside live mode.
 */
export class CallAnalysisStore {
  /**
   * Idempotent - creates the row if missing, otherwise no-op.
   * Call once per call when the runner spins up.
   */
  static async ensure(args: {
    tenantId: string;
    conversationId: string;
    callSid?: string;
    mode: "live" | "qa" | "async";
  }): Promise<void> {
    try {
      await (prisma as any).callAnalysis.upsert({
        where: { conversationId: args.conversationId },
        create: {
          tenantId: args.tenantId,
          conversationId: args.conversationId,
          callSid: args.callSid,
          mode: args.mode,
          status: "running",
          frames: [],
        },
        update: {},
      });
    } catch (err: any) {
      console.warn("[intelligence.callAnalysis.ensure] failed:", err?.message);
    }
  }

  /**
   * Append a frame to the JSONB array.
   * Phase 3 uses Prisma's raw SQL because concat-into-JSONB-array is not
   * expressible via the ORM update API.
   */
  static async appendFrame(
    conversationId: string,
    frame: ConversationStateFrame,
  ): Promise<void> {
    try {
      await (prisma as any).$executeRaw`
        UPDATE call_analyses
        SET frames = frames || ${JSON.stringify([frame])}::jsonb,
            rolling_summary = COALESCE(${frame.summary?.text ?? null}, rolling_summary)
        WHERE conversation_id = ${conversationId}
      `;
    } catch (err: any) {
      console.warn(
        "[intelligence.callAnalysis.appendFrame] failed:",
        err?.message,
      );
    }
  }

  /**
   * Mark the row completed. Called when the call ends.
   */
  static async complete(
    conversationId: string,
    finalSummary?: string,
  ): Promise<void> {
    try {
      await (prisma as any).callAnalysis.updateMany({
        where: { conversationId },
        data: {
          status: "completed",
          completedAt: new Date(),
          finalSummary: finalSummary ?? undefined,
        },
      });
    } catch (err: any) {
      console.warn("[intelligence.callAnalysis.complete] failed:", err?.message);
    }
  }
}
