import { z } from 'zod';

import { bodyOfConfig, webchatConfigSchema, type WebchatConfig } from './webchat';

/** 13g-13j's address: the one widget, a tab at a time (`?tab=`). */
export const WIDGET_PATH = '/settings/channels/website';

/** The channel kinds the one widget is made of: the code snippet's, and Shopify's. */
export const WIDGET_CHANNELS = ['WEBCHAT', 'SHOPIFY_LIVE_CHAT'] as const;

/**
 * The Website widget - `GET/PUT /api/website-widget` and
 * `GET /api/website-widget/install` (Backend, website-widget-v1, 03e98dd9).
 *
 * Omer, 2026-10-07: "Shopify live chat" and "Web chat" are one embedded chat.
 * One settings object for the workspace, written to every place it is
 * installed: the code snippet's web chat account and each Shopify shop.
 *
 * The settings are the web chat's own fields (13g-13j drew them first), so
 * the shape is `webchatConfigSchema` without the account's `displayName`,
 * and a change sends the same partial body: the route deep-merges it into
 * what is stored and normalises, so a field this screen does not draw is
 * never reset by it.
 */
export const widgetSettingsSchema = webchatConfigSchema.omit({ displayName: true });
export type WidgetSettings = z.infer<typeof widgetSettingsSchema>;

/** The body a change sends - every edited field, merged server-side into the rest. */
export function bodyOfWidget(settings: WidgetSettings) {
  const { displayName: _account, ...body } = bodyOfConfig({ ...settings, displayName: '' });
  return body;
}

/** The editor's config shape, for the parts of 13g-13j that still take one. */
export function asConfig(settings: WidgetSettings): WebchatConfig {
  return { ...settings, displayName: '' };
}

/* Strict envelope: an unreadable answer is "couldn't read", never a default widget. */
export const websiteWidgetSchema = z.object({
  data: z.object({
    settings: widgetSettingsSchema,
    /** Read-only: who answers the website channel per the playbook; `null` when it routes nowhere specific. */
    assignedEmployee: z
      .object({ id: z.string(), name: z.string() })
      .nullable()
      .catch(null)
      .default(null),
    places: z.object({
      /** The code snippet's web chat account; `null` until it is created. */
      code: z.object({ channelId: z.string() }).nullable(),
      shopify: z.array(z.object({ channelId: z.string(), shopDomain: z.string() })),
    }),
  }),
});
export type WebsiteWidget = z.infer<typeof websiteWidgetSchema>['data'];

const when = z.string().nullable().catch(null).default(null);

/**
 * Where the widget is installed, per platform.
 *
 * An unknown status is not guessed into a known one: it fails the read, and
 * the tab says it could not read the installs - never "Active" for a shop
 * whose state it does not understand.
 */
export const widgetInstallSchema = z.object({
  data: z.object({
    code: z
      .object({
        widgetId: z.string(),
        snippet: z.string(),
        status: z.enum(['not_seen', 'live']),
        firstSeenAt: when,
        lastSeenAt: when,
        lastHost: z.string().nullable().catch(null).default(null),
      })
      .nullable(),
    shopify: z.array(
      z.object({
        channelId: z.string(),
        shopDomain: z.string(),
        status: z.enum(['active', 'not_enabled', 'uninstalled']),
        /** The theme's app embed loaded recently (its heartbeat). */
        embedLive: z.boolean(),
        lastHeartbeatAt: when,
        themeEditorUrl: z.string().nullable().catch(null).default(null),
      }),
    ),
    woocommerce: z.object({ status: z.string() }).catch({ status: 'use_code' }),
  }),
});
export type WidgetInstall = z.infer<typeof widgetInstallSchema>['data'];
export type ShopifyPlace = WidgetInstall['shopify'][number];

/** Where the widget answers visitors now: the code seen on a page, or a shop with its embed loading. */
export function isLive(install: WidgetInstall): boolean {
  return (
    install.code?.status === 'live' ||
    install.shopify.some((shop) => shop.status === 'active' && shop.embedLive)
  );
}

/** A shop the widget was installed on and is no longer working in. */
export function troubledShops(install: WidgetInstall): readonly ShopifyPlace[] {
  return install.shopify.filter((shop) => shop.status === 'uninstalled');
}
