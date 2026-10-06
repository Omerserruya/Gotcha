import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/customers.json';

import { CustomerDetail } from './CustomerDetail';
import type { CustomerDetail as Detail } from './load-customer';

/**
 * Screen 04b - and every assertion here is about a LIMIT.
 *
 * The screen's content is mostly the platform's own prose. What this file
 * guards is the set of things the screen must never imply: that the timeline
 * is complete, that it carries more than messages, that notes can be written,
 * or that a remembered fact can be traced to its conversation.
 *
 * Each of those is a sentence that is easy to delete and impossible to notice
 * missing - the page still renders, reads well, and is wrong.
 */

/*
 * `timeZone` matches `i18n/request.ts`, which sets `Asia/Jerusalem` for every
 * real request. A formatter without it falls back to the machine's zone (and
 * warns ENVIRONMENT_FALLBACK); one set to UTC formats a different day for any
 * timestamp in the evening. Either way the test renders a date the product
 * never shows, and a date assertion can pass while the screen is a day out.
 */
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'customers') =>
    createTranslator({ locale: 'en', messages: { customers: messages }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

const message = (over: Record<string, unknown> = {}) => ({
  type: 'message' as const,
  channel: 'WHATSAPP',
  conversationId: 'c1',
  direction: 'INBOUND' as const,
  body: 'hello',
  createdAt: '2026-09-01T10:00:00.000Z',
  id: 'e1',
  origin: 'LIVE' as const,
  handover: null,
  action: null,
  ...over,
});

function detail(over: Partial<Detail> = {}): Detail {
  return {
    timeline: {
      contact: { id: 'p1', displayName: 'Dana', externalId: '+972500000000', channel: 'WHATSAPP' },
      events: [message()],
      page: { limit: 50, types: ['message'], nextCursor: null, hasMore: false },
      coverage: {},
      totals: {
        conversations: 1,
        messages: 1,
        handovers: 0,
        aiActions: 0,
        conversationScanTruncated: false,
      },
    },
    brief: null,
    memory: null,
    crm: null,
    orders: null,
    conversationId: null,
    noConversations: false,
    ...over,
  } as Detail;
}

const show = async (d: Detail) => render(await CustomerDetail({ detail: d }));

describe('★★ the timeline must never claim to be a history', () => {
  it('★★ says how many of the total are shown, not just how many are shown', async () => {
    /*
     * The sentence this replaces named 50 conversations × 5 messages - a
     * shape that no longer exists, and that was the WRONG limit even then.
     * The old route thinned rather than truncated, so the stream had holes in
     * the middle of every conversation and an honest-sounding "showing recent
     * activity" would still have been false.
     *
     * `totals.messages` makes the true sentence available.
     */
    await show(
      detail({
        timeline: {
          contact: null,
          identityChannels: [],
          events: [message()],
          page: { limit: 50, types: ['message'], nextCursor: 'abc', hasMore: true },
          coverage: {},
          totals: {
            conversations: 40,
            messages: 1284,
            handovers: 0,
            aiActions: 0,
            conversationScanTruncated: false,
          },
        },
      }),
    );
    const count = screen.getByTestId('timeline-count');
    expect(count).toHaveTextContent(/1,284/);
    expect(count).toHaveTextContent(/showing 1 of/i);
  });

  it('does not hedge a complete history', async () => {
    // The inverse direction, so the sentence is a statement about the data.
    await show(detail());
    const count = screen.getByTestId('timeline-count');
    // Not "showing 1 of 1", which hedges a complete history into a partial one.
    expect(count).toHaveTextContent(/1 message with this person/i);
    expect(count).not.toHaveTextContent(/showing/i);
  });

  it('★★ labels an imported message as imported', async () => {
    /*
     * Until today the timeline excluded imported history entirely -
     * `applyLiveByDefault` injects `origin: "LIVE"` into any read that does
     * not mention origin, and this route never did. A customer with years of
     * imported WhatsApp rendered as brand new, confidently, with no marker.
     *
     * Now it is included, and labelled: something we were TOLD about is not
     * something the product watched happen.
     */
    await show(
      detail({
        timeline: {
          contact: null,
          identityChannels: [],
          events: [message({ origin: 'HISTORICAL_IMPORT' })],
          page: { limit: 50, types: ['message'], nextCursor: null, hasMore: false },
          coverage: {},
          totals: {
            conversations: 1,
            messages: 1,
            handovers: 0,
            aiActions: 0,
            conversationScanTruncated: false,
          },
        },
      }),
    );
    expect(screen.getByTestId('event-imported')).toHaveTextContent(/imported/i);
  });

  it('does not label a live message as imported', async () => {
    await show(detail());
    expect(screen.queryByTestId('event-imported')).toBeNull();
  });

  it('discloses the conversation-scan bound when it bit', async () => {
    // A bounded read that discloses its bound is fine; one that quietly
    // drops the oldest threads is the defect.
    await show(
      detail({
        timeline: {
          contact: null,
          identityChannels: [],
          events: [message()],
          page: { limit: 50, types: ['message'], nextCursor: null, hasMore: false },
          coverage: {},
          totals: {
            conversations: 500,
            messages: 900,
            handovers: 0,
            aiActions: 0,
            conversationScanTruncated: true,
          },
        },
      }),
    );
    expect(screen.getByTestId('timeline-scan-truncated')).toHaveTextContent(/oldest may not be/i);
  });

  it("★★ renders the server's coverage, including AVAILABLE-but-incomplete", async () => {
    /*
     * `available: true` is not the same as complete. `ai_action` carries a
     * detail saying ToolExecution records catalog HTTP tools only - so a
     * Shopify refund the AI performed is NOT in this list, and Backend's own
     * note says the gap is invisible from the data.
     *
     * A screen that renders the events and drops the detail deletes the only
     * warning there is. Both kinds of gap are shown together, because a
     * merchant does not care which is which: absent and present-but-partial
     * are equally reasons not to read this as the whole story.
     */
    await show(
      detail({
        timeline: {
          contact: null,
          identityChannels: [],
          events: [message()],
          page: { limit: 50, types: ['message'], nextCursor: null, hasMore: false },
          coverage: {
            message: { available: true, reason: null, detail: null },
            ai_action: {
              available: true,
              reason: null,
              detail:
                'ToolExecution records catalog HTTP tools only. An action taken through an adapter, such as a Shopify refund, is not recorded here.',
            },
            order: {
              available: false,
              reason: 'no_local_model',
              detail: 'Orders live in the commerce platform and are served by their own screen.',
            },
          },
          totals: {
            conversations: 1,
            messages: 1,
            handovers: 0,
            aiActions: 0,
            conversationScanTruncated: false,
          },
        },
      }),
    );
    // The PARTIAL one - the dangerous one.
    expect(screen.getByTestId('coverage-ai_action')).toHaveTextContent(/not recorded here/i);
    // And the absent one.
    expect(screen.getByTestId('coverage-order')).toHaveTextContent(/own screen/i);
    // A source that is available AND complete needs no sentence.
    expect(screen.queryByTestId('coverage-message')).toBeNull();
  });

  it('★★ renders a handover from `handover`, never from `body`', async () => {
    /*
     * `body` is null on handovers and AI actions. Backend deliberately did
     * not compose summary sentences into it: a sentence they compose is not
     * data, and in that field it would be indistinguishable from something
     * the customer actually wrote.
     *
     * The legacy CustomerTimeline renders `body ?? "(no body)"` and shows
     * both kinds as empty messages.
     */
    await show(
      detail({
        timeline: {
          contact: null,
          identityChannels: [],
          events: [
            message({
              type: 'handover',
              body: null,
              direction: null,
              handover: { from: 'ai', to: 'Dana', actorUserId: 'u1', reason: 'refund request' },
            }),
          ],
          page: { limit: 50, types: ['handover'], nextCursor: null, hasMore: false },
          coverage: {},
          totals: {
            conversations: 1,
            messages: 0,
            handovers: 1,
            aiActions: 0,
            conversationScanTruncated: false,
          },
        },
      }),
    );
    const handover = screen.getByTestId('event-handover');
    expect(handover).toHaveTextContent(/Handed to Dana/);
    expect(handover).toHaveTextContent(/refund request/);
    // Never the empty-message fallback.
    expect(screen.queryByText(/\(no text\)/)).toBeNull();
  });

  it('★ an AI action says whether it WORKED', async () => {
    // A failed tool call rendered as "GOTCHA ran process_refund" would read
    // as a refund that happened.
    await show(
      detail({
        timeline: {
          contact: null,
          identityChannels: [],
          events: [
            message({
              type: 'ai_action',
              body: null,
              direction: null,
              action: {
                tool: 'process_refund',
                success: false,
                triggeredBy: 'ai',
                durationMs: 120,
                approvedBy: null,
              },
            }),
          ],
          page: { limit: 50, types: ['ai_action'], nextCursor: null, hasMore: false },
          coverage: {},
          totals: {
            conversations: 1,
            messages: 0,
            handovers: 0,
            aiActions: 1,
            conversationScanTruncated: false,
          },
        },
      }),
    );
    const action = screen.getByTestId('event-action');
    expect(action).toHaveTextContent(/tried process_refund and it failed/i);
    expect(action).not.toHaveTextContent(/^GOTCHA ran/);
  });

  it('still says the cross-channel part IS real, because it is', async () => {
    // The route follows `mergedIntoId`, gathers sibling contacts and includes
    // aliases preserved from prior merges. That is the hard part and it is
    // done - hedging it would undersell the one claim that holds.
    await show(detail());
    expect(screen.getByTestId('timeline-scope')).toHaveTextContent(/every channel/i);
  });
});

describe('★★ nothing here offers a note', () => {
  it('★★ notes are READ-ONLY, and the page says why rather than offering a box', async () => {
    /*
     * This screen first shipped saying notes were not recorded. That was
     * wrong - `POST /conversations/:id/notes` is a demo stub, but
     * `crm-panel.ts:690` calls `adapter.createNote` for real. GOTCHA does not
     * store notes; the merchant's CRM does.
     *
     * Writing is still not offered, and for a different reason than before:
     * the write sets `source_interaction_id` to whichever conversation this
     * page entered through, so a note taken here would be filed against an
     * unrelated chat IN THE MERCHANT'S OWN CRM, where we cannot correct it.
     * Writing a false fact into somebody else's system of record is worse
     * than withholding the control.
     */
    const { container } = await show(
      detail({ crm: { recent_crm_notes: [], link_meta: { outcome: 'linked' } } }),
    );
    expect(screen.getByTestId('notes-read-only')).toHaveTextContent(/written in your CRM/i);
    expect(screen.getByTestId('notes-read-only')).toHaveTextContent(/wrong conversation/i);
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('★ two blockers, two repairs - never one sentence for both', async () => {
    /*
     * The 14d call, and it applies here because there IS a repair a merchant
     * can perform. Sending somebody to connect a CRM they already have is
     * the exact mistake 14d exists to prevent, and it is worse here because
     * the repair lives on a different screen.
     */
    await show(detail({ crm: { recent_crm_notes: [], link_meta: { outcome: 'search_only' } } }));
    const noCrm = screen.getByTestId('notes-no-crm');
    expect(noCrm).toHaveTextContent(/isn't one connected/i);
    expect(noCrm).not.toHaveTextContent(/isn't linked/i);

    screen.getByTestId('notes-no-crm').remove();
    await show(detail({ crm: { recent_crm_notes: [], link_meta: { outcome: 'no_crm_link' } } }));
    const noLink = screen.getByTestId('notes-no-link');
    expect(noLink).toHaveTextContent(/isn't linked to a record/i);
    // And explicitly NOT the connect-one instruction.
    expect(noLink).not.toHaveTextContent(/Connect one in Business core/i);
  });

  it('★ says the notes are anonymous, because CrmActivity has no author', async () => {
    /*
     * `CrmActivity` is `{ id, kind, body, occurred_at, source_interaction_id }`.
     * 04f asks for notes that are "attributed and dated"; on this path they
     * are dated and anonymous, and nothing on the screen can change that.
     *
     * Said out loud so nobody assumes the newest note is theirs.
     */
    await show(
      detail({
        crm: {
          recent_crm_notes: [
            {
              id: 'n1',
              kind: 'note',
              body: 'Prefers Thursday.',
              occurred_at: '2026-09-10T08:00:00.000Z',
            },
          ],
          link_meta: { outcome: 'linked' },
        },
      }),
    );
    expect(screen.getByTestId('crm-note')).toHaveTextContent(/Prefers Thursday/);
    expect(screen.getByTestId('notes-anonymous')).toHaveTextContent(/doesn't record who wrote/i);
  });

  it('distinguishes a failed CRM read from having no CRM', async () => {
    // One means look again, the other means connect something. They must not
    // share a sentence.
    await show(detail({ crm: null }));
    expect(screen.getByTestId('notes-unavailable')).toHaveTextContent(/couldn't read notes/i);
  });

  it('never renders a tenure line', async () => {
    /*
     * Three fields look like tenure and all three undersell a long-standing
     * customer - `customer-card.ts` names them itself. A line saying a
     * three-year customer joined today is worse than no line.
     */
    await show(detail());
    expect(screen.queryByText(/customer since/i)).toBeNull();
    expect(screen.queryByText(/joined/i)).toBeNull();
  });

  it('names the money figures as not shown, with the reason', async () => {
    // Real, and approval-keyed on purpose: two live vendor calls per
    // customer with no cache. Named rather than silently omitted.
    const money =
      screen.queryByTestId('absent-money') ??
      (await show(detail()), screen.getByTestId('absent-money'));
    expect(money).toHaveTextContent(/aren't shown here/i);
    expect(money).toHaveTextContent(/calling your store live/i);
  });
});

describe('★ what GOTCHA remembers, and what it cannot tell you about it', () => {
  const withMemory = () =>
    detail({
      memory: {
        context: {
          summary: null,
          facts: [
            {
              text: 'Had a delayed shipment in March.',
              category: 'service',
              confidence: 'high',
              // Present now, and still not drawn - the conversations behind
              // these carry origin HISTORICAL_IMPORT and a read that does not
              // name an origin returns nothing.
              evidenceConversationIds: ['conv-abc'],
            },
          ],
          messageCount: 412,
          source: 'historical_whatsapp_import',
          learnedAt: '2026-09-14T00:00:00.000Z',
          evidenceWindow: { from: '2026-03-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
        },
      },
    });

  it('shows block-level provenance - where the whole set came from', async () => {
    await show(withMemory());
    const source = screen.getByTestId('memory-source');
    expect(source).toHaveTextContent(/historical_whatsapp_import/);
    expect(source).toHaveTextContent(/412/);
  });

  it('★★ says a single fact cannot be traced, and draws no link', async () => {
    /*
     * `evidenceConversationIds` is written on every fact and returned by NO
     * route - the reachable endpoint projects each fact to text, category
     * and confidence. So 04b's "each traceable to where it was learned"
     * cannot be honoured.
     *
     * A traceability marker that cannot be followed would be worse than an
     * honest statement, so this is a sentence and there is no anchor.
     */
    const { container } = await show(withMemory());
    const note = screen.getByTestId('memory-no-trace');
    /*
     * ★ THE CLAIM CHANGED WHEN BACKEND ADDED THE FIELD.
     *
     * It used to be "we don't record which conversation this came from".
     * Now we do - and the conversations carry origin HISTORICAL_IMPORT,
     * which `applyLiveByDefault` filters out of any read that does not name
     * an origin. So a link would open an empty conversation.
     *
     * The screen must say the trace EXISTS and cannot be followed, which is
     * a different and more useful sentence than "there is no trace".
     */
    expect(note).toHaveTextContent(/records which conversation each of these came from/i);
    expect(note).toHaveTextContent(/can't be opened from here yet/i);
    // And it says the other absent write, because these are the facts
    // somebody would most want to correct.
    expect(note).toHaveTextContent(/can't be corrected or removed/i);
    // No anchor anywhere: the ids are present and must not become links.
    expect(container.querySelector('a')).toBeNull();

    // The window belongs to the SET, never to a fact - every fact in a row
    // carries identical firstSeen/lastSeen, so per fact it would be a date
    // the data cannot support.
    expect(screen.getByTestId('memory-window')).toHaveTextContent(/observed between/i);
  });

  it('distinguishes “nothing learned” from “we could not read it”', async () => {
    // Two different facts about a person, and only one of them means
    // somebody should look again.
    await show(detail({ memory: { context: null } }));
    expect(screen.getByTestId('memory-none')).toBeInTheDocument();

    screen.getByTestId('memory-none').remove();
    await show(detail({ memory: null }));
    expect(screen.getByTestId('memory-unavailable')).toHaveTextContent(/couldn't read/i);
  });
});

describe('★★ a person who has never written is a state, not four blank panels', () => {
  const never = () =>
    detail({
      brief: {
        ok: true,
        // ★ The route answers a CANNED string here, not a character study.
        summary: 'New customer with no recorded prior interactions.',
        signals: [],
        generated_at: '2026-09-24T00:00:00.000Z',
        cached: false,
        meta: {
          conversation_count: 0,
          channels: [],
          tone: null,
          mood: null,
          recommended_behaviors: [],
          reason: 'no_conversations',
        },
      },
      timeline: {
        contact: null,
        identityChannels: [],
        events: [],
        page: { limit: 50, types: ['message'], nextCursor: null, hasMore: false },
        coverage: {},
        totals: {
          conversations: 0,
          messages: 0,
          handovers: 0,
          aiActions: 0,
          conversationScanTruncated: false,
        },
      },
    });

  it('says so once, at the top', async () => {
    /*
     * Somebody imported from a CRM who has never sent a message. Four of
     * this page's sections are then UNREACHABLE rather than empty, and four
     * blank panels read as a broken page.
     */
    await show(never());
    expect(screen.getByTestId('never-written')).toHaveTextContent(/never written to you/i);
    expect(screen.getByTestId('never-written')).toHaveTextContent(/not because anything failed/i);
  });

  it('★★ does NOT italicise the canned string as a character study', async () => {
    /*
     * The route returns `ok: true` with "New customer with no recorded prior
     * interactions." - correct on their side, since a contact with no
     * history is ordinary rather than an error.
     *
     * But rendering it in the serif italic this screen reserves for a written
     * character study would present a CONSTANT as though a model had read
     * this person's history and concluded it. `hasBrief` checks `reason`
     * for exactly this.
     */
    await show(never());
    expect(screen.queryByTestId('customer-brief')).toBeNull();
    expect(screen.queryByText(/New customer with no recorded prior interactions/)).toBeNull();
  });
});

describe('★ the brief has three states, not two', () => {
  it('says there are no conversations to write one from', async () => {
    // Distinct from "we asked and there is none": one is a property of the
    // person, the other means the pipeline has not reached them.
    await show(
      detail({
        noConversations: true,
        timeline: {
          contact: null,
          identityChannels: [],
          events: [],
          page: { limit: 50, types: ['message'], nextCursor: null, hasMore: false },
          coverage: {},
          totals: {
            conversations: 0,
            messages: 0,
            handovers: 0,
            aiActions: 0,
            conversationScanTruncated: false,
          },
        },
      }),
    );
    expect(screen.getByTestId('brief-no-conversations')).toHaveTextContent(
      /no conversations with this person/i,
    );
  });

  it('does not render an empty italic paragraph for a brief with no prose', async () => {
    await show(
      detail({
        brief: {
          ok: true,
          summary: null,
          signals: [],
          generated_at: null,
          cached: false,
          meta: {
            conversation_count: null,
            channels: [],
            tone: null,
            mood: null,
            recommended_behaviors: [],
            reason: null,
          },
        },
      }),
    );
    expect(screen.queryByTestId('customer-brief')).toBeNull();
    expect(screen.getByTestId('brief-none')).toBeInTheDocument();
  });
});
