/** The stock handoff line every employee is created with (services/ai ai-agent-defaults.ts). */
export const STOCK_ESCALATION_EN = "Let me connect you with a team member who can help further.";
export const STOCK_ESCALATION_HE = "מעבירים את השיחה לנציג מהצוות שלנו, שימשיך מכאן.";

const HEBREW = /[\u0590-\u05FF]/;

/**
 * The static line, in the customer's language when it is the stock English
 * one (2026-10-25: a Hebrew conversation on omer-onb-2 got the English line
 * when the AI service was down and the oneshot could not write one). An
 * owner's own wording is theirs and goes out as written.
 */
export function localizedFallback(fallback: string, inboundSample: string): string {
  if (fallback.trim() === STOCK_ESCALATION_EN && HEBREW.test(inboundSample)) return STOCK_ESCALATION_HE;
  return fallback;
}
