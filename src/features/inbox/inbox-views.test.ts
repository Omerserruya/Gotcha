import { describe, expect, it } from 'vitest';

import {
  inboxQuery,
  INBOX_VIEW_IDS,
  parseChannelFilter,
  parseInboxView,
  QUEUE_CHANNEL_FILTERS,
  parsePeriod,
  viewQuery,
} from './inbox-views';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THE VIEWS DID NOT FILTER - THE PAGE NEVER READ `view`
 * ════════════════════════════════════════════════════════════════════════════
 * "Resolved" showed open conversations; "Assigned to me" showed nine that were
 * not. The route could filter all along - `conversations.ts:71` destructures
 * `status, assignedAgentId, … includeAutomated, automatedOnly` - and the
 * OpenAPI simply never listed them.
 */
describe('★★ each view asks the route for what its name says', () => {
  it('⚠⚠ Resolved asks for CLOSED, which is exactly what it was not doing', () => {
    expect(viewQuery('resolved', null)).toMatchObject({ status: 'CLOSED' });
  });

  it('⚠⚠ Assigned to me asks for the viewer’s id', () => {
    expect(viewQuery('mine', 'u7')).toMatchObject({ assignedAgentId: 'u7' });
  });

  it('⚠⚠ and with no viewer there is NO query, not an unfiltered one', () => {
    /*
     * An unfiltered list under the heading "Assigned to me" is the defect
     * being fixed. There is no honest query for "me" without knowing who that
     * is, so the answer is null - the list reports it could not read.
     */
    expect(viewQuery('mine', null)).toBeNull();
  });

  it('★ Active asks for OPEN', () => {
    expect(viewQuery('active', null)).toEqual({ status: 'OPEN' });
  });

  it('★ the default queue names itself, so the route can count it (`viewTotal`)', () => {
    // An older service ignores the parameter and answers as before.
    expect(viewQuery('queue', null)).toEqual({ view: 'queue' });
  });

  it('⚠⚠ AI and Flow send `handledBy`, which the route does not read YET', () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE ROUTE CANNOT SEPARATE THEM, AND THIS IS STATED RATHER THAN HIDDEN
     * ════════════════════════════════════════════════════════════════════════
     * `automatedOnly` returns both - `AUTOMATED_HANDLERS = ["ai_agent",
     * "flow"]`. The route ignores an unknown query key today, so sending
     * `handledBy` is harmless now and exact the moment the route accepts it.
     *
     * ⚠ Filtering on the CLIENT would be correct on page one and wrong on
     *   every page after: a page of ten automated rows could be all flow,
     *   showing an empty "AI managed" while AI rows sit on page two.
     */
    expect(viewQuery('ai', null)).toEqual({ automatedOnly: 'true', handledBy: 'ai_agent' });
    expect(viewQuery('flow', null)).toEqual({ automatedOnly: 'true', handledBy: 'flow' });
  });
});

describe('★ an unknown view is the default, never an error page', () => {
  it('falls back for absent, empty and invented values', () => {
    for (const raw of [undefined, '', 'archived', 'QUEUE', '../admin']) {
      expect(parseInboxView(raw), String(raw)).toBe('queue');
    }
  });

  it('★★ and accepts every view the rail can write', () => {
    // Both directions: a parser that only knew `queue` would satisfy the test
    // above and turn every rail item back into the bug.
    for (const id of INBOX_VIEW_IDS) expect(parseInboxView(id)).toBe(id);
  });
});

describe('★ the channel filter is one of the chips the header draws', () => {
  it("accepts each of them, in 02's order", () => {
    expect(QUEUE_CHANNEL_FILTERS).toEqual([
      'WHATSAPP',
      'INSTAGRAM',
      'MESSENGER',
      'EMAIL',
      'WEBCHAT',
      'SHOPIFY_LIVE_CHAT',
    ]);
    for (const id of QUEUE_CHANNEL_FILTERS) expect(parseChannelFilter(id)).toBe(id);
  });

  it('⚠ and anything else is "All" - including real channels with no chip', () => {
    // A narrowed list with no chip lit would say nothing about what narrowed it.
    for (const raw of [undefined, '', 'GMAIL', 'whatsapp', 'OUTLOOK', 'shopify_live_chat']) {
      expect(parseChannelFilter(raw), String(raw)).toBeNull();
    }
  });
});

describe('⚠⚠ an inbox link keeps where the reader is', () => {
  it('★★ carries the view and the channel along with the conversation', () => {
    // The row link was `{ c }` alone: opening one from Resolved snapped the
    // list back to the queue.
    expect(inboxQuery({ view: 'resolved', channel: 'EMAIL', c: 'c9' })).toEqual({
      view: 'resolved',
      channel: 'EMAIL',
      c: 'c9',
    });
  });

  it('leaves out what is already the default, and never a cursor', () => {
    expect(inboxQuery({ view: 'queue', channel: null })).toEqual({});
    expect(inboxQuery({ view: 'queue', channel: null, c: null })).toEqual({});
  });
});

describe('★★ a period over the inbox (Backend, 2026-10-08)', () => {
  it('none: null; a real one, either end open: kept as given', () => {
    expect(parsePeriod(undefined, undefined)).toBeNull();
    expect(parsePeriod('', ' ')).toBeNull();
    expect(parsePeriod('2026-09-01', '2026-09-30')).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(parsePeriod('2026-09-01', undefined)).toEqual({ from: '2026-09-01', to: null });
    expect(parsePeriod(undefined, '2026-09-30')).toEqual({ from: null, to: '2026-09-30' });
    expect(parsePeriod('2026-09-01', '2026-09-01')).toEqual({
      from: '2026-09-01',
      to: '2026-09-01',
    });
  });

  it('★ anything the route would refuse is invalid - never quietly "all"', () => {
    for (const [from, to] of [
      ['2026-09-30', '2026-09-01'],
      ['2026-02-30', undefined],
      ['2026-9-1', undefined],
      ['yesterday', undefined],
      [undefined, '2026-13-01'],
    ] as const) {
      expect(parsePeriod(from, to), `${from}..${to}`).toBe('invalid');
    }
  });

  it('every link keeps it, like the channel; clearing it keeps the rest', () => {
    const period = { from: '2026-09-01', to: '2026-09-30' };
    expect(inboxQuery({ view: 'resolved', channel: 'WHATSAPP', period, c: 'c1' })).toEqual({
      view: 'resolved',
      channel: 'WHATSAPP',
      from: '2026-09-01',
      to: '2026-09-30',
      c: 'c1',
    });
    expect(inboxQuery({ view: 'resolved', channel: 'WHATSAPP', period: null })).toEqual({
      view: 'resolved',
      channel: 'WHATSAPP',
    });
  });
});
