import type { DesktopPermission, DeviceAlertSettings } from './settings';

/**
 * Whether an incoming message chimes, shows a desktop notification, or
 * neither - decided here, without a browser, so every rule has a test.
 *
 * Two steps, because one of the inputs costs a request:
 *
 *   planAlert    the cheap rules, at the moment the event arrives. When it
 *                answers "nothing", the conversation is never read.
 *   settleAlert  after the conversation read: a conversation this person may
 *                not see (the read is refused) is silence, and the chime
 *                keeps to one per burst.
 */

/**
 * What this tab is, among the open v2 tabs of one workspace.
 *
 *   focused   visible and focused: the person is looking at v2 here.
 *   leader    the one tab that speaks when no v2 tab is focused.
 *   quiet     any other tab: another one is focused, or another one leads.
 */
export type TabRole = 'focused' | 'leader' | 'quiet';

/** The cross-tab election, decided. See `election.ts`. */
export function tabRole(state: {
  readonly selfFocused: boolean;
  readonly otherFocused: boolean;
  readonly leader: boolean;
}): TabRole {
  if (state.selfFocused) return 'focused';
  // A focused v2 tab elsewhere chimes for itself; this one keeps out of it.
  if (state.otherFocused) return 'quiet';
  return state.leader ? 'leader' : 'quiet';
}

export interface AlertPlan {
  readonly sound: boolean;
  readonly popup: boolean;
}

export const NO_ALERT: AlertPlan = { sound: false, popup: false };

/** One chime per burst: a customer sending four lines is one sound. */
export const CHIME_BURST_MS = 3_000;

export function planAlert(input: {
  /** The row's own direction. Only a customer's message (INBOUND) alerts. */
  readonly direction: string | null | undefined;
  /** The row's `messageType`: `system` is the platform's own row, not the customer's. */
  readonly messageType: string | null | undefined;
  /** Something to say: words, or a kind of media (`quoteOf` is not null). */
  readonly hasContent: boolean;
  readonly conversationId: string;
  readonly role: TabRole;
  /** The conversation open in THIS tab (`/inbox?c=`), if any. */
  readonly openConversationId: string | null;
  readonly settings: DeviceAlertSettings;
  readonly permission: DesktopPermission;
  /** Inside the person's quiet hours, now. */
  readonly quiet: boolean;
}): AlertPlan {
  /*
   * The agent's own reply, the AI's and an automation's are OUTBOUND. A frame
   * with no direction is not assumed to be the customer's: a chime for your
   * own message is the failure people switch the sound off over.
   */
  if (input.direction !== 'INBOUND') return NO_ALERT;
  /*
   * ★ The platform writes its own rows INBOUND too - an escalation, an
   *   auto-close, a WhatsApp takeover, a visitor asking for a person - with
   *   `messageType: "system"` and an empty body. Not a customer writing.
   */
  if ((input.messageType ?? '').trim().toLowerCase() === 'system') return NO_ALERT;
  // An empty body and no kind of media: nothing to say, so nothing is said.
  if (!input.hasContent) return NO_ALERT;
  if (input.quiet) return NO_ALERT;
  if (input.role === 'quiet') return NO_ALERT;
  if (input.role === 'focused') {
    // Looking at v2 here: the sound alone, and none for the conversation in front of them.
    return {
      sound: input.settings.sound && input.openConversationId !== input.conversationId,
      popup: false,
    };
  }
  return {
    sound: input.settings.sound,
    popup: input.settings.desktop && input.permission === 'granted',
  };
}

/**
 * `visible`: the conversation read answered. `refused`: 403/404 - not this
 * person's to see. `failed`: anything else - nothing to name it by, and no
 * proof they may see it, so it is silence too.
 */
export type ConversationAccess = 'visible' | 'refused' | 'failed';

export function settleAlert(
  plan: AlertPlan,
  after: {
    readonly access: ConversationAccess;
    readonly now: number;
    /** When this tab last chimed, epoch ms. */
    readonly lastChimeAt: number | null;
  },
): AlertPlan {
  if (after.access !== 'visible') return NO_ALERT;
  const burstOver = after.lastChimeAt === null || after.now - after.lastChimeAt >= CHIME_BURST_MS;
  return { sound: plan.sound && burstOver, popup: plan.popup };
}

/* ── Quiet hours ─────────────────────────────────────────────────────── */

export interface QuietWindow {
  readonly from: string;
  readonly to: string;
}

/**
 * Inside a quiet window - the notifications service's own rule
 * (`personal-preferences.service.ts` `inQuietHours`): "22:00" to "07:00"
 * wraps midnight; `from` is inside, `to` is not.
 */
export function inQuietHours(window: QuietWindow | null, hhmm: string): boolean {
  if (!window) return false;
  const { from, to } = window;
  if (!from || !to || from === to) return false;
  return from < to ? hhmm >= from && hhmm < to : hhmm >= from || hhmm < to;
}

/** "HH:MM" now in `timeZone`, 24-hour; UTC when the zone is not one Intl knows - as the service does. */
export function localHHMM(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'UTC',
    }).format(now);
  }
}

/**
 * The zone quiet hours are read in: the WORKSPACE's, as the notifications
 * service reads them (`workspaceTimeZone`: the business hours' timezone,
 * else UTC). The service takes it only from a business-hours setting that
 * has a schedule (`parseBusinessHours` answers null without one), so this
 * does too - from `GET /api/workspace`, which serves both.
 *
 * `workspace: null` means it could not be read (that route needs
 * settings:workspace:read): then `fallback`, the zone the product shows
 * every time in, rather than the service's UTC, which is the answer for a
 * workspace with no hours - not for one we could not look at.
 */
export function quietTimeZone(
  workspace: {
    readonly timezone: string | null;
    readonly hasSchedule: boolean;
  } | null,
  fallback: string,
): string {
  if (workspace === null) return fallback;
  return workspace.hasSchedule && workspace.timezone ? workspace.timezone : 'UTC';
}

/* ── Where the person is, and where a click takes them ───────────────── */

/**
 * The conversation open in a tab at this address, or null. The inbox opens
 * one only by `?c=` (nothing is opened on the reader's behalf), under the
 * mount point and a locale prefix: `/v2/he/inbox?c=…`.
 */
export function openConversationIn(
  location: { readonly pathname: string; readonly search: string },
  basePath: string,
  locales: readonly string[],
): string | null {
  let path = location.pathname;
  if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) {
    path = path.slice(basePath.length) || '/';
  }
  const segments = path.split('/').filter(Boolean);
  if (segments.length > 0 && locales.includes(segments[0]!)) segments.shift();
  if (segments.length !== 1 || segments[0] !== 'inbox') return null;
  const id = new URLSearchParams(location.search).get('c');
  return id ? id : null;
}

/**
 * Where a click on the notification goes: that conversation in the inbox.
 * Locale-free and unprefixed, for the locale-aware router, which adds both.
 */
export function inboxHref(conversationId: string): `/inbox?c=${string}` {
  return `/inbox?c=${encodeURIComponent(conversationId)}`;
}

/** The notification's tag: one per conversation, replaced and never stacked. */
export function notificationTag(conversationId: string): string {
  return `conv:${conversationId}`;
}

/** The first line of a message, for the notification's body. */
export function firstLine(text: string, max = 140): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
