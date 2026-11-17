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

export const INBOX_VIEW_IDS = [
  'queue',
  'mine',
  'active',
  'gotcha',
  'resolved',
  'all',
  'open',
  'irrelevant',
] as const;
export type InboxView = (typeof INBOX_VIEW_IDS)[number];

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ ONE PERSON, ONE VIEW (Omer, 2026-11-15)
 * ════════════════════════════════════════════════════════════════════════════
 * In a workspace with one person (`/auth/me`'s `workspace.soleHuman`),
 * "Waiting in queue", "Assigned to me" and "Active" are one list: a handoff
 * is assigned to that person at once (Backend's auto-assign, by the same
 * predicate as the flag), so nothing waits and everything open is theirs.
 * They become `open`: every conversation not resolved, except the ones
 * GOTCHA handles alone - which keep their own view. Open + GOTCHA +
 * Resolved is everything.
 *
 * ⚠ NOT "active". `active` is status OPEN with the default automated
 *   exclusion: it misses WAITING, and a conversation assigned to the person
 *   while still driven by the AI (a claim that never flipped the latch).
 *   `open` is the route's own `view=open`, defined by Backend for this.
 */
export const SOLO_MERGED_VIEWS: readonly InboxView[] = ['queue', 'mine', 'active'];

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ PERSONAL AND NOT RELEVANT (Omer, 2026-11-17, `INBOX_RELEVANCE`)
 * ════════════════════════════════════════════════════════════════════════════
 * The platform labels each conversation (`relevance.ts`). What it, or a
 * person, says is personal, a notice or marketing has its own view,
 * `irrelevant` (the route's `view=irrelevant`), after "Handled by GOTCHA".
 * The main views ask the route to leave it out (`hideIrrelevant=true`), so
 * the lists and their counts no longer hold it. "Resolved" and "All" keep
 * it: they are records, not work.
 *
 * ⚠⚠ ALL OF IT ONLY WITH THE FLAG ON. Off, no view, no count (an unknown
 *    view 400s the whole count read), no parameter: the inbox is today's.
 */
export const HIDES_IRRELEVANT: readonly InboxView[] = ['queue', 'mine', 'active', 'open', 'gotcha'];

/**
 * A view's query with the relevance rule applied: the route's
 * `hideIrrelevant` on the main views, with the flag on. Wraps `viewQuery` or
 * `phoneViewQuery`, so the website and the phone mean one thing by a view.
 */
export function withRelevance(
  queryOf: (view: InboxView, meId: string | null) => Record<string, string> | null,
  relevance: boolean,
): (view: InboxView, meId: string | null) => Record<string, string> | null {
  if (!relevance) return queryOf;
  return (view, meId) => {
    const query = queryOf(view, meId);
    return query !== null && HIDES_IRRELEVANT.includes(view)
      ? { ...query, hideIrrelevant: 'true' }
      : query;
  };
}

/** The views the inbox offers, in the rail's order. The phone adds "All" first. */
export function railViews(soleHuman: boolean, relevance = false): readonly InboxView[] {
  const tail: readonly InboxView[] = relevance
    ? ['gotcha', 'irrelevant', 'resolved']
    : ['gotcha', 'resolved'];
  return soleHuman ? ['open', ...tail] : ['queue', 'mine', 'active', ...tail];
}

/**
 * The view a one-person workspace shows instead of `view`, or null when it
 * shows `view` itself. Never anything for a team.
 */
export function soloView(view: InboxView, soleHuman: boolean): InboxView | null {
  return soleHuman && SOLO_MERGED_VIEWS.includes(view) ? 'open' : null;
}

/**
 * The views whose sizes the page asks the count route for.
 *
 * ⚠ `open` ONLY FOR ONE PERSON. The route answers 400 to a view it does not
 *   know, and then EVERY count in the rail is gone - so a team inbox never
 *   asks for it. Backend ships the flag and the view in one change, so a
 *   workspace that says `soleHuman` is served by a route that knows `open`.
 */
export function countViews(soleHuman: boolean, relevance = false): readonly InboxView[] {
  return [...railViews(soleHuman, relevance), 'all'];
}

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

/**
 * The inbox with no `?view=`: "Assigned to me" (Omer, 2026-10-11) - what the
 * reader holds, before the queue of what nobody does. Every bare `/inbox`
 * link follows it; a link that means the queue says `?view=queue`.
 *
 * ⚠ "Assigned to me" needs `/auth/me`. When it cannot be read, a bare inbox
 *   shows "Active" instead (`loadInbox`'s `unknownViewer`), the same rule as
 *   Take control's landing - never a list that can only say it could not read.
 */
export const DEFAULT_INBOX_VIEW: InboxView = 'mine';

/**
 * The view a list is actually of: the one asked for - except the DEFAULT
 * "mine" when the viewer is unknown, which is "Active". An explicit
 * `?view=mine` keeps its honest "could not read": that is what was asked.
 */
export function shownView(
  view: InboxView,
  explicit: boolean,
  meKnown: boolean,
  /** One person (`soleHuman`): the bare inbox is "Open". Known only when `me` is. */
  soleHuman = false,
): InboxView {
  if (!explicit && soleHuman) return soloView(view, true) ?? view;
  return view === 'mine' && !explicit && !meKnown ? 'active' : view;
}

/**
 * An unknown or absent `?view=` is the default, never an error page - and so
 * is `irrelevant` with the relevance view off: the route would not know it.
 */
export function parseInboxView(raw: string | undefined, relevance = false): InboxView {
  const retired = retiredView(raw);
  if (retired !== null) return retired;
  if (raw === 'irrelevant' && !relevance) return DEFAULT_INBOX_VIEW;
  return (INBOX_VIEW_IDS as readonly string[]).includes(raw ?? '')
    ? (raw as InboxView)
    : DEFAULT_INBOX_VIEW;
}

/**
 * Where a conversation lives once a verb has moved it, so the list follows it
 * there (Omer, 2026-10-11).
 *
 *   claim       `assignedAgentId = me`, `isHandedOver = true`
 *               (conversation.service.ts `claim`). "Assigned to me" asks for
 *               exactly `assignedAgentId=<me>` with automated rows included
 *               and no status, so it holds the conversation whatever its
 *               status or handler. "Active" would drop a closed one.
 *   returnToAi  `handledBy = ai_agent`, `isHandedOver = false`, no assignee,
 *               `OPEN` (`returnToAi` through `recordHandover`): every
 *               condition of `automatedOnly`, which is the GOTCHA view.
 */
export const VIEW_AFTER = {
  claim: 'mine',
  returnToAi: 'gotcha',
} as const satisfies Record<string, InboxView>;

/**
 * Where to take the list after a verb, for this viewer.
 *
 * ★ "Assigned to me" needs to know who "me" is (`viewQuery` answers null
 *   for `mine` without it), so when `/auth/me` could not be read the claim
 *   lands on "Active" instead - an open conversation is there whoever holds
 *   it - rather than on a list that can only say it could not read
 *   (supervisor, 2026-10-11).
 */
export function viewAfter(
  verb: keyof typeof VIEW_AFTER,
  meKnown: boolean,
  /** One person: a claimed conversation is in "Open", the one view that holds it. */
  soleHuman = false,
): InboxView {
  if (verb === 'claim' && soleHuman) return 'open';
  if (verb === 'claim' && !meKnown) return 'active';
  return VIEW_AFTER[verb];
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
    case 'open':
      /*
       * One person's whole inbox (Backend, 2026-11-15): not CLOSED (OPEN and
       * WAITING), minus exactly what `automatedOnly` returns. The route's own
       * predicate, so the list and the count route's `open` agree.
       */
      return { view: 'open' };
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
    case 'irrelevant':
      /*
       * Personal, a notice or marketing, by the platform or by a person
       * (Backend, 2026-11-17): any status, automated ones included.
       */
      return { view: 'irrelevant' };
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
  'GMAIL',
  'OUTLOOK',
  'WEBCHAT',
  'SHOPIFY_LIVE_CHAT',
] as const;
export type QueueChannelFilter = (typeof QUEUE_CHANNEL_FILTERS)[number];

/** One chip in the filter row: what it filters, and the mark it wears. */
export interface FilterChip {
  readonly channel: QueueChannelFilter;
  /** A channel's mark, or `WOOCOMMERCE` - web chat on a WooCommerce store. */
  readonly mark: string;
}

/**
 * When the channels could not be read: the row as it was before I2, one chip
 * per kind - never an empty row that would hide every filter.
 */
export const FALLBACK_FILTER_CHIPS: readonly FilterChip[] = (
  ['WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'EMAIL', 'WEBCHAT', 'SHOPIFY_LIVE_CHAT'] as const
).map((channel) => ({ channel, mark: channel }));

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ ONLY THE CHANNELS THIS WORKSPACE HAS (Omer, 2026-10-12, I2)
 * ════════════════════════════════════════════════════════════════════════════
 * A chip per channel that is connected - or connected and failing (`ERROR`):
 * its conversations are still here, and it is the one most worth filtering
 * to. Not one that is pending or was disconnected, and not one switched off.
 *
 * Email wears its provider's mark because it IS its provider's channel: a
 * Gmail mailbox is `GMAIL`, Outlook `OUTLOOK`, any other `EMAIL` (generic).
 * Never Gmail for a mailbox that is not one (supervisor, 2026-10-12).
 *
 * The site's chat follows what it is on: Shopify's is its own channel
 * (`SHOPIFY_LIVE_CHAT`, Shopify's mark); web chat on a WooCommerce store wears
 * Woo's; otherwise the website's globe.
 *
 * The chip in force is always drawn, connected or not: a narrowed list with
 * no chip lit would hide what narrowed it.
 */
export function filterChips(
  states:
    | readonly {
        readonly channel: string;
        readonly connectionStatus: string;
        readonly isActive: boolean;
      }[]
    | null,
  wooConnected: boolean,
  /** The one in force, or the phone's several. */
  current: QueueChannelFilter | readonly QueueChannelFilter[] | null,
): readonly FilterChip[] {
  if (states === null) return FALLBACK_FILTER_CHIPS;
  const live = new Set(
    states
      .filter(
        (s) => s.isActive && (s.connectionStatus === 'CONNECTED' || s.connectionStatus === 'ERROR'),
      )
      .map((s) => s.channel),
  );
  const forced = new Set<string>(
    current === null ? [] : typeof current === 'string' ? [current] : current,
  );
  return QUEUE_CHANNEL_FILTERS.filter((channel) => live.has(channel) || forced.has(channel)).map(
    (channel) => ({
      channel,
      mark: channel === 'WEBCHAT' && wooConnected ? 'WOOCOMMERCE' : channel,
    }),
  );
}

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
 * The phone's `?channel=a,b` (2026-11-03): the channels ticked in its sheet,
 * in the header's order, each one the header draws. Unknown values are
 * dropped one by one rather than voiding the list - and an empty answer is
 * "All", as `parseChannelFilter`'s null is.
 *
 * ★ PHONE ONLY. The website's header is a choice of one and keeps
 *   `parseChannelFilter`; the route takes either (one value is today's
 *   exact match, several are `{ in }`, conversation `lib/channel-filter.ts`).
 */
export function parseChannelFilters(raw: string | undefined): readonly QueueChannelFilter[] {
  const asked = new Set((raw ?? '').split(',').map((part) => part.trim()));
  return QUEUE_CHANNEL_FILTERS.filter((channel) => asked.has(channel));
}

/**
 * The phone's "Assigned to me" leaves out what was resolved (Omer,
 * 2026-11-03): a conversation the reader closed no longer sits under "mine".
 * The route's own `excludeClosed`, on that view only; every other view is
 * `viewQuery`'s, so the phone and the website still mean one thing by them.
 *
 * ★ Its chip counts the same set: `phoneCountView("mine")` is the count route's
 *   `mine_open`, which is this query.
 */
export function phoneViewQuery(
  view: InboxView,
  meId: string | null,
): Record<string, string> | null {
  const query = viewQuery(view, meId);
  return view === 'mine' && query !== null ? { ...query, excludeClosed: 'true' } : query;
}

/** The count route's view for each phone chip: its own id, except "mine". */
export function phoneCountView(view: InboxView): string {
  return view === 'mine' ? 'mine_open' : view;
}

/*
 * The design's chips, in its order: All, then the desktop rail's views with
 * the rail's own ids and `?view=`, so a view means here what it means on the
 * website - for one person, "Open" in place of three (`railViews`).
 */
export function phoneViews(soleHuman: boolean, relevance = false): readonly InboxView[] {
  return ['all', ...railViews(soleHuman, relevance)];
}

/**
 * The count route's views for the chips: the same, except "mine", which on
 * the phone leaves out what was resolved (`phoneViewQuery`), so its count is
 * the route's `mine_open` - the number of rows the chip opens.
 */
export function phoneCountViews(soleHuman: boolean, relevance = false): readonly string[] {
  return phoneViews(soleHuman, relevance).map(phoneCountView);
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
    // The default is the bare address; every other view, the queue included, is named.
    ...(state.view === DEFAULT_INBOX_VIEW ? {} : { view: state.view }),
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
