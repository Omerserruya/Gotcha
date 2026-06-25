/**
 * Capability-conditional TOOL RULES, auto-injected into the system prompt.
 *
 * Hard, non-negotiable rules about HOW the agent may talk about things it can
 * only know by calling a tool. Loaded automatically based on the agent's live
 * capabilities (calendar bookable, etc.) — so the model is told the rule UP
 * FRONT (proactive), complementing the runtime gates that catch violations
 * after the fact (reactive).
 *
 * Observed live (omer): a bookable agent invented availability ("I have free
 * Saturday"), agreed to an invalid time ("schedule it for 3am"), said "I'll
 * check" and never did, and promised to "pass it to the team" — all WITHOUT
 * calling `schedule_meeting`. The model does not know the calendar; only the
 * tool does. This block makes that explicit.
 *
 * Extend by adding more capability branches (CRM writes, payments, …) — each
 * returns a short `## <area>` section; the block header is shared.
 */

export interface ToolRuleCapabilities {
  /** true = a working, bookable calendar tool is surfaced this turn. */
  calendarBookable?: boolean;
}

const CALENDAR_BOOKABLE_RULES = [
  "## Calendar / booking",
  "You have TWO calendar tools and you do NOT know the calendar yourself — whether a time is free, allowed, in the past, or within working hours is known ONLY by calling them:",
  "  • `check_availability` — READ. The single source of truth for EVERY availability + working-hours question. Use it to answer \"are you free tomorrow / around noon?\", \"what are your working hours?\", \"do you work Saturday / evenings?\", AND to get real open slots before you propose any time.",
  "  • `schedule_meeting` — WRITE. Books an ALREADY-CHOSEN slot. Never use it to discover or test availability.",
  "- NEVER state availability, working hours, or a specific open time, NEVER agree to / confirm a time, and NEVER say a meeting is booked — from memory or reasoning. Every such statement must come from a tool RESULT this turn.",
  "- The flow is exactly how a real assistant works: customer asks about timing OR you want to propose a meeting → call `check_availability` first and offer ONLY the slots / hours it returns. Customer picks a concrete slot → call `schedule_meeting` with that exact time to book it. Never skip the availability step; never invent a time.",
  "- \"What are your working hours?\", \"are you open Saturday?\", \"evenings?\" are availability questions, not off-topic — answer them with `check_availability` (its `workingHours` + `timezone`), never by guessing.",
  "- If `schedule_meeting` comes back with `needsAvailabilityCheck` (the chosen time isn't bookable, or a slot was just taken), do NOT confirm — call `check_availability`, offer the real open slots, and let the customer pick.",
  "- To move an existing meeting, find the new time with `check_availability`, then call `reschedule_meeting` with the chosen time. Do NOT promise to \"get back to you\" or \"pass it to the team\" — you do it yourself by calling the tools.",
].join("\n");

/**
 * Build the Tool Rules block for the current capabilities. Returns null when no
 * capability-specific rule applies (e.g. a non-bookable agent — the separate
 * Booking-Capability boundary block covers that case).
 */
export function buildToolRulesBlock(caps: ToolRuleCapabilities): string | null {
  const sections: string[] = [];
  if (caps.calendarBookable === true) sections.push(CALENDAR_BOOKABLE_RULES);
  // Future capability rules append here.
  if (sections.length === 0) return null;
  return ["# Tool Rules (HARD — verify with the tool, never guess)", ...sections].join("\n\n");
}
