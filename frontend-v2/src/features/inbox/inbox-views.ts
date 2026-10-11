/**
 * What each inbox view asks the conversation service for.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THE VIEWS DID NOT FILTER. AT ALL. THE PAGE NEVER READ `view`.
 * ════════════════════════════════════════════════════════════════════════════
 * The rail wrote `?view=resolved`, highlighted the right item, and the page -
 * whose `searchParams` declared only `c` and `cursor` - ignored it. "Resolved"
 * showed open conversations; "Assigned to me" showed nine that were not.
 * Not a styling defect; it predates the redesign.
 *
 * ★★ AND THE ROUTE COULD ALWAYS FILTER. The OpenAPI lists no query parameters
 *    for `GET /api/conversations` - but it lists neither `limit` nor `cursor`
 *    either, and we send both. The handler destructures its query by hand:
 *
 *      status, assignedAgentId, channel, departmentId, search, page, limit,
 *      cursor, includeAutomated, automatedOnly
 *      - services/conversation/src/routes/conversations.ts:71
 *
 *    Trusting the spec's silence would have meant filtering client-side, over
 *    ONE page of ten, silently missing every match on the pages after it.
 *
 * ★★ ONE VIEW FOR WHAT GOTCHA HANDLES (Omer, 2026-10-11). There were two,
 *   "AI managed" and "Flow managed", and the route could never tell them
 *   apart: `automatedOnly=true` is `handledBy IN ["ai_agent","flow"]`, not
 *   handed over, nobody assigned, not closed
 *   (services/conversation/src/services/conversation.service.ts:131,155-170),
 *   and the route reads no `handledBy` (routes/conversations.ts:75). Both
 *   showed the same list under two names. `gotcha` is that one list, under
 *   one name - and it needs no backend change, because it is exactly what
 *   `automatedOnly` already returns.
 */

export const INBOX_VIEW_IDS = ['queue', 'mine', 'active', 'gotcha', 'resolved', 'all'] as const;
export type InboxView = (typeof INBOX_VIEW_IDS)[number];

/**
 * The two views `gotcha` replaced. A bookmark, a shared link or an old tab
 * still says `?view=ai` or `?view=flow`; it lands on the merged view, never
 * on the queue as if the reader had asked for nothing.
 */
const RETIRED_VIEWS: Readonly<Record<string, InboxView>> = { ai: 'gotcha', flow: 'gotcha' };

/** The view a retired `?view=` now means, or null when it is not a retired one. */
export function retiredView(raw: string | undefined): InboxView | null {
  return Object.hasOwn(RETIRED_VIEWS, raw ?? '') ? RETIRED_VIEWS[raw!]! : null;
}

/** An unknown or absent `?view=` is the default, never an error page. */
export function parseInboxView(raw: string | undefined): InboxView {
  const retired = retiredView(raw);
  if (retired !== null) return retired;
  return (INBOX_VIEW_IDS as readonly string[]).includes(raw ?? '') ? (raw as InboxView) : 'queue';
}

/**
 * The query for one view.
 *
 * ⚠ `mine` needs the viewer's platform id, which only `/auth/me` knows. It is
 *   the one view whose list genuinely depends on another read - see
 *   `loadInbox`, which waits for `me` for this view and no other.
 *
 * @returns null for `mine` when the viewer is unknown: there is no honest
 *          query for "assigned to me" without knowing who "me" is, and an
 *          unfiltered list under that heading is the defect being fixed.
 */
export function viewQuery(view: InboxView, meId: string | null): Record<string, string> | null {
  switch (view) {
    case 'queue':
      /*
       * Exactly "waiting for a person" (Backend 7b12ac06): open, unassigned,
       * not a rehearsal, not the AI's or a flow's unless handed over - the
       * same predicate as Home's number. A service that predates the view
       * ignores the parameter and answers its old default, as before.
       */
      return { view: 'queue' };
    case 'mine':
      // Everything assigned to the viewer, whoever is driving it.
      return meId === null ? null : { assignedAgentId: meId, includeAutomated: 'true' };
    case 'active':
      return { status: 'OPEN' };
    case 'all':
      /*
       * Every conversation, open or closed, the AI's and the flows' too - what
       * an assistant's count means ("81 conversations in September"). Reached
       * by its links (with a period), not a rail item: 02's rail is its six.
       */
      return { includeAutomated: 'true' };
    case 'resolved':
      // A conversation the AI closed is still resolved.
      return { status: 'CLOSED', includeAutomated: 'true' };
    case 'gotcha':
      /*
       * What GOTCHA handles, by the AI or by a flow: the route's own
       * `automatedOnly`, which already means both and nothing a person holds.
       */
      return { automatedOnly: 'true' };
  }
}

