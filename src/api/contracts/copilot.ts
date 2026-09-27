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

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE PROVIDER REPORTS ITS OWN FAILURES *INSIDE* THE SUGGESTION LIST
 * ════════════════════════════════════════════════════════════════════════════
 * A browser walk read this off the live panel, in the position where a draft
 * reply goes:
 *
 *     Failed to get AI suggestions. Check API key and model configuration.
 *
 * A support agent deciding whether to trust the AI's draft was being told to go
 * and check an API key. It is not an error envelope, not a status, and not a 402 —
 * it is a one-item list with a sentinel id, so the panel's four honest empty
 * states could not see it. The response was a 200 with content.
 *
 * ── AND THERE ARE SIX OF THEM, NOT ONE ──
 * Found by grepping the provider rather than fixing the string in the
 * screenshot. Five are not suggestions at all and mean genuinely different
 * things to a reader, so they map to different sentences:
 *
 *     error       the provider call failed or is misconfigured
 *     stub-1      no provider is configured at all
 *     disabled    Copilot is switched off for this tenant
 *     no-config   no AI employee exists to draft with
 *     no-match    nothing relevant to suggest — the genuine empty case
 *
 * ★ AND THE SIXTH IS A REAL DRAFT AND MUST NOT BE SUPPRESSED. `openai-text`
 *   carries the model's own content with `confidence: 0.5`; the provider emits it
 *   when its structured parse failed, not when the model did. Discarding it would
 *   throw away a usable reply, and treating it as an `info` note — which its
 *   `type` says — labels a draft as "an action it would take", which is the
 *   opposite of true.
 *
 * ⚠ ITS BLIND SPOT, STATED: a sentinel id added later renders its text verbatim,
 * exactly as `error` did. A closed set is the only honest option from this side —
 * the real fix is for these not to travel inside the payload — so the set is here,
 * in one place, for the next one to be added to.
 */
const SENTINELS = new Map<string, CopilotSentinel>([
  ['error', 'provider_failed'],
  ['stub-1', 'no_provider'],
  ['disabled', 'switched_off'],
  ['no-config', 'no_employee'],
  ['no-match', 'nothing_relevant'],
]);

export type CopilotSentinel =
  'provider_failed' | 'no_provider' | 'switched_off' | 'no_employee' | 'nothing_relevant';

/** A real draft the provider could not structure. Rendered, not suppressed. */
const UNSTRUCTURED_DRAFT = 'openai-text';

/**
 * The sentinel this list is, or `null` when it holds real suggestions.
 *
 * Only for a list of exactly one: the provider returns a sentinel *instead of*
 * suggestions, never beside them. Requiring that means a genuine suggestion which
 * happened to carry one of these ids — vanishingly unlikely, but the kind of
 * coincidence that eats a real draft — cannot hide four others.
 */
export function copilotSentinel(suggestions: readonly Suggestion[]): CopilotSentinel | null {
  if (suggestions.length !== 1) return null;
  return SENTINELS.get(suggestions[0]!.id.trim()) ?? null;
}

/**
 * Only a `reply` is a draft somebody could send. Everything else is a note.
 *
 * `openai-text` is the exception and it is the provider's, not ours: its `type` is
 * `info` because the structured parse failed, while its text is the model's actual
 * reply. Filing it as a note would tell an agent that a usable draft is something
 * the AI would *do*.
 */
export function isDraft(suggestion: Suggestion): boolean {
  if (suggestion.id.trim() === UNSTRUCTURED_DRAFT) return true;
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
