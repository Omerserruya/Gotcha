import { PERMISSIONS } from '@/permissions/catalogue';
import type { PermissionString } from '@/permissions/permission-set';

/**
 * The product's navigation.
 *
 * Order, wording and grouping come from the design and the product brief, not
 * from a guess:
 *
 *   "Seven destinations in the frame rail, with Settings pinned at the bottom.
 *    Depth happens inside panels, never through navigation."
 *
 * Sub-navigation appears in the rail only for the destination you are in, so
 * the rail stays seven lines at rest and never becomes a tree. That is the
 * "depth happens inside panels" rule applied to the rail itself.
 *
 * `labelKey` is always a translation key: the rail is the most visible surface
 * in the product and must read natively in every locale.
 *
 * `permission` now carries the platform's real strings, confirmed against the
 * backend's canonical set. Matching is EXACT - `conversation:messages` grants
 * nothing, only `conversation:messages:read` does - so each entry names the
 * precise key that its area needs to be worth opening.
 *
 * Home carries none: it is the landing page and must stay reachable for
 * anybody who can sign in.
 */

/**
 * A child entry. It is one of two kinds, and the distinction is not cosmetic:
 *
 *   `href`  - a genuinely different page. Studio's four areas and Settings'
 *             eight sections are separate screens with separate data.
 *   `view`  - a filter over the SAME page. Inbox's views are one list under
 *             different predicates, so they belong in the query string, where
 *             they compose with channel and status filters and stay
 *             deep-linkable.
 */
export interface NavigationChild {
  readonly id: string;
  readonly labelKey: string;
  readonly href?: string;
  readonly view?: string;
  readonly permission?: PermissionString;
}

export interface NavigationItem {
  readonly id: string;
  /** Path without a locale prefix. `Link` from `@/i18n/navigation` adds it. */
  readonly href: string;
  readonly labelKey: string;
  readonly permission?: PermissionString;
  /** Revealed in the rail while this destination is the current one. */
  readonly children?: readonly NavigationChild[];
  /**
   * The mono label above the child group. The design writes "Views" over the
   * Inbox group; a section list is labelled by its destination.
   */
  readonly childrenLabelKey?: string;
  /** The query parameter `view` children write to. */
  readonly viewParam?: string;
  /** The view that applies when the parameter is absent. */
  readonly defaultView?: string;
}

const under = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

/**
 * Whether an `href` child is the current one. Prefix match, so a campaign's
 * own page keeps Campaigns current - but the most specific sibling wins:
 * `/outreach/calls` sits under Campaigns' `/outreach` too, and marking both
 * says you are in two places.
 */
export function isCurrentHrefChild(
  pathname: string,
  child: NavigationChild,
  siblings: readonly NavigationChild[],
): boolean {
  if (!child.href || !under(pathname, child.href)) return false;
  return !siblings.some(
    (other) => other.href && other.href.length > child.href!.length && under(pathname, other.href),
  );
}

/**
 * Inbox views.
 *
 * From the brief: "Waiting in queue / Assigned to me / Active / AI managed /
 * Flow managed". These are predicates over one list, not five pages - which is
 * why they are query state. Channel filters compose on top and are a page-level
 * control, not rail navigation, per "keep advanced filtering out of the way by
 * default".
 */
const INBOX_VIEWS: readonly NavigationChild[] = [
  { id: 'queue', labelKey: 'inbox.queue', view: 'queue' },
  { id: 'mine', labelKey: 'inbox.mine', view: 'mine' },
  { id: 'active', labelKey: 'inbox.active', view: 'active' },
  { id: 'ai', labelKey: 'inbox.ai', view: 'ai' },
  { id: 'flow', labelKey: 'inbox.flow', view: 'flow' },
  { id: 'resolved', labelKey: 'inbox.resolved', view: 'resolved' },
];

/**
 * Studio's four areas, from the brief: Employees, Knowledge, Automations,
 * Capabilities. Separate screens with separate data, so separate routes.
 */
/**
 * Outreach's areas.
 *
 * Campaigns and templates are separate screens with separate data, so
 * separate routes - the same reasoning as Studio's four. Templates is not a
 * filter over campaigns: it is a different object with its own lifecycle, and
 * the provider reviews it rather than the tenant sending it.
 */
const OUTREACH_SECTIONS: readonly NavigationChild[] = [
  {
    id: 'campaigns',
    labelKey: 'outreach.campaigns',
    href: '/outreach',
    permission: PERMISSIONS.outbound.calls.view,
  },
  {
    id: 'templates',
    labelKey: 'outreach.templates',
    href: '/outreach/templates',
    permission: PERMISSIONS.outbound.calls.view,
  },
  {
    id: 'calls',
    labelKey: 'outreach.calls',
    href: '/outreach/calls',
    permission: PERMISSIONS.outbound.calls.view,
  },
];

/**
 * Studio's four areas.
 *
 * Exported because the Studio index page is built from this list rather than
 * from a second hand-written one. A fifth area added here appears on the index
 * without anybody remembering to go and add it, which is the only arrangement
 * that survives somebody adding a fifth area.
 */
export const STUDIO_SECTIONS: readonly NavigationChild[] = [
  {
    id: 'employees',
    labelKey: 'studio.employees',
    href: '/studio/employees',
    permission: PERMISSIONS.ai.employees.read,
  },
  {
    id: 'knowledge',
    labelKey: 'studio.knowledge',
    href: '/studio/knowledge',
    permission: PERMISSIONS.ai.knowledge.read,
  },
  {
    id: 'automations',
    labelKey: 'studio.automations',
    href: '/studio/automations',
    permission: PERMISSIONS.ai.workflows.read,
  },
  {
    id: 'capabilities',
    labelKey: 'studio.capabilities',
    href: '/studio/capabilities',
    permission: PERMISSIONS.ai.tools.read,
  },
];

