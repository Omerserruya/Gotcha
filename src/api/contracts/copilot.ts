import { z } from 'zod';

/**
 * The AI's suggested replies — `GET /api/ai-assist/:conversationId/suggestions`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ TWO ENTITLEMENTS, TWO INDEPENDENT ABSENCES
 * ════════════════════════════════════════════════════════════════════════════
 * The route is gated on `ai.copilot`. Its neighbour, `/summary`, is gated on
 * **`communication.crm_summaries`** — deliberately a different key, with the
 * platform's own comment saying *"Foundation denies Copilot and grants
 * summaries; gating this route on ai.copilot would break exactly the plan
 * combination the product sells."*
 *
 * So a tenant may have one and not the other, and a panel that treats them as
 * one capability is broken for a plan the company sells today.
 *
 * ── AND `copilotMode` IS TWO DIFFERENT PANELS ──
 * `READY_MESSAGE` is a list of drafts an agent may send. `CHAT` is a
 * conversation between the agent and the AI, which is a different control with a
 * different write behind it. The route defaults to `READY_MESSAGE` when the
 * tenant has no explicit config, so that is the one built — and an unbuilt mode
 * says so rather than showing ready messages for a mode that did not ask for
 * them.
 *
 * ── WHAT IS NOT READ ──
 * `quickAction` carries a tool name and arguments the model proposed. **Firing a
 * tool is the one thing this panel must never make easy**: the approvals screen
 * exists for exactly that decision, with a keyboard model designed around the
 * absence of an undo. Suggestions of type `quick_action` are shown as what the
 * AI would do and carry no control.
 */

/** `reply` is a draft. `action`/`quick_action` are proposals, never buttons. */
export const SUGGESTION_TYPES = ['reply', 'action', 'info', 'quick_action'] as const;
export type SuggestionType = (typeof SUGGESTION_TYPES)[number];

export const suggestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().default(''),
  /**
   * `0`–`1` from the model. Rendered as a band, never as a percentage: two
   * decimal places on a model's self-report is a precision claim nothing
   * supports.
   */
  confidence: z.number().nullable().default(null),
  /**
   * Free string on the wire. `z.enum(...).catch()` would quietly file a type we
   * have never seen under one we have, and the difference decides whether a
   * draft gets an "insert" affordance.
   */
  type: z.string().default('info'),
  /** One line naming the tactic. Model-authored, so it is rendered, not parsed. */
  approach: z.string().nullable().optional(),
  /** Why this fits, in the model's words. */
  rationale: z.string().nullable().optional(),
});
export type Suggestion = z.infer<typeof suggestionSchema>;

export const suggestionsResponseSchema = z.object({
  data: z.array(suggestionSchema).default([]),
  /**
   * `READY_MESSAGE` or `CHAT`. Free string for the same reason as `type`: an
   * unrecognised mode must reach the screen as unrecognised, not be coerced into
   * the one we happen to render.
   */
  copilotMode: z.string().default('READY_MESSAGE'),
});
export type SuggestionsResponse = z.infer<typeof suggestionsResponseSchema>;

/** Only a `reply` is a draft somebody could send. Everything else is a note. */
export function isDraft(suggestion: Suggestion): boolean {
  return suggestion.type.trim().toLowerCase() === 'reply';
}

export type ConfidenceBand = 'high' | 'medium' | 'low' | 'unstated';

/**
 * The model's confidence as a band.
 *
 * ★ `null` is `unstated`, not `low`. "The model did not say" and "the model is
 *   unsure" are different facts, and filing the first as the second tells an
 *   agent to distrust a draft nothing has reported anything about.
 *
 * A number outside `0`–`1` is also `unstated`: a value we cannot place on the
 * scale is not a low one.
 */
export function confidenceBand(suggestion: Suggestion): ConfidenceBand {
  const value = suggestion.confidence;
  if (value === null || !Number.isFinite(value) || value < 0 || value > 1) return 'unstated';
  if (value >= 0.8) return 'high';
  if (value >= 0.5) return 'medium';
  return 'low';
}
