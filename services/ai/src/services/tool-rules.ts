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
  "You have a working booking tool (`schedule_meeting`), but you do NOT know the calendar yourself — whether a time is free, allowed, in the past, or within working hours is known ONLY by calling it.",
  "- NEVER say a time is free/available/open, NEVER agree to or confirm a time, NEVER say a meeting is booked, and NEVER say \"I'll check\" / \"let me see\" / \"one second\" about availability — until you have CALLED `schedule_meeting` and it returned success THIS turn.",
  "- To check or book, CALL `schedule_meeting` now and let its result speak: on success, confirm the exact day/time + the meeting link; if it returns alternative slots, relay THOSE exact times and ask the customer to pick; if the time is invalid / in the past / outside hours, say so plainly and offer the alternatives.",
  "- Do NOT promise to \"get back to you\" or \"pass it to the team\" to schedule — you book it yourself by calling the tool. Use the customer's stated day/time; if you're missing the day/time or email, ask for exactly that — never invent availability.",
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
