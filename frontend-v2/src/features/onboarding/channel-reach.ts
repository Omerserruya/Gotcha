import type { Channel, ChannelType } from '@/api/contracts/channels';
import type { WidgetInstall } from '@/api/contracts/website-widget';

/**
 * The channels onboarding offers, in this order (Omer, 2026-10-23). Messenger
 * joined beside Instagram (2026-10-24): its connect comes back to the step
 * too, with its Page picker.
 */
export const ONBOARDING_CHANNELS = ['WEBCHAT', 'WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'EMAIL'] as const;
export type OnboardingChannel = (typeof ONBOARDING_CHANNELS)[number];

/** The platform types each row stands for: email is a mailbox on a server, Gmail or Outlook. */
const ROW_TYPES: Record<Exclude<OnboardingChannel, 'WEBCHAT'>, readonly ChannelType[]> = {
  WHATSAPP: ['WHATSAPP'],
  INSTAGRAM: ['INSTAGRAM'],
  MESSENGER: ['MESSENGER'],
  EMAIL: ['EMAIL', 'GMAIL', 'OUTLOOK'],
};

/** The row a platform's account (or its way back) belongs on; `null`: onboarding has none. */
export function rowOf(type: ChannelType): OnboardingChannel | null {
  if (type === 'WEBCHAT' || type === 'SHOPIFY_LIVE_CHAT') return 'WEBCHAT';
  for (const [row, types] of Object.entries(ROW_TYPES)) {
    if (types.includes(type)) return row as OnboardingChannel;
  }
  return null;
}

/** The accounts a row stands for (never the website's: it is its install, not a list). */
export const accountsOf = (
  channel: OnboardingChannel,
  channels: readonly Channel[] | null,
): readonly Channel[] =>
  channel === 'WEBCHAT'
    ? []
    : (channels ?? []).filter((each) => ROW_TYPES[channel].includes(each.channel));

/** An account a customer can write to now: active and CONNECTED. */
export const answers = (each: Channel) =>
  each.isActive !== false && each.connectionStatus === 'CONNECTED';

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
  // Backend's go-live counts active accounts only; CONNECTED is ours on top (an
  // account in ERROR answers nobody).
  return accountsOf(channel, channels).some(answers);
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

/** Latin or a digit right after a one-letter Hebrew prefix takes U+2011 (it reads as a hyphen, never breaks). */
const prefixed = (prefix: string, word: string) =>
  `${prefix}${/^[A-Za-z0-9]/.test(word) ? '\u2011' : ''}${word}`;

/** "in <place>": "ב" joined to a Hebrew word, "ב‑Shopify" before Latin; "in Shopify" in English. */
export const inPlace = (word: string, locale: string) =>
  locale === 'he' ? prefixed('ב', word) : `in ${word}`;

/**
 * Where customers write, as one phrase, built here rather than by Intl
 * (whose Hebrew list writes "ו-" with a hyphen-minus). Hebrew repeats the
 * preposition on every item, joined straight to a Hebrew word:
 * "בצ׳אט באתר ובוואטסאפ"; English lists the names: "Web chat and WhatsApp".
 */
export function channelsPhrase(names: readonly string[], locale: string): string {
  const items = locale === 'he' ? names.map((name) => prefixed('ב', name)) : [...names];
  if (items.length <= 1) return items[0] ?? '';
  const head = items.slice(0, -1).join(', ');
  const last = items[items.length - 1]!;
  return locale === 'he' ? `${head} ו${last}` : `${head} and ${last}`;
}
