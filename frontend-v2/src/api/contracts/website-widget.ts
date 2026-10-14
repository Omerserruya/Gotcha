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

/**
 * The body a change sends - every edited field, merged server-side into the
 * rest. Stage B's fields (`look`, `whatsapp`) only to a service that has
 * them: a stage A route would drop them, and the screen would snap back.
 */
export function bodyOfWidget(settings: WidgetSettings, { stageB = false } = {}) {
  const { displayName: _account, ...body } = bodyOfConfig({ ...settings, displayName: '' });
  if (!stageB) return body;
  return {
    ...body,
    ux: {
      ...body.ux,
      look: settings.ux.look,
      kind: settings.ux.kind,
      whatsapp: {
        enabled: settings.ux.whatsapp.enabled,
        channelAccountId: settings.ux.whatsapp.channelAccountId,
      },
    },
  };
}

/**
 * A WhatsApp number "Continue on WhatsApp" can use (stage B). `available`
 * only when connected and its phone is known (wa.me needs it); otherwise
 * the reason, said by the screen.
 */
export const handoffNumberSchema = z.object({
  channelId: z.string(),
  name: z.string(),
  phone: z.string().nullable().catch(null).default(null),
  available: z.boolean(),
  reason: z.enum(['not_connected', 'number_unknown']).optional().catch(undefined),
});
export type HandoffNumber = z.infer<typeof handoffNumberSchema>;

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
    /**
     * Stage B's picker for "Continue on WhatsApp". ABSENT from a stage A
     * service - which is how the screen knows stage B is there at all.
     */
    whatsappNumbers: z.array(handoffNumberSchema).optional(),
  }),
});
export type WebsiteWidget = z.infer<typeof websiteWidgetSchema>['data'];

const when = z.string().nullable().catch(null).default(null);

/**
 * WooCommerce through its plugin (woocommerce-plugin-v1 §5, Backend
 * 1e90d585): each site that connected the plugin, and the zip to install.
 *
 * ⚠ A site's status is not guessed: one the screen does not know fails the
 *   read, as a shop's does - never "Connected" for a site in a state it
 *   cannot name. `downloadUrl` absent: a service before the plugin - the
 *   row stays a status.
 */
export const WOO_SITE_STATUSES = ['connected', 'deactivated', 'removed'] as const;
const wooInstallSchema = z.object({
  /** `use_code` until a site connects through the plugin, then `plugin`. */
  status: z.string().catch('use_code'),
  sites: z
    .array(
      z.object({
        id: z.string(),
        siteUrl: z.string(),
        status: z.enum(WOO_SITE_STATUSES),
        lastSeenAt: when,
        pluginVersion: z.string().nullable().catch(null).default(null),
      }),
    )
    .default([]),
  downloadUrl: z.string().nullable().catch(null).default(null),
});

/**
 * Where the widget is installed, per platform.
 *
 * An unknown status is not guessed into a known one: it fails the read, and
 * the tab says it could not read the installs - never "Active" for a shop
 * whose state it does not understand.
 */
export const installPlatformSchema = z.object({
  platform: z.enum(['shopify', 'woocommerce']),
  /** An unknown state is not offered: never an install path on a guess. */
  data: z.enum(['connected', 'connecting', 'error', 'not_connected']).catch('not_connected'),
  dataErrorCode: z.string().nullable().catch(null).default(null),
  /** The platform's stores (a Shopify domain, a Woo site URL); the preview's address. */
  stores: z.array(z.string()).catch([]).default([]),
});
export type InstallPlatform = z.infer<typeof installPlatformSchema>;

