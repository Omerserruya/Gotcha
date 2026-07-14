/**
 * PROSPECT STATE - where this person stands relative to the CRM, made explicit
 * in the prompt so the agent stops behaving the same way for a cold stranger
 * and a paying customer.
 *
 * Derived from the CRM prefetch flags (external CRM matches), NOT our internal
 * Contact table - a WhatsApp inbound always creates an internal Contact row, so
 * that can't tell us "new prospect". The authoritative signal is whether the
 * external CRM returned a lead/contact/opportunity record.
 *
 * Per the spec: the ABSENCE of a CRM record must explicitly render
 * NEW_PROSPECT=true so the agent knows it currently knows almost nothing and
 * must work to generate a lead.
 */

export type ProspectState =
  | "NEW_PROSPECT"
  | "KNOWN_CONTACT"
  | "OPEN_OPPORTUNITY"
  | "CUSTOMER";

export interface CrmStateFlags {
  /** A CRM lead record matched. */
  hasLead: boolean;
  /** Any CRM contact/lead record exists for this person. */
  hasContact: boolean;
  /** An open deal/opportunity exists. */
  hasOpportunity?: boolean;
  /** The contact is a paying/active customer. */
  isCustomer?: boolean;
}

export function computeProspectState(f: CrmStateFlags): ProspectState {
  if (f.isCustomer) return "CUSTOMER";
  if (f.hasOpportunity) return "OPEN_OPPORTUNITY";
  if (f.hasContact || f.hasLead) return "KNOWN_CONTACT";
  return "NEW_PROSPECT";
}

const STATE_GUIDANCE: Record<ProspectState, string> = {
  NEW_PROSPECT:
    "No CRM record exists for this person yet - you know almost nothing about them. Lead generation is a PRIMARY objective: naturally learn who they are, how to reach them, and what they need - enough to create a lead. Do not let them leave as an anonymous stranger.",
  KNOWN_CONTACT:
    "They're already a known contact/lead. Don't re-collect identity you already have - reference it naturally and move the relationship forward toward qualification or a meeting.",
  OPEN_OPPORTUNITY:
    "There's an open opportunity. Drive it forward - advance the deal toward its next milestone (meeting, proposal, decision).",
  CUSTOMER:
    "This is an existing customer. Lead with their success; focus on retention, value, and relevant expansion - not basic lead capture.",
};

/** Render the # Prospect State block for BLOCK 5. */
export function renderProspectState(state: ProspectState): string {
  const lines: string[] = ["# Prospect State (this turn)"];
  lines.push(`Current: **${state}**`);
  lines.push(`NEW_PROSPECT=${state === "NEW_PROSPECT"}`);
  lines.push(STATE_GUIDANCE[state]);
  return lines.join("\n");
}
