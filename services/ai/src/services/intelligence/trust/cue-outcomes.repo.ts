import { prisma } from "@chatcenter/shared";

/**
 * Repository for CopilotCueOutcome rows - the durable backing of the trust
 * loop. The aggregate (per cueKind, cueText) is read by TrustWeights to
 * compute Laplace-smoothed accept rates. Insert is best-effort: a hiccup
 * recording feedback must NOT break the live call.
 */

export type CueOutcomeKind = "accepted" | "rejected" | "ignored";

export interface CueOutcomeRecord {
  tenantId: string;
  conversationId: string;
  cueId: string;
  cueKind: string;
  cueText: string;
  dedupKey: string;
  outcome: CueOutcomeKind;
}

export interface CueAggregate {
  cueKind: string;
  cueText: string;
  accepts: number;
  rejects: number;
  ignores: number;
}

export async function recordOutcome(rec: CueOutcomeRecord): Promise<void> {
  try {
    await (prisma as any).copilotCueOutcome.create({
      data: {
        tenantId: rec.tenantId,
        conversationId: rec.conversationId,
        cueId: rec.cueId,
        cueKind: rec.cueKind,
        cueText: rec.cueText,
        dedupKey: rec.dedupKey,
        outcome: rec.outcome,
      },
    });
  } catch (err: any) {
    // Trust feedback is value-add, not load-bearing. Log and continue.
    // eslint-disable-next-line no-console
    console.warn("[cue-outcomes] recordOutcome failed:", err?.message);
  }
}

export async function aggregateAll(): Promise<CueAggregate[]> {
  try {
    // Raw SQL because Prisma's groupBy with COUNT(CASE WHEN ...) is awkward
    // and slower than a single aggregate scan. Read-only; safe under load.
    const rows = (await (prisma as any).$queryRawUnsafe(
      `SELECT cue_kind AS "cueKind",
              cue_text AS "cueText",
              SUM(CASE WHEN outcome='accepted' THEN 1 ELSE 0 END)::int AS accepts,
              SUM(CASE WHEN outcome='rejected' THEN 1 ELSE 0 END)::int AS rejects,
              SUM(CASE WHEN outcome='ignored'  THEN 1 ELSE 0 END)::int AS ignores
         FROM copilot_cue_outcomes
        GROUP BY cue_kind, cue_text`,
    )) as CueAggregate[] | null;
    return rows ?? [];
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.warn("[cue-outcomes] aggregateAll failed:", err?.message);
    return [];
  }
}