/**
 * Analytics is organised "around business questions", not chart types.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ AND IT IS ONE SCREEN, BECAUSE FOUR OF THE FIVE SECTIONS HAVE NO DATA
 * ════════════════════════════════════════════════════════════════════════════
 * This listed five children, each pointing at an untouched placeholder route -
 * five navigable rooms with a heading and nothing in them, which is what
 * screen 06 was until it was assembled.
 *
 *   overview  nothing of its own. The headline figures are `MetricStrip`, live
 *             on screen 01; a second rendering would be two screens to keep in
 *             step and one to contradict the other.
 *   ai        held on an escalation aggregation that does not exist.
 *             `ConversationHandover.reason` is a four-value code with no route
 *             over it, and nothing counts machine causes.
 *   humans    the team panel, now on `/analytics`.
 *   topics    a panel, not a section: a "topic" is a `groupBy` over one
 *             unconstrained column with no model behind it, so a rename has
 *             nowhere to persist.
 *   sales     cancelled.
 *
 * So the entry has no children and `/analytics` is the destination. A link to
 * a room with nothing in it is the same promise as an empty tab, made in the
 * navigation instead of on the page - and it survives longer there, because
 * nobody opens every item in a sub-nav.
 */
const ANALYTICS_SECTIONS: readonly NavigationChild[] = [];

/**
 * Settings' eight sections, from the brief.
 *
 * Note what is NOT here: the brief is explicit that AI behaviour does not live
 * in Settings. Employees, Knowledge, Automations and Capabilities are Studio's,
 * because they are how the business teaches GOTCHA to work - not platform
 * configuration.
 */
/*
 * Exactly 02's eight. WhatsApp numbers (13b) and the plan (17b) are not
 * sections: 13b is a panel over Channels, reached from its WhatsApp row, and
 * 17b a sub-page of Usage & billing with its way back above the title. Each
 * highlights its parent, which its path starts with.
 */
export const SETTINGS_SECTIONS: readonly NavigationChild[] = [
  { id: 'workspace', labelKey: 'settings.workspace', href: '/settings/workspace' },
  { id: 'people', labelKey: 'settings.people', href: '/settings/people' },
  {
    id: 'channels',
    labelKey: 'settings.channels',
    href: '/settings/channels',
    permission: PERMISSIONS.channels.manage.read,
  },
  {
    id: 'systems',
    labelKey: 'settings.systems',
    href: '/settings/systems',
    permission: PERMISSIONS.businessSystems.connections.read,
  },
  { id: 'notifications', labelKey: 'settings.notifications', href: '/settings/notifications' },
  { id: 'security', labelKey: 'settings.security', href: '/settings/security' },
  { id: 'billing', labelKey: 'settings.billing', href: '/settings/billing' },
  { id: 'developer', labelKey: 'settings.developer', href: '/settings/developer' },
];

/** The seven destinations, in the design's order. */
export const PRIMARY_NAVIGATION: readonly NavigationItem[] = [
  // No permission: Home is where everyone lands.
  { id: 'home', href: '/home', labelKey: 'primary.home' },
  {
    id: 'inbox',
    href: '/inbox',
    labelKey: 'primary.inbox',
    permission: PERMISSIONS.conversation.messages.read,
    children: INBOX_VIEWS,
    childrenLabelKey: 'groups.views',
    viewParam: 'view',
    defaultView: 'queue',
  },
  {
    id: 'approvals',
    href: '/approvals',
    labelKey: 'primary.approvals',
    permission: PERMISSIONS.approvals.requests.view,
  },
  {
    id: 'customers',
    href: '/customers',
    labelKey: 'primary.customers',
    permission: PERMISSIONS.customer.profile.read,
  },
  {
    id: 'outreach',
    href: '/outreach',
    labelKey: 'primary.outreach',
    permission: PERMISSIONS.outbound.calls.view,
    children: OUTREACH_SECTIONS,
    childrenLabelKey: 'primary.outreach',
  },
  {
    id: 'studio',
    href: '/studio',
    labelKey: 'primary.studio',
    permission: PERMISSIONS.ai.employees.read,
    children: STUDIO_SECTIONS,
    childrenLabelKey: 'primary.studio',
  },
  {
    id: 'analytics',
    href: '/analytics',
    labelKey: 'primary.analytics',
    permission: PERMISSIONS.analytics.dashboard.read,
    children: ANALYTICS_SECTIONS,
    childrenLabelKey: 'primary.analytics',
  },
];

/**
 * Pinned to the foot of the rail, beneath the seven.
 *
 * NO children, and that is the design's choice rather than an omission. Inbox
 * and Studio reveal their sections in the rail; Settings does not. Screens
 * 11-18 draw the rail with Settings selected and nothing under it, and put the
 * eight sections in a light sidebar inside the panel instead - see
 * SettingsSections.
 *
 * The distinction holds up: a rail section is a filter over one page, while a
 * Settings section is a page of its own, and eight of them in a dark rail
 * beneath seven destinations would read as fifteen destinations.
 */
export const SETTINGS_NAVIGATION: NavigationItem = {
  id: 'settings',
  href: '/settings',
  labelKey: 'primary.settings',
};
