import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  briefSchema,
  crmContextSchema,
  memorySchema,
  timelineSchema,
  type CustomerBrief,
  type CrmContext,
  type CustomerMemory,
  type CustomerTimeline,
} from '@/api/contracts/customer-detail';
import { customerEndpoints } from '@/api/endpoints/registry';
import { withDetailFixtures } from './capture-fixtures';
import { readKeyFor } from './conversation-key';
import { logger } from '@/observability/logger';

/**
 * What screen 04b reads.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ORDERED, NOT PARALLEL — AND THAT IS THE DATA'S FAULT, NOT A PREFERENCE
 * ════════════════════════════════════════════════════════════════════════════
 * Three reads describing one person, each keyed differently:
 *
 *   timeline   by CONTACT id        the id the list hands us
 *   brief      by CONVERSATION id   ← comes from the timeline
 *   memory     by PHONE             ← comes from the timeline's contact
 *
 * So the timeline has to land before the other two can be asked for. Every
 * other loader in this app fans out; this one cannot, and the cost is one
 * extra round trip on a page that already costs three.
 *
 * ── EACH FAILURE IS ITS OWN ──
 * A missing brief does not blank the timeline and a failed memory read does
 * not blank either. They answer different questions, and a merchant who can
 * still read the conversation history is better served than one shown a
 * single error for all three.
 *
 * `null` means WE COULD NOT READ IT and is distinct everywhere from an empty
 * result, which means there is nothing to show. The screen says different
 * sentences for those.
 */
export interface CustomerDetail {
  readonly timeline: CustomerTimeline | null;
  readonly brief: CustomerBrief | null;
  readonly memory: CustomerMemory | null;
  /** The merchant's CRM notes for this person. `null` when the read failed. */
  readonly crm: CrmContext | null;
  /**
   * True when the person has no conversations at all, so the brief was never
   * requested rather than requested and missing.
   *
   * Without this the screen cannot tell "we asked and there is none" from
   * "there was no door to ask through", and those are different sentences.
   */
  readonly noConversations: boolean;
}

export async function loadCustomer(contactId: string): Promise<CustomerDetail> {
  const api = serverApi();

  const timeline = await api
    .get({ endpoint: customerEndpoints.timeline(contactId), payload: timelineSchema })
    .catch((cause: unknown) => {
      logger.warn('customer.timeline_failed', { cause });
      return null;
    });

  if (!timeline) {
    /*
     * Through the fixture gate too: a synthetic id 404s by construction, and
     * that failure is not evidence about this screen. See `withDetailFixtures`.
     */
    return withDetailFixtures(
      { timeline: null, brief: null, memory: null, crm: null, noConversations: false },
      contactId,
    );
  }

  /*
   * ONE shared helper, so four screens cannot each choose differently. Reads
   * only — see the note in `conversation-key.ts` for why a write must not
   * use it.
   */
  const conversationId = readKeyFor(timeline.events);
  /*
   * The phone is the memory's key. `identity/:id/timeline` returns the
   * EFFECTIVE contact — the survivor of any merge — so this is the right
   * identifier even when the page was opened by a merged-away id.
   */
  const externalId = timeline.contact?.externalId?.trim() ?? '';

  const [brief, memory, crm] = await Promise.all([
    /*
     * ★ BY CONTACT, NOT BY CONVERSATION — Backend added the entry point
     * after this screen reported the door problem.
     *
     * It resolves the person internally, follows the soft-merge pointer, and
     * answers `reason: "no_conversations"` for somebody who has never
     * written rather than erroring. So the brief is no longer one of the
     * conversation-keyed reads, and this page no longer has to choose a
     * conversation on its behalf.
     *
     * ⚠ STILL NO `refresh`. The route falls back to inline generation when
     * that flag is set, which is a live model call on a page load — on a
     * screen somebody opens to read, not to regenerate.
     */
    api
      .post({
        endpoint: customerEndpoints.summary(),
        body: { contactId },
        payload: briefSchema,
      })
      .catch((cause: unknown) => {
        logger.warn('customer.brief_failed', { cause });
        return null;
      }),
    externalId
      ? api
          .get({ endpoint: customerEndpoints.memory(externalId), payload: memorySchema })
          .catch((cause: unknown) => {
            logger.warn('customer.memory_failed', { cause });
            return null;
          })
      : Promise.resolve(null),
    conversationId
      ? api
          .get({
            endpoint: customerEndpoints.crmContext(conversationId),
            payload: crmContextSchema,
          })
          .catch((cause: unknown) => {
            logger.warn('customer.crm_failed', { cause });
            return null;
          })
      : Promise.resolve(null),
  ]);

  /*
   * ★ SUBSTITUTED LAST, AND ONLY UNDER THE GATE.
   *
   * This page renders the BODIES of a real person's messages, a written
   * character study of them and the durable facts GOTCHA has learned — far
   * more exposure than the list, which already justified a fixture.
   *
   * Applied to what the real reads returned, so a failure stays a failure.
   */
  return withDetailFixtures(
    { timeline, brief, memory, crm, noConversations: conversationId === null },
    contactId,
  );
}
