import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/customers.json';

import { CustomerDetail } from './CustomerDetail';
import type { CustomerDetail as Detail } from './load-customer';

/**
 * Screen 04b — and every assertion here is about a LIMIT.
 *
 * The screen's content is mostly the platform's own prose. What this file
 * guards is the set of things the screen must never imply: that the timeline
 * is complete, that it carries more than messages, that notes can be written,
 * or that a remembered fact can be traced to its conversation.
 *
 * Each of those is a sentence that is easy to delete and impossible to notice
 * missing — the page still renders, reads well, and is wrong.
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
  origin: 'LIVE' as const,
  ...over,
});

function detail(over: Partial<Detail> = {}): Detail {
  return {
    timeline: {
      contact: { id: 'p1', displayName: 'Dana', externalId: '+972500000000', channel: 'WHATSAPP' },
      events: [message()],
      page: { limit: 50, nextCursor: null, hasMore: false },
      totals: { conversations: 1, messages: 1, conversationScanTruncated: false },
    },
    brief: null,
    memory: null,
    noConversations: false,
    ...over,
  } as Detail;
}

const show = async (d: Detail) => render(await CustomerDetail({ detail: d }));

describe('★★ the timeline must never claim to be a history', () => {
  it('★★ says how many of the total are shown, not just how many are shown', async () => {
    /*
     * The sentence this replaces named 50 conversations × 5 messages — a
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
          events: [message()],
          page: { limit: 50, nextCursor: 'abc', hasMore: true },
          totals: { conversations: 40, messages: 1284, conversationScanTruncated: false },
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
     * Until today the timeline excluded imported history entirely —
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
          events: [message({ origin: 'HISTORICAL_IMPORT' })],
          page: { limit: 50, nextCursor: null, hasMore: false },
          totals: { conversations: 1, messages: 1, conversationScanTruncated: false },
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
          events: [message()],
          page: { limit: 50, nextCursor: null, hasMore: false },
          totals: { conversations: 500, messages: 900, conversationScanTruncated: true },
        },
      }),
    );
    expect(screen.getByTestId('timeline-scan-truncated')).toHaveTextContent(/oldest may not be/i);
  });

  it('★ says what is NOT in the stream, not only what is', async () => {
    // `type: "message"` is the whole union. A merchant reading a
    // messages-only stream headed "activity" would reasonably conclude this
    // customer never ordered anything.
    await show(detail());
    const sources = screen.getByTestId('timeline-sources');
    expect(sources).toHaveTextContent(/messages only/i);
    expect(sources).toHaveTextContent(/orders, returns and actions/i);
  });

  it('still says the cross-channel part IS real, because it is', async () => {
    // The route follows `mergedIntoId`, gathers sibling contacts and includes
    // aliases preserved from prior merges. That is the hard part and it is
    // done — hedging it would undersell the one claim that holds.
    await show(detail());
    expect(screen.getByTestId('timeline-scope')).toHaveTextContent(/every channel/i);
  });
});

describe('★★ nothing here offers a note', () => {
  it('says notes are not recorded, and draws no control at all', async () => {
    /*
     * `POST /conversations/:id/notes` echoes the note back with `Date.now()`
     * as its id and persists nothing. A box here would accept what somebody
     * wrote about a customer, show it saved, and lose it on reload.
     *
     * Not a disabled box either: the 14d shape assumes a repair the merchant
     * can perform, and there is none.
     */
    const { container } = await show(detail());
    expect(screen.getByTestId('absent-notes')).toHaveTextContent(/notes aren't recorded yet/i);
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('never renders a tenure line', async () => {
    /*
     * Three fields look like tenure and all three undersell a long-standing
     * customer — `customer-card.ts` names them itself. A line saying a
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
              // Present now, and still not drawn — the conversations behind
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

  it('shows block-level provenance — where the whole set came from', async () => {
    await show(withMemory());
    const source = screen.getByTestId('memory-source');
    expect(source).toHaveTextContent(/historical_whatsapp_import/);
    expect(source).toHaveTextContent(/412/);
  });

  it('★★ says a single fact cannot be traced, and draws no link', async () => {
    /*
     * `evidenceConversationIds` is written on every fact and returned by NO
     * route — the reachable endpoint projects each fact to text, category
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
     * Now we do — and the conversations carry origin HISTORICAL_IMPORT,
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

    // The window belongs to the SET, never to a fact — every fact in a row
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

describe('★ the brief has three states, not two', () => {
  it('says there are no conversations to write one from', async () => {
    // Distinct from "we asked and there is none": one is a property of the
    // person, the other means the pipeline has not reached them.
    await show(
      detail({
        noConversations: true,
        timeline: {
          contact: null,
          events: [],
          page: { limit: 50, nextCursor: null, hasMore: false },
          totals: { conversations: 0, messages: 0, conversationScanTruncated: false },
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
          },
        },
      }),
    );
    expect(screen.queryByTestId('customer-brief')).toBeNull();
    expect(screen.getByTestId('brief-none')).toBeInTheDocument();
  });
});
