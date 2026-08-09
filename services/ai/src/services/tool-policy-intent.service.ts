/**
 * What the operator actually decided, kept somewhere the connection cannot take
 * with it.
 *
 * An integration tool's live policy lives on `TenantTool` - `isEnabled` and
 * `configOverrides.hitlPolicy` - because that is where the execution gate reads
 * it. That row hangs off `TenantIntegration`, so it dies with the connection:
 * by cascade if the row is deleted, and (until this change) by an explicit
 * `deleteMany` on every disconnect.
 *
 * The consequence was a customer-visible policy reset. An operator disabled
 * `process_refund`, disconnected to re-grant OAuth scopes - the only way to
 * grant a scope - and reconnected. The tool came back enabled. Nothing had
 * overridden their decision; the record of it had been deleted, so provisioning
 * had nothing to preserve and used the catalogue default.
 *
 * `TenantToolPermission` is the fix and it already existed. It is keyed by
 * (tenantId, toolName) with no foreign key to any connection, the tool-gate
 * header already describes it as AUTHORITATIVE, and static tools have always
 * used it. Integration tools did not - `tool-permissions.ts` routed them to the
 * connection-scoped row instead, with a comment explaining that writing here
 * "would silently no-op against the gate". That was true of the GATE, and it is
 * why no durable record of intent was ever written.
 *
 * So both are written now, each for what it is good at:
 *
 *   TenantTool           - live policy the gate reads. Dies with the connection.
 *   TenantToolPermission - the operator's DECISION. Outlives it.
 *
 * On reconnect, provisioning consults the decision and recreates the row to
 * match it, instead of falling back to a catalogue default that nobody chose.
 *
 * A row here means "a human made an explicit choice about this tool". Absence
 * means nobody has, and a default is legitimate. That distinction is the whole
 * point - it is what lets reconnect tell "the operator wants this off" apart
 * from "this has never been configured", without inventing a disabled state for
 * a tool nobody ever touched.
 */

import { prisma } from "@chatcenter/shared";

/**
 * The canonical durable name for an integration tool's policy.
 *
 * `integration.<catalogToolSlug>` - the convention already documented on the
 * model (`"send_message" | "integration.hubspot.create_deal" | ...`) and already
 * used by the policy route's URL. Deliberately keyed on the CATALOG slug rather
 * than a connection id: the decision is about the tool, and it has to survive
 * the connection being replaced.
 */
export function durableToolName(catalogToolSlug: string): string {
  return `integration.${catalogToolSlug}`;
}

export interface OperatorIntent {
  /** The operator's explicit enable/disable decision. */
  enabled: boolean;
  requiresApproval: boolean;
  approverRole: string | null;
  expiresAfterMin: number;
  allowModification: boolean;
}

/**
 * Record an explicit operator decision so it survives the connection.
 *
 * Called alongside the live `TenantTool` write, never instead of it: the gate
 * reads the live row, and a durable record that the gate cannot see would be a
 * policy nobody enforces.
 *
 * Never throws. Failing to persist the durable copy must not fail the operator's
 * actual change - they would see an error for a setting that did apply, and
 * retry it.
 */
export async function recordOperatorToolIntent(opts: {
  tenantId: string;
  catalogToolSlug: string;
  actorId?: string | null;
  enabled?: boolean;
  requiresApproval?: boolean;
  approverRole?: string | null;
  expiresAfterMin?: number;
  allowModification?: boolean;
}): Promise<void> {
  const toolName = durableToolName(opts.catalogToolSlug);
  // Only the fields the operator actually set. A partial change must not
  // silently assert defaults for everything else it did not mention.
  const patch: Record<string, unknown> = { updatedBy: opts.actorId ?? null };
  if (typeof opts.enabled === "boolean") patch.enabled = opts.enabled;
  if (typeof opts.requiresApproval === "boolean") patch.requiresApproval = opts.requiresApproval;
  if (opts.approverRole === null || typeof opts.approverRole === "string") patch.approverRole = opts.approverRole;
  if (typeof opts.expiresAfterMin === "number") patch.expiresAfterMin = opts.expiresAfterMin;
  if (typeof opts.allowModification === "boolean") patch.allowModification = opts.allowModification;

  try {
    await (prisma as any).tenantToolPermission.upsert({
      where: { tenantId_toolName: { tenantId: opts.tenantId, toolName } },
      update: patch,
      create: {
        tenantId: opts.tenantId,
        toolName,
        enabled: typeof opts.enabled === "boolean" ? opts.enabled : true,
        requiresApproval: typeof opts.requiresApproval === "boolean" ? opts.requiresApproval : false,
        approverRole: typeof opts.approverRole === "string" ? opts.approverRole : null,
        expiresAfterMin: typeof opts.expiresAfterMin === "number" ? opts.expiresAfterMin : 30,
        allowModification: typeof opts.allowModification === "boolean" ? opts.allowModification : false,
        updatedBy: opts.actorId ?? null,
      },
    });
  } catch (err: any) {
    console.error("[tool-policy] durable operator intent write failed:", err?.message);
  }
}

/**
 * Every explicit decision this tenant has made about integration tools.
 *
 * Returned as a map keyed by catalog tool slug so provisioning can look each
 * candidate up without a query per tool. Returns an empty map on failure -
 * provisioning then uses catalogue defaults, which is the behaviour that
 * existed before this record did, rather than refusing to provision at all.
 */
export async function loadOperatorToolIntents(
  tenantId: string,
): Promise<Map<string, OperatorIntent>> {
  const out = new Map<string, OperatorIntent>();
  try {
    const rows: any[] = await (prisma as any).tenantToolPermission.findMany({
      where: { tenantId, toolName: { startsWith: "integration." } },
    });
    for (const r of rows) {
      const slug = String(r.toolName).slice("integration.".length);
      if (!slug) continue;
      out.set(slug, {
        enabled: r.enabled !== false,
        requiresApproval: r.requiresApproval === true,
        approverRole: r.approverRole ?? null,
        expiresAfterMin: typeof r.expiresAfterMin === "number" ? r.expiresAfterMin : 30,
        allowModification: r.allowModification === true,
      });
    }
  } catch (err: any) {
    console.warn("[tool-policy] could not load operator intents:", err?.message);
  }
  return out;
}

/**
 * The `TenantTool` shape an operator's decision implies.
 *
 * `configOverrides.hitlPolicy` is the form the execution gate reads, so a
 * restored HITL decision has to be written back in exactly that shape or it
 * would be recorded and not enforced.
 */
export function tenantToolFieldsFromIntent(intent: OperatorIntent): {
  isEnabled: boolean;
  configOverrides: Record<string, unknown>;
} {
  return {
    isEnabled: intent.enabled,
    configOverrides: {
      hitlPolicy: {
        mode: intent.requiresApproval ? "always" : "never",
        ...(intent.approverRole ? { approverRole: intent.approverRole } : {}),
        expiresAfterMin: intent.expiresAfterMin,
        allowModification: intent.allowModification,
      },
    },
  };
}
