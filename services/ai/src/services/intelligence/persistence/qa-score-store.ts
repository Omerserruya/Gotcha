import { prisma } from "@chatcenter/shared";

/**
 * Writes QAScore rows for Mode A QA analysis output.
 *
 * One row per (callAnalysisId, rubricVersion). If a rubric is rerun on the
 * same analysis (e.g. after a rubric upgrade), a new row is written rather
 * than updating in place - preserves audit history. Tenants reading "latest
 * QA score" for a conversation should ORDER BY scoredAt DESC.
 */

export interface QAScoreFinding {
  kind: "compliance_miss" | "coaching_opportunity" | "risk";
  refUtteranceIds: string[];
  note: string;
}

export interface QAScoreInput {
  callAnalysisId: string;
  conversationId: string;
  rubricVersion: string;
  playbookComplianceScore: number;
  coachingScore: number;
  riskScore: number;
  findings: QAScoreFinding[];
  refLiveFrameVersions: number[];
}

export class QAScoreStore {
  static async create(input: QAScoreInput): Promise<{ id: string } | null> {
    try {
      const row = await (prisma as any).qAScore.create({
        data: {
          callAnalysisId: input.callAnalysisId,
          conversationId: input.conversationId,
          rubricVersion: input.rubricVersion,
          playbookComplianceScore: input.playbookComplianceScore,
          coachingScore: input.coachingScore,
          riskScore: input.riskScore,
          findings: input.findings as unknown as object,
          refLiveFrameVersions: input.refLiveFrameVersions,
        },
        select: { id: true },
      });
      return { id: row.id };
    } catch (err: any) {
      console.warn("[intelligence.qaScore.create] failed:", err?.message);
      return null;
    }
  }
}
