/**
 * Oracle producer (shadow path) - composes Facts for the reasoner SHADOW
 * comparison (Planner ↔ Reasoner over the SAME facts). It reads the money home
 * (billing wallet) and folds the live turn's signals into a single generic
 * capability world view, then composes canonical Facts via the pure
 * `assembleFacts`. The Oracle NEVER decides.
 *
 * NOTE: this is the SHADOW bridge, not the live kernel Oracle (that is
 * `agent-loop/oracle-assembler.ts`). Here the Planner's turn is projected into one
 * world view good enough to compare decisions on.
 */

import {
  assembleFacts,
  getBalance,
  type Facts,
  type AvailableOperation,
  type BillingStatus,
  type CapabilityWorldView,
} from "@chatcenter/shared";

/** Signals the live turn already has; the Oracle folds in the money home itself. */
export interface TurnSignals {
  customer: { id?: string; knownFields: Record<string, string | undefined>; identityResolved: boolean };
  crm: { hasLead: boolean; hasContact: boolean; hasOpportunity: boolean; recordRefs?: Record<string, string> };
  scheduling: { activeBooking?: { when: string; ref: string }; calendarConnected: boolean; bookable: boolean };
  permissions: { allowedOperations: string[] };
  availableOperations: AvailableOperation[];
  /** Optional pre-known billing status; defaults to "active" when unknown. */
  billingStatus?: BillingStatus;
}

/**
 * Read + compose Facts for a shadow turn. Never throws (a billing read blip yields
 * unknown credits, not a failure).
 */
export async function computeFacts(tenantId: string, turn: TurnSignals): Promise<Facts> {
  let credits: number | undefined;
  try {
    credits = (await getBalance(tenantId)).total;
  } catch {
    credits = undefined;
  }

  // Project the Planner turn into one generic world view (the shadow only needs
  // the facts + the menu to compare decisions).
  const world: CapabilityWorldView[] = [
    {
      capability: "AGENT",
      summary: "Planner turn projected for shadow comparison.",
      facts: { crm: turn.crm, scheduling: turn.scheduling },
      operations: turn.availableOperations,
    },
  ];

  return assembleFacts({
    customer: turn.customer,
    billing: {
      status: turn.billingStatus ?? "active",
      credits,
      withinLimits: credits == null ? true : credits > 0,
    },
    permissions: turn.permissions,
    world,
    now: new Date().toISOString(),
  });
}
