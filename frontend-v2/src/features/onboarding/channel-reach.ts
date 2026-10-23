import type { Channel } from '@/api/contracts/channels';
import type { WidgetInstall } from '@/api/contracts/website-widget';

/** The channels onboarding offers, in this order (Omer, 2026-10-23). */
export const ONBOARDING_CHANNELS = ['WEBCHAT', 'WHATSAPP', 'INSTAGRAM', 'EMAIL'] as const;
export type OnboardingChannel = (typeof ONBOARDING_CHANNELS)[number];

type Shop = WidgetInstall['shopify'][number];
/** A Shopify shop's chat is live: the app is enabled and its theme embed loaded recently. */
export const shopLive = (shop: Shop) => shop.status === 'active' && shop.embedLive;

/**
 * Can a customer write to the business on this channel now? The website
 * only once its code was seen on the site, or a Shopify shop's chat is on
 * (code that exists but was never seen answers nobody); any other channel
 * once it is CONNECTED. Backend's go-live answers with the same rule
 * (`reach`); this is what is said BEFORE the press.
 */
export function reaches(
  channel: OnboardingChannel,
  channels: readonly Channel[] | null,
  install: WidgetInstall | null,
): boolean {
  if (channel === 'WEBCHAT') {
    return install?.code?.status === 'live' || (install?.shopify ?? []).some(shopLive);
  }
  return (channels ?? []).some(
    (each) => each.channel === channel && each.connectionStatus === 'CONNECTED',
  );
}

/**
 * The channels a customer can write on now, in onboarding's order. `null`
 * when either read failed: a partial list would name fewer channels than
 * answer, so the unknown is said as unknown.
 */
export function reachableChannels(
  channels: readonly Channel[] | null,
  install: WidgetInstall | null,
): readonly OnboardingChannel[] | null {
  if (channels === null || install === null) return null;
  return ONBOARDING_CHANNELS.filter((channel) => reaches(channel, channels, install));
}

/**
 * Channel names as one phrase, written here rather than by Intl: Intl's
 * Hebrew list writes "ו-Instagram" with a hyphen-minus, and the copy rules
 * want U+2011 before Latin, a maqaf before a name that starts with ו, and
 * the ו joined to any other Hebrew word.
 */
export function joinNames(names: readonly string[], locale: string): string {
  if (names.length <= 1) return names[0] ?? '';
  const head = names.slice(0, -1).join(', ');
  const last = names[names.length - 1]!;
  if (locale !== 'he') return `${head} and ${last}`;
  const joint = /^[A-Za-z0-9]/.test(last) ? 'ו‑' : last.startsWith('ו') ? 'ו־' : 'ו';
  return `${head} ${joint}${last}`;
}
