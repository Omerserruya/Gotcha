import type { Automation } from '@/api/contracts/automations';

/** The name onboarding stores on the setup route (Backend 8f68171c) - English, as stored. */
export const SETUP_ROUTE_NAME = 'Who answers new conversations';

/**
 * The names the website chat's "who answers" writes on a channel's own route
 * (widget-assignment.service) - English, as stored, one channel each. These
 * rows carry no `origin`: the screen knows them by name, trigger and channel.
 */
const WIDGET_ROUTE_NAMES: Readonly<Record<string, string>> = {
  WEBCHAT: 'Who answers the website chat',
  SHOPIFY_LIVE_CHAT: 'Who answers the Shopify store chat',
};

/** The system's own routes, by the name they still carry. */
export type DefaultRoute = 'setup' | 'webchat' | 'shopifyChat';

/** In the reader's language: the catalogue's `origin.setupName` and its siblings. */
export type RouteNames = Readonly<Record<DefaultRoute, string>>;

/** The screen's words for the system's routes - `t` is the `automations` translator. */
export function routeNames(
  t: (key: 'origin.setupName' | 'origin.webchatName' | 'origin.shopifyChatName') => string,
): RouteNames {
  return {
    setup: t('origin.setupName'),
    webchat: t('origin.webchatName'),
    shopifyChat: t('origin.shopifyChatName'),
  };
}

/**
 * Which of the system's routes this is, while it still carries the name the
 * system wrote: the setup route by its `origin`, the website chat's by its
 * name, its trigger and that one channel. Renamed, or pointed at other
 * channels, it is the author's, and `null`.
 */
export function defaultRouteOf(
  automation: Pick<Automation, 'name' | 'origin' | 'trigger'>,
): DefaultRoute | null {
  if (automation.origin === 'setup' && automation.name === SETUP_ROUTE_NAME) return 'setup';
  if (automation.trigger.type !== 'conversation_started') return null;
  const channels = automation.trigger.config.channels;
  if (!Array.isArray(channels) || channels.length !== 1) return null;
  const channel = String(channels[0]).toUpperCase();
  if (WIDGET_ROUTE_NAMES[channel] !== automation.name) return null;
  return channel === 'WEBCHAT' ? 'webchat' : 'shopifyChat';
}

/**
 * The name to show: a system route still carrying the name it was written
 * with is said in the screen's words (F2, 2026-11-09: "Who answers the
 * website chat" read in English in the Hebrew UI); once someone renames it,
 * theirs, as written. The stored row is never renamed by showing it - see
 * `savedName`.
 */
export function shownName(
  automation: Pick<Automation, 'name' | 'origin' | 'trigger'>,
  names: RouteNames,
): string {
  const route = defaultRouteOf(automation);
  return route === null ? automation.name : names[route];
}

/**
 * ★★ THE NAME TO SAVE: the stored one while the field still shows the
 *   screen's words for it. Publishing the setup route from the Hebrew UI
 *   wrote "מי עונה לשיחות חדשות" into the row - a rename nobody made, after
 *   which the English UI read Hebrew and the route no longer matched its
 *   default. What someone typed is saved as typed.
 */
export function savedName(
  typed: string,
  automation: Pick<Automation, 'name' | 'origin' | 'trigger'>,
  names: RouteNames,
): string {
  const name = typed.trim();
  return defaultRouteOf(automation) !== null && name === shownName(automation, names)
    ? automation.name
    : name;
}
