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
 * ⚠ THE ROUTE CANNOT SEPARATE AI FROM FLOW. `automatedOnly` returns both -
 *   `AUTOMATED_HANDLERS = ["ai_agent", "flow"]` - and there is no `handledBy`
 *   parameter. So the two views send `handledBy` anyway: the route ignores an
 *   unknown key today, and the view becomes exact the moment it accepts one,
 *   with no change here. Until then both show the union. Filtering on the
 *   client instead would be correct on page one and wrong on every page after.
 */

export const INBOX_VIEW_IDS = ['queue', 'mine', 'active', 'ai', 'flow', 'resolved'] as const;
export type InboxView = (typeof INBOX_VIEW_IDS)[number];

/** An unknown or absent `?view=` is the default, never an error page. */
export function parseInboxView(raw: string | undefined): InboxView {
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
      // Unchanged: the route's default, which leaves out what an automation
      // owns unless a human has taken it over.
      return {};
    case 'mine':
      // Everything assigned to the viewer, whoever is driving it.
      return meId === null ? null : { assignedAgentId: meId, includeAutomated: 'true' };
    case 'active':
      return { status: 'OPEN' };
    case 'resolved':
      // A conversation the AI closed is still resolved.
      return { status: 'CLOSED', includeAutomated: 'true' };
    case 'ai':
      return { automatedOnly: 'true', handledBy: 'ai_agent' };
    case 'flow':
      return { automatedOnly: 'true', handledBy: 'flow' };
  }
}

/**
 * The queue header's channel filters, in 02's order.
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
] as const;
export type QueueChannelFilter = (typeof QUEUE_CHANNEL_FILTERS)[number];

/**
 * `?channel=`, or null for "All".
 *
 * ⚠ Only the five the header draws. A filter with no chip lit would leave the
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
}): Record<string, string> {
  return {
    ...(state.view === 'queue' ? {} : { view: state.view }),
    ...(state.channel === null ? {} : { channel: state.channel }),
    ...(state.c ? { c: state.c } : {}),
  };
}
