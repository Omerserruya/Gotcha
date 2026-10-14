import { z } from 'zod';

/**
 * The web chat widget's settings - `GET/PUT /api/channels/webchat/:id/settings`,
 * Backend's `WebchatConfig` (packages/shared webchat-widget.ts), normalised
 * on the way in and out.
 *
 * Only what 13g-13j edit is named. A PUT may send part of an object: the
 * route merges it into what is stored (`normalizeWebchatConfig(incoming,
 * current)`), so a field this screen does not draw is never reset by it.
 */
/** 13g-13j, one page with a tab each (`?tab=`). */
export const WEBCHAT_TABS = ['appearance', 'conversation', 'behaviour', 'install'] as const;
export type WebchatTab = (typeof WEBCHAT_TABS)[number];

export const WEBCHAT_LANGUAGES = ['auto', 'he', 'en'] as const;

/** Stage B's two customer-side looks (website-widget-v1 §1). */
export const WIDGET_LOOKS = ['gotcha', 'whatsapp'] as const;
export type WidgetLook = (typeof WIDGET_LOOKS)[number];
export type WebchatLanguage = (typeof WEBCHAT_LANGUAGES)[number];

/** 13i's "When to show": right away, 5s, 15s, 30s - a time-on-page delay. */
export const POPUP_DELAYS = [0, 5, 15, 30] as const;

/** 13g's six palette colours (design 6), then any hex. */
export const PALETTE = ['#121212', '#3A3833', '#C96A4B', '#4F7A2E', '#3E5C99', '#6B5BD2'] as const;

const url = z.string().nullable().catch(null).default(null);

export const webchatConfigSchema = z.object({
  displayName: z.string().catch(''),
  appearance: z.object({
    primaryColor: z.string().catch('#121212'),
    logoUrl: url,
    language: z.enum(WEBCHAT_LANGUAGES).catch('auto'),
    showPoweredBy: z.boolean().catch(true),
  }),
  ux: z.object({
    welcome: z.object({
      assistantName: z.string().catch(''),
      suggestedQuestions: z.array(z.string()).catch([]),
    }),
    launcher: z.object({ position: z.enum(['left', 'right']).catch('right') }),
    hero: z.object({
      mediaType: z.string().catch('none'),
      mediaUrl: url,
    }),
    proactive: z.object({
      enabled: z.boolean().catch(false),
      trigger: z.string().catch('time_on_page'),
      delaySeconds: z.number().nonnegative().catch(15),
      message: z.string().catch(''),
    }),
    /** Stage B: the customer-side panel style. Absent (stage A) or unknown: GOTCHA's. */
    look: z.enum(WIDGET_LOOKS).catch('gotcha').default('gotcha'),
    /** Stage B: "Continue on WhatsApp" - on, and the workspace's number it continues on. */
    whatsapp: z
      .object({
        enabled: z.boolean().catch(false),
        channelAccountId: z.string().nullable().catch(null),
      })
      .catch({ enabled: false, channelAccountId: null })
      .default({ enabled: false, channelAccountId: null }),
  }),
});
export type WebchatConfig = z.infer<typeof webchatConfigSchema>;

/* Strict envelope: an unreadable answer is "couldn't read", never a default widget. */
export const webchatSettingsSchema = z.object({ data: webchatConfigSchema });

/** The body a change sends - every edited field, merged server-side into the rest. */
export function bodyOfConfig(config: WebchatConfig) {
  const color = config.appearance.primaryColor;
  const cover = config.ux.hero.mediaUrl?.trim() || null;
  return {
    displayName: config.displayName,
    appearance: {
      primaryColor: color,
      logoUrl: config.appearance.logoUrl?.trim() || null,
      language: config.appearance.language,
      // No showPoweredBy (W8): always on; the route refuses false (403 POWERED_BY_LOCKED).
    },
    ux: {
      welcome: {
        assistantName: config.ux.welcome.assistantName,
        suggestedQuestions: config.ux.welcome.suggestedQuestions
          .map((q) => q.trim())
          .filter(Boolean),
      },
      // The launcher wears the main colour too, and sits on the same side on a phone.
      launcher: {
        position: config.ux.launcher.position,
        mobilePosition: config.ux.launcher.position,
        backgroundColor: color,
      },
      hero: { mediaType: cover ? 'image' : 'none', mediaUrl: cover },
      // 13i's delay is time on the page, once per visit.
      proactive: {
        enabled: config.ux.proactive.enabled,
        trigger: 'time_on_page',
        delaySeconds: config.ux.proactive.delaySeconds,
        mobileDelaySeconds: config.ux.proactive.delaySeconds,
        maxPerSession: 1,
        message: config.ux.proactive.message,
      },
    },
  };
}

/** A hex colour the route will keep: #RGB or #RRGGBB. */
export function isHex(value: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

/** An image address the route will keep: https only (it drops anything else). */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}