/**
 * The queue header's channel filters, in 02's order - and Shopify's chat
 * after the web chat (Backend, 2026-10-08: 17 of 88 real conversations on
 * dev were out of reach of every chip).
 *
 * ★ 02's own rule: "Channel filters are icons; advanced filters (intent,
 *   team, agent, owner type, wait time, customer attributes) stay behind
 *   'Filters' and are off by default." So these five are real filters, sent
 *   as the route's `channel` - not decoration over an unfiltered list.
 *
 * ⚠ The route matches ONE exact value. "Email" is `EMAIL` and does not
 *   include `GMAIL` or `OUTLOOK`; "Web chat" is `WEBCHAT` and does not include
 *   `SHOPIFY_LIVE_CHAT`. Grouping them needs the route to accept a list.
 */
export const QUEUE_CHANNEL_FILTERS = [
  'WHATSAPP',
  'INSTAGRAM',
  'MESSENGER',
  'EMAIL',
  'WEBCHAT',
  'SHOPIFY_LIVE_CHAT',
] as const;
export type QueueChannelFilter = (typeof QUEUE_CHANNEL_FILTERS)[number];

/**
 * `?channel=`, or null for "All".
 *
 * ⚠ Only the ones the header draws. A filter with no chip lit would leave the
 *   reader looking at a narrowed list with "All" unselected and nothing
 *   saying what narrowed it.
 */
export function parseChannelFilter(raw: string | undefined): QueueChannelFilter | null {
  return (QUEUE_CHANNEL_FILTERS as readonly string[]).includes(raw ?? '')
    ? (raw as QueueChannelFilter)
    : null;
}

/**
 * The query for a link inside the inbox, keeping where the reader is.
 *
 * ⚠⚠ A ROW'S LINK WAS `{ c }` AND NOTHING ELSE. Opening a conversation from
 *    "Resolved" dropped `view`, so the list behind it snapped back to the
 *    queue - the view the reader had just chosen, undone by the click that
 *    used it. Every inbox link goes through here so none can forget one.
 *
 * ★ `cursor` is never carried: a new filter or a new view starts at page one.
 */
export function inboxQuery(state: {
  readonly view: InboxView;
  readonly channel: QueueChannelFilter | null;
  readonly c?: string | null;
  /** The period the list is narrowed to; kept by every link, like the channel. */
  readonly period?: InboxPeriod | null;
}): Record<string, string> {
  return {
    ...(state.view === 'queue' ? {} : { view: state.view }),
    ...(state.channel === null ? {} : { channel: state.channel }),
    ...(state.period?.from ? { from: state.period.from } : {}),
    ...(state.period?.to ? { to: state.period.to } : {}),
    ...(state.c ? { c: state.c } : {}),
  };
}

/**
 * A period over the inbox (Backend, 2026-10-08): `from` / `to` as
 * YYYY-MM-DD in the workspace's days, `to` inclusive, either end open. The
 * assistant's sources link here ("Conversations in September").
 */
export interface InboxPeriod {
  readonly from: string | null;
  readonly to: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: string) => {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  // A real calendar day: 2026-02-30 parses, and is not one.
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/**
 * `?from=&to=`: none - `null`; a period the route will take - it; anything
 * else - `'invalid'`. Never quietly "all": a link that asked for September
 * and showed everything would answer a question nobody asked (the route
 * itself answers 400 invalid_period, never all).
 */
export function parsePeriod(
  from: string | undefined,
  to: string | undefined,
): InboxPeriod | 'invalid' | null {
  const f = from?.trim() || null;
  const t = to?.trim() || null;
  if (f === null && t === null) return null;
  if ((f !== null && !isDay(f)) || (t !== null && !isDay(t))) return 'invalid';
  if (f !== null && t !== null && f > t) return 'invalid';
  return { from: f, to: t };
}
