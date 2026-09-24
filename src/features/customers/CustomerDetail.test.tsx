import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { TIMELINE_CONVERSATION_CAP } from '@/api/contracts/customer-detail';
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
  ...over,
});

function detail(over: Partial<Detail> = {}): Detail {
  return {
    timeline: {
      contact: { id: 'p1', displayName: 'Dana', externalId: '+972500000000', channel: 'WHATSAPP' },
      events: [message()],
    },
    brief: null,
    memory: null,
    noConversations: false,
    ...over,
  } as Detail;
}

const show = async (d: Detail) => render(await CustomerDetail({ detail: d }));

describe('★★ the timeline must never claim to be a history', () => {
  it('states the rule in numbers on every non-empty timeline', async () => {
    /*
     * `identity.ts:233,237` — 50 conversations, newest 5 messages each, and
     * the payload says so nowhere. Under the design's words — "her whole
     * history", "every channel in one thread" — that is a claim of
     * completeness the data cannot support.
     *
     * Stated ALWAYS, not only when a cap is provably hit: the payload cannot
     * distinguish a conversation that had five messages from one that had
     * five hundred.
     */
    await show(detail());
    const limit = screen.getByTestId('timeline-limit');
    expect(limit).toHaveTextContent(/not the full history/i);
    expect(limit).toHaveTextContent(/most recent 5 messages/i);
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

  it('adds a stronger marker once the conversation cap is reached', async () => {
    const events = Array.from({ length: TIMELINE_CONVERSATION_CAP }, (_, i) =>
      message({ conversationId: `c${i}` }),
    );
    await show(detail({ timeline: { contact: null, events } }));
    expect(screen.getByTestId('timeline-capped')).toHaveTextContent(/older ones exist/i);
  });

  it('does NOT claim conversations are capped when they are not', async () => {
    // The inverse direction, so the marker is a statement about the data
    // rather than decoration that is always on.
    await show(detail());
    expect(screen.queryByTestId('timeline-capped')).toBeNull();
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
            { text: 'Had a delayed shipment in March.', category: 'service', confidence: 'high' },
          ],
          messageCount: 412,
          source: 'historical_whatsapp_import',
          learnedAt: '2026-09-14T00:00:00.000Z',
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
    expect(note).toHaveTextContent(/can't be traced to the individual conversation/i);
    // And it says the other absent write, because these are the facts
    // somebody would most want to correct.
    expect(note).toHaveTextContent(/can't be corrected or removed/i);
    expect(container.querySelector('a')).toBeNull();
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
    await show(detail({ noConversations: true, timeline: { contact: null, events: [] } }));
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
