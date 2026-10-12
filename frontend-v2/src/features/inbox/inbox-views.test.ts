import { describe, expect, it } from 'vitest';

import {
  inboxQuery,
  INBOX_VIEW_IDS,
  parseChannelFilter,
  DEFAULT_INBOX_VIEW,
  parseInboxView,
  shownView,
  QUEUE_CHANNEL_FILTERS,
  parsePeriod,
  retiredView,
  VIEW_AFTER,
  viewAfter,
  viewQuery,
  FALLBACK_FILTER_CHIPS,
  filterChips,
} from './inbox-views';
import enNav from '@/i18n/messages/en/navigation.json';
import heNav from '@/i18n/messages/he/navigation.json';

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

  it('★★ "Handled by GOTCHA" asks for `automatedOnly` and nothing else', () => {
    /*
     * The route's `automatedOnly` is already "the AI's or a flow's, nobody
     * holding it, not closed" (conversation.service.ts:131,155-170), and it
     * reads no `handledBy`. So the merged view is that one parameter - a
     * `handledBy` beside it would be a filter the route throws away, written
     * as if it narrowed something.
     */
    expect(viewQuery('gotcha', null)).toEqual({ automatedOnly: 'true' });
  });
});

describe('★ an unknown view is the default, never an error page', () => {
  it('falls back for absent, empty and invented values', () => {
    for (const raw of [undefined, '', 'archived', 'QUEUE', '../admin']) {
      expect(parseInboxView(raw), String(raw)).toBe('mine');
    }
  });

  it('★★ `ai` and `flow` - the two views it replaced - mean the GOTCHA view, not the queue', () => {
    for (const old of ['ai', 'flow']) {
      expect(parseInboxView(old), old).toBe('gotcha');
      expect(retiredView(old), old).toBe('gotcha');
    }
    // Only those two: a live view, an invented one or nothing is not "retired".
    for (const raw of [undefined, '', 'gotcha', 'queue', 'AI', 'toString', '__proto__']) {
      expect(retiredView(raw), String(raw)).toBeNull();
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
      'GMAIL',
      'OUTLOOK',
      'WEBCHAT',
      'SHOPIFY_LIVE_CHAT',
    ]);
    for (const id of QUEUE_CHANNEL_FILTERS) expect(parseChannelFilter(id)).toBe(id);
  });

  it('⚠ and anything else is "All" - including real channels with no chip', () => {
    // A narrowed list with no chip lit would say nothing about what narrowed it.
    for (const raw of [undefined, '', 'SLACK', 'whatsapp', 'VOICE', 'shopify_live_chat']) {
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

  it('leaves out what is already the default ("Assigned to me"), and never a cursor', () => {
    expect(inboxQuery({ view: 'mine', channel: null })).toEqual({});
    expect(inboxQuery({ view: 'mine', channel: null, c: null })).toEqual({});
  });

  it('★★ the queue is NAMED now - a bare /inbox is "Assigned to me" (Omer, 2026-10-11)', () => {
    expect(DEFAULT_INBOX_VIEW).toBe('mine');
    expect(inboxQuery({ view: 'queue', channel: null })).toEqual({ view: 'queue' });
  });

  it('★ the default with an unknown viewer shows "Active"; a named "mine" stays "mine"', () => {
    expect(shownView('mine', false, false)).toBe('active');
    expect(shownView('mine', true, false)).toBe('mine');
    expect(shownView('mine', false, true)).toBe('mine');
    // Only "mine" needs a viewer.
    expect(shownView('queue', false, false)).toBe('queue');
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

describe('★★ "all" - every conversation, as an assistant counts them (Backend, 2026-10-08)', () => {
  it('open and closed, the AI’s and the flows’ too: no status, automated included', () => {
    expect(parseInboxView('all')).toBe('all');
    expect(viewQuery('all', null)).toEqual({ includeAutomated: 'true' });
  });

  it('★ the period link keeps it: a chip, a row, the period’s ×', () => {
    expect(
      inboxQuery({ view: 'all', channel: null, period: { from: '2026-09-01', to: '2026-09-30' } }),
    ).toEqual({ view: 'all', from: '2026-09-01', to: '2026-09-30' });
  });
});

describe('★★ one view for what GOTCHA handles, not two (Omer, 2026-10-11)', () => {
  it('★★ the views are six, and neither "AI managed" nor "Flow managed" is one', () => {
    // The rail's own list is asserted in shell/navigation.test.ts (the shell may not import this).
    expect(INBOX_VIEW_IDS).toEqual(['queue', 'mine', 'active', 'gotcha', 'resolved', 'all']);
  });

  it('★★ named in both languages, with the gershayim and no old label left', () => {
    expect(enNav.inbox).toMatchObject({ gotcha: 'Handled by GOTCHA' });
    expect(heNav.inbox).toMatchObject({ gotcha: 'מנוהל ע\u05f4י GOTCHA' });
    for (const nav of [enNav.inbox, heNav.inbox]) {
      expect(Object.keys(nav)).not.toContain('ai');
      expect(Object.keys(nav)).not.toContain('flow');
    }
  });
});

describe('★★ a verb takes the list to where the conversation now is', () => {
  it('★★ Take control lands on "Assigned to me" - claim makes the viewer the assignee', () => {
    expect(VIEW_AFTER.claim).toBe('mine');
    // And that view holds a claimed conversation whatever its status or handler.
    expect(viewQuery('mine', 'u7')).toEqual({ assignedAgentId: 'u7', includeAutomated: 'true' });
  });

  it('★★ Return to the AI lands on "Handled by GOTCHA"', () => {
    expect(VIEW_AFTER.returnToAi).toBe('gotcha');
  });

  it('★ the viewer unknown: a claim lands on "Active", which needs no "me"; return is unchanged', () => {
    expect(viewQuery('mine', null)).toBeNull();
    expect(viewAfter('claim', false)).toBe('active');
    expect(viewAfter('claim', true)).toBe('mine');
    expect(viewAfter('returnToAi', false)).toBe('gotcha');
    expect(viewAfter('returnToAi', true)).toBe('gotcha');
  });
});

describe('★★ I2 - only the channels this workspace has (Omer, 2026-10-12)', () => {
  const state = (channel: string, connectionStatus = 'CONNECTED', isActive = true) => ({
    channel,
    connectionStatus,
    isActive,
  });

  it('★★ a chip per connected channel - or connected and failing; never pending, gone or off', () => {
    const chips = filterChips(
      [
        state('WHATSAPP'),
        state('INSTAGRAM', 'ERROR'),
        state('MESSENGER', 'DISCONNECTED'),
        state('WEBCHAT', 'PENDING'),
        state('SHOPIFY_LIVE_CHAT', 'CONNECTED', false),
      ],
      false,
      null,
    );
    expect(chips.map((c) => c.channel)).toEqual(['WHATSAPP', 'INSTAGRAM']);
  });

  it('★★ email wears its provider: Gmail, Outlook, or plain mail - never Gmail it is not', () => {
    expect(filterChips([state('GMAIL')], false, null)).toEqual([
      { channel: 'GMAIL', mark: 'GMAIL' },
    ]);
    expect(filterChips([state('OUTLOOK')], false, null)).toEqual([
      { channel: 'OUTLOOK', mark: 'OUTLOOK' },
    ]);
    expect(filterChips([state('EMAIL')], false, null)).toEqual([
      { channel: 'EMAIL', mark: 'EMAIL' },
    ]);
  });

  it('★★ the site’s chat follows its store: Woo’s mark on web chat, Shopify’s chat its own', () => {
    expect(filterChips([state('WEBCHAT')], true, null)).toEqual([
      { channel: 'WEBCHAT', mark: 'WOOCOMMERCE' },
    ]);
    expect(filterChips([state('WEBCHAT')], false, null)).toEqual([
      { channel: 'WEBCHAT', mark: 'WEBCHAT' },
    ]);
    expect(filterChips([state('SHOPIFY_LIVE_CHAT')], true, null)).toEqual([
      { channel: 'SHOPIFY_LIVE_CHAT', mark: 'SHOPIFY_LIVE_CHAT' },
    ]);
  });

  it('★ the chip in force is drawn, connected or not', () => {
    expect(filterChips([state('WHATSAPP')], false, 'MESSENGER').map((c) => c.channel)).toEqual([
      'WHATSAPP',
      'MESSENGER',
    ]);
  });

  it('★ channels unread: the row as it was, never an empty one', () => {
    expect(filterChips(null, true, null)).toBe(FALLBACK_FILTER_CHIPS);
    expect(FALLBACK_FILTER_CHIPS.map((c) => c.channel)).toEqual([
      'WHATSAPP',
      'INSTAGRAM',
      'MESSENGER',
      'EMAIL',
      'WEBCHAT',
      'SHOPIFY_LIVE_CHAT',
    ]);
  });

  it('in 02’s order whatever order the read gives', () => {
    expect(
      filterChips([state('WEBCHAT'), state('GMAIL'), state('WHATSAPP')], false, null).map(
        (c) => c.channel,
      ),
    ).toEqual(['WHATSAPP', 'GMAIL', 'WEBCHAT']);
  });
});
