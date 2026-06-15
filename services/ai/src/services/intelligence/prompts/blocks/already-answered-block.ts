/**
 * "ALREADY ANSWERED - DO NOT RE-ASK" block.
 *
 * Two-source fact sheet rendered into the live-copilot prompt every turn so
 * the LLM stops re-emitting missingFields for things the rep has already
 * heard or knows from CRM:
 *
 *   1. CRM-known identifiers (customer name / phone / email pulled once at
 *      runner spawn from the local Conversation + Contact rows).
 *   2. The cue projector's per-call observedFilled set (fields the LLM has
 *      heard answered in the live transcript - accumulated across frames
 *      so they're remembered even after they fall out of the Tier-A window).
 *
 * Without this block the LLM has to re-derive "did they already say this?"
 * every turn from a sliding transcript window, which fails on long calls.
 */

export interface AlreadyAnsweredInput {
  /** Customer name pulled from CRM/conversation. Omitted if unknown. */
  customerName?: string | null;
  /** Customer phone (E.164). Omitted if unknown. */
  contactPhone?: string | null;
  /** Customer email. Omitted if unknown. */
  contactEmail?: string | null;
  /**
   * Field keys the cue projector has marked as answered in this call.
   * Free-form strings - usually one of the well-known LeadField keys
   * (`name`, `email`, `phone`, `budget`, `timeline`, etc.) but any
   * tenant-specific field that came through `missingFields` works too.
   */
  observedFilled?: string[];
}

export function alreadyAnsweredBlock(input?: AlreadyAnsweredInput): string {
  if (!input) return "";

  const lines: string[] = [];
  if (input.customerName?.trim()) lines.push(`  name = ${input.customerName.trim()} (from CRM)`);
  if (input.contactPhone?.trim()) lines.push(`  phone = ${input.contactPhone.trim()} (from CRM)`);
  if (input.contactEmail?.trim()) lines.push(`  email = ${input.contactEmail.trim()} (from CRM)`);

  // Project filled fields → "<key> = (already stated this call)" so the
  // LLM treats them the same as CRM-known fields. We don't carry values
  // because the projector only knows the KEY was filled, not the value.
  for (const f of input.observedFilled ?? []) {
    if (!f || typeof f !== "string") continue;
    const k = f.trim();
    if (!k) continue;
    // Skip if we already have this from CRM - avoid double-listing.
    if (
      (k === "name" && input.customerName?.trim()) ||
      (k === "phone" && input.contactPhone?.trim()) ||
      (k === "email" && input.contactEmail?.trim())
    ) continue;
    lines.push(`  ${k} = (already stated this call)`);
  }

  if (lines.length === 0) return "";

  return [
    "ALREADY ANSWERED - DO NOT RE-ASK:",
    ...lines,
    "",
    "HARD RULE: every field listed above is KNOWN. You MUST NOT include any of these in `missingFields`, even if the rep hasn't re-stated them this turn. The rep has these answers already - re-asking is a UX failure.",
  ].join("\n");
}