/** How the install tab treats a platform: offered, said to need reconnecting, or not shown. */
export function platformOffer(
  platforms: readonly InstallPlatform[] | null,
  platform: InstallPlatform['platform'],
): 'offer' | 'reconnect' | 'hide' {
  if (platforms === null) return 'offer';
  const row = platforms.find((p) => p.platform === platform);
  return row?.data === 'connected' ? 'offer' : row?.data === 'error' ? 'reconnect' : 'hide';
}

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
    woocommerce: wooInstallSchema.default({ status: 'use_code', sites: [], downloadUrl: null }),
    /**
     * ★★ W11 (Backend 0a718342): each store platform's own connection to
     * GOTCHA - only a `connected` one is offered as a way to install; an
     * `error` one says it needs reconnecting. Per row: one that does not
     * parse is left out. Absent (an older server): `null`, and the tab
     * offers what it always did.
     */
    platforms: z
      .array(z.unknown())
      .nullable()
      .catch(null)
      .default(null)
      .transform((rows) =>
        rows === null
          ? null
          : rows.flatMap((row) => {
              const item = installPlatformSchema.safeParse(row);
              return item.success ? [item.data] : [];
            }),
      ),
  }),
});
export type WidgetInstall = z.infer<typeof widgetInstallSchema>['data'];
export type ShopifyPlace = WidgetInstall['shopify'][number];
export type WooSite = WidgetInstall['woocommerce']['sites'][number];

/** A store's address as a host: "https://demo-store.example/" → "demo-store.example". */
function hostOf(address: string): string | null {
  try {
    return new URL(address.includes('://') ? address : `https://${address}`).hostname || null;
  } catch {
    return null;
  }
}

/**
 * The preview's address line (supervisor, dev 2026-10-14: it named a Shopify
 * shop whose connection had failed): the first store of a platform connected
 * to GOTCHA, else the workspace's website, else the site the code was last
 * seen on.
 */
export function previewSite(install: WidgetInstall | null, website: string | null): string | null {
  for (const platform of install?.platforms ?? []) {
    if (platform.data !== 'connected') continue;
    const host = platform.stores.map(hostOf).find((h): h is string => !!h);
    if (host) return host;
  }
  const site = website ? hostOf(website.trim()) : null;
  return site ?? install?.code?.lastHost ?? null;
}

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

/* ── Who answers the widget: the playbook, written from here (§4) ───────── */

/**
 * How the playbook routes one of the widget's channels.
 *
 * ⚠ The whole domain, from §4.1: always | conditional | team | flow | none.
 *   One the route adds later is read as `conditional` - not editable here,
 *   "decided in the playbook" - never as a route this screen would rewrite.
 */
export const ASSIGNMENT_HOWS = ['always', 'conditional', 'team', 'flow', 'none'] as const;
export type AssignmentHow = (typeof ASSIGNMENT_HOWS)[number];

const assignmentChannelSchema = z.object({
  channel: z.string(),
  /** Set only when `how` is `always`. */
  employee: z.object({ id: z.string(), name: z.string() }).nullable().catch(null).default(null),
  how: z.enum(ASSIGNMENT_HOWS).catch('conditional'),
  /** `false` when conditions decide it: changed in the playbook, not here. */
  editable: z.boolean().catch(false),
  /** The playbook has an entry of its own for this channel. */
  dedicated: z.boolean().catch(false).default(false),
  /** Other channels on the SAME route. */
  sharedWith: z.array(z.string()).catch([]).default([]),
  /**
   * Exactly what a change from the widget would ALSO move (Backend a9c26456):
   * `[]` when the channel would get its own entry or nothing shares its
   * route. Absent from an older service - then only the PUT's 409 says.
   */
  movesWith: z.array(z.string()).optional().catch(undefined),
});
export type AssignmentChannel = z.infer<typeof assignmentChannelSchema>;

const assignmentShape = z.object({
  channels: z.array(assignmentChannelSchema),
  /** To choose from; only active ones are choosable. */
  employees: z.array(
    z.object({ id: z.string(), name: z.string(), active: z.boolean().catch(false) }),
  ),
});
export type WidgetAssignment = z.infer<typeof assignmentShape>;

/** `GET /api/website-widget/assignment`. */
export const widgetAssignmentSchema = z.object({ data: assignmentShape });

/** `PUT` answers the read shape after the write, and what changed. */
export const widgetAssignmentWriteSchema = z.object({
  data: assignmentShape.extend({
    changed: z
      .array(
        z.object({
          channel: z.string(),
          from: z.object({ id: z.string(), name: z.string() }).nullable().catch(null),
          created: z.boolean().catch(false),
        }),
      )
      .catch([])
      .default([]),
  }),
});
