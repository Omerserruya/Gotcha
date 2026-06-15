/**
 * Pipeline transition entry point for the AI Worker.
 *
 * Thin facade over `stage-transition-audit.service.ts:recordStageTransition`.
 * Exposes a worker-shaped API so the cutover (Phase 5) can swap call sites
 * without touching the audit writer.
 *
 * Behaviour contract:
 *   - Never throws. Audit failures are non-fatal - the vendor CRM patch
 *     would already be written by the time we get here.
 *   - Source is fixed to "AUTO" because the worker is the autonomous
 *     decision maker; MANUAL (rep override) and REVIEW_TASK (below
 *     confidence threshold) keep using the audit writer directly.
 */

import {
  recordStageTransition,
  type RecordStageTransitionArgs,
} from "../../services/stage-transition-audit.service";

export interface AdvancePipelineArgs {
  tenantId: string;
  conversationId: string;
  contactId?: string | null;
  funnelId: string;
  fromStageId?: string | null;
  fromStageLabel?: string | null;
  toStageId: string;
  toStageLabel?: string | null;
  confidence: number;
  reason: string;
  evidence?: string[];
  criteriaMet?: string[];
  criteriaMissed?: string[];
  vendorValue?: string | null;
  vendorWriteOk?: boolean;
  vendorWriteError?: string | null;
  /**
   * Stable session id (conversation/call). Recorded as actorId so the
   * audit trail can be cross-referenced with the OpenAI usage logs that
   * carry the same identifier.
   */
  sessionId: string;
}

export async function advancePipeline(
  args: AdvancePipelineArgs,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const auditArgs: RecordStageTransitionArgs = {
    tenantId: args.tenantId,
    conversationId: args.conversationId,
    contactId: args.contactId ?? null,
    funnelId: args.funnelId,
    fromStageId: args.fromStageId ?? null,
    fromStageLabel: args.fromStageLabel ?? null,
    toStageId: args.toStageId,
    toStageLabel: args.toStageLabel ?? null,
    source: "AUTO",
    confidence: args.confidence,
    reason: args.reason,
    evidence: args.evidence ?? [],
    criteriaMet: args.criteriaMet ?? [],
    criteriaMissed: args.criteriaMissed ?? [],
    vendorValue: args.vendorValue ?? null,
    vendorWriteOk: !!args.vendorWriteOk,
    vendorWriteError: args.vendorWriteError ?? null,
    actorId: `worker:${args.sessionId}`,
  };
  return recordStageTransition(auditArgs);
}
