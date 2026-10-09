import 'server-only';

import { featureRefusalFrom, type FeatureRefusal } from '@/api/client/tenant-gate';
import { serverApi } from '@/api/client/server-api';
import { suggestionsResponseSchema, type SuggestionsResponse } from '@/api/contracts/copilot';
import { inboxEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * What the copilot panel got to know.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ FOUR OUTCOMES, AND THREE OF THEM ARE "NOTHING TO SHOW" FOR DIFFERENT
 *    REASONS
 * ════════════════════════════════════════════════════════════════════════════
 * A panel with one empty state for all of these tells an agent the AI had no
 * ideas when the truth may be that their plan does not include the feature, or
 * that the model call failed. The first invites them to write the reply
 * themselves, which is right. The second should send them to somebody who can
 * change the plan. The third should make them try again.
 *
 * This is the house rule - *an empty result must say whether anyone looked* -
 * with a fourth case, because "looked and was refused" splits into "your plan"
 * and "the product does not have it".
 */
export type CopilotRead =
  | { readonly state: 'ok'; readonly response: SuggestionsResponse }
  /** A 402 from `requireEntitlement`. Ordinary, not a fault. */
  | { readonly state: 'refused'; readonly refusal: FeatureRefusal }
  /** Anything else: the model call failed, the service is down, a timeout. */
  | { readonly state: 'unavailable' };

/**
 * `raw` because `data` sits **alongside** `copilotMode` in this response.
 *
 * The client unwraps any top-level `data`, which is right for the envelope shape
 * and wrong here: without `raw` the mode is silently discarded, and the mode is
 * what decides which panel this is. Same trap as the automations list, different
 * shape - there `data` was absent entirely, here it has a sibling.
 */
export async function loadCopilot(conversationId: string): Promise<CopilotRead> {
  try {
    const response = await serverApi().get({
      endpoint: inboxEndpoints.suggestions(conversationId),
      payload: suggestionsResponseSchema,
      raw: true,
    });
    return { state: 'ok', response };
  } catch (cause) {
    const refusal = featureRefusalFrom(cause);
    if (refusal) {
      /*
       * Logged at info, not warn. A tenant on a plan without Copilot refuses
       * this read on every conversation they open, and a warning per open turns
       * an ordinary commercial state into noise that hides real failures.
       */
      logger.info('inbox.copilot_not_entitled', { code: refusal.code, feature: refusal.feature });
      return { state: 'refused', refusal };
    }
    logger.warn('inbox.copilot_failed', { cause });
    return { state: 'unavailable' };
  }
}
