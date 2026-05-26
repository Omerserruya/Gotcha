import { prisma } from "@chatcenter/shared";

/**
 * Stage transition audit writer.
 *
 * Single insertion point so the row shape stays consistent across all
 * three origins (AUTO from post-call, MANUAL from live workspace,
 * REVIEW_TASK when below confidence threshold).
 *
 * Failure mode: NEVER throws. Audit failures are logged but must not
 * block the actual stage transition. Post-call would already have
 * written the vendor patch by the time we get here.
 */

export type StageTransitionSource = "AUTO" | "MANUAL" | "REVIEW_TASK";

export interface RecordStageTransitionArgs {
  tenantId: string;
  conversationId: string;
  contactId?: string | null;
  funnelId: string;
  fromStageId?: string | null;
  fromStageLabel?: string | null;
  toStageId: string;
  toStageLabel?: string | null;
  source: StageTransitionSource;
  confidence?: number | null;
  reason?: string | null;
  evidence?: string[];
  criteriaMet?: string[];
  criteriaMissed?: string[];
  vendorValue?: string | null;
  vendorWriteOk?: boolean;
  vendorWriteError?: string | null;
  actorId?: string | null;
}

export async function recordStageTransition(
  args: RecordStageTransitionArgs,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const row = await (prisma as any).stageTransition.create({
      data: {
        tenantId: args.tenantId,
        conversationId: args.conversationId,
        contactId: args.contactId ?? null,
        funnelId: args.funnelId,
        fromStageId: args.fromStageId ?? null,
        fromStageLabel: args.fromStageLabel ?? null,
        toStageId: args.toStageId,
        toStageLabel: args.toStageLabel ?? null,
        source: args.source,
        confidence: args.confidence ?? null,
        reason: args.reason ?? null,
        evidence: args.evidence ?? [],
        criteriaMet: args.criteriaMet ?? [],
        criteriaMissed: args.criteriaMissed ?? [],
        vendorValue: args.vendorValue ?? null,
        vendorWriteOk: !!args.vendorWriteOk,
        vendorWriteError: args.vendorWriteError ?? null,
        actorId: args.actorId ?? null,
      },
      select: { id: true },
    });
    return { ok: true, id: row.id };
  } catch (err: any) {
    console.warn(
      "[stage-transition-audit] insert failed (non-fatal):",
      err?.message,
    );
    return { ok: false, error: err?.message };
  }
}

export interface ListStageTransitionsArgs {
  tenantId: string;
  conversationId?: string;
  contactId?: string;
  limit?: number;
}

export async function listStageTransitions(args: ListStageTransitionsArgs): Promise<
  Array<{
    id: string;
    conversationId: string;
    contactId: string | null;
    funnelId: string;
    fromStageId: string | null;
    fromStageLabel: string | null;
    toStageId: string;
    toStageLabel: string | null;
    source: string;
    confidence: number | null;
    reason: string | null;
    evidence: unknown;
    criteriaMet: unknown;
    criteriaMissed: unknown;
    vendorValue: string | null;
    vendorWriteOk: boolean;
    vendorWriteError: string | null;
    actorId: string | null;
    createdAt: string;
  }>
> {
  const where: Record<string, unknown> = { tenantId: args.tenantId };
  if (args.conversationId) where.conversationId = args.conversationId;
  if (args.contactId) where.contactId = args.contactId;
  try {
    const rows = await (prisma as any).stageTransition.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(args.limit ?? 50, 200),
    });
    return rows.map((r: any) => ({
      ...r,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    }));
  } catch (err: any) {
    console.warn(
      "[stage-transition-audit] list failed (non-fatal):",
      err?.message,
    );
    return [];
  }
}
