/**
 * The website chat widget - configuration for the embeddable widget a
 * tenant pastes onto their own site.
 *
 * This deliberately shares its experience block with the Shopify
 * storefront widget. `lib/shopify-chat-ux.ts` was written for that channel
 * but nothing in it is about commerce: a launcher, a hero, a welcome
 * screen, a proactive teaser and notification sounds are what a chat
 * widget is, wherever it is embedded. Two copies of that would drift, and
 * a merchant would learn one editor and find the other missing half its
 * options.
 *
 * What differs between the two channels is genuinely small and lives here:
 * how the widget is identified (a widget id rather than a shop domain),
 * and the fact that a website widget has no products to talk about.
 */

import {
  normalizeShopifyChatUx,
  defaultShopifyChatUx,
  normalizeWelcome,
  type ShopifyChatUx,
} from "./shopify-chat-ux";
import { effectivePoweredBy } from "./powered-by";

export const WEBCHAT_CHANNEL = "WEBCHAT" as const;

export const WEBCHAT_NAME_SOURCES = ["employee", "custom"] as const;
export type WebchatNameSource = (typeof WEBCHAT_NAME_SOURCES)[number];

/** Where the widget's launcher sits, kept for the legacy flat settings. */
export type WebchatPosition = "right" | "left";

export interface WebchatConfig {
  /** Schema marker so an old flat blob can be told from a migrated one. */
  v: 2;
  /** Shown in the dashboard, never to a visitor. */
  displayName: string;
  appearance: {
    primaryColor: string;
    contrastColor: string;
    logoUrl: string | null;
    cornerRadius: number;
    language: "auto" | "en" | "he";
    direction: "auto" | "ltr" | "rtl";
    showPoweredBy: boolean;
  };
  /** The shared experience block - the same one the storefront widget uses. */
  ux: ShopifyChatUx;
  /**
   * Where the header's name comes from (2026-10-24):
   *   "employee" - the AI employee the automation routes the web chat to, so
   *                changing who answers changes the name;
   *   "custom"   - ux.welcome.assistantName, typed by the merchant.
   * A widget saved before this field reads as "custom" (it kept the name it
   * had); a widget never configured reads as "employee". No row is rewritten.
   */
  nameSource: WebchatNameSource;
  behaviour: {
    /** Offer "talk to a person" in the composer footer. */
    allowHumanHandoff: boolean;
  };
  /** Copy shown when the business is closed. Availability itself is the tenant's. */
  offline: {
    message: string;
  };
  /**
   * Products on the website widget (W9): cards from the workspace's connected
   * WooCommerce store, and add to cart. Opt-in (off by default); served on
   * only while that store is connected.
   */
  commerce: WebchatCommerce;
}

export const MAX_PROMOTION_COUPONS = 5;

export interface WebchatCommerce {
  productMessagingEnabled: boolean;
  addToCartEnabled: boolean;
  /**
   * After the customer chose a product, the AI may suggest what goes with it:
   * the store's own cross-sells and upsells, else in-stock products from the
   * same category, as cards. Cards only, so it needs productMessagingEnabled.
   */
  suggestComplementary: boolean;
  /** The store coupons the merchant chose to show (Woo coupon ids). Nothing shows without a choice. */
  promotions: { couponIds: string[] };
}

export function normalizeWebchatCommerce(raw: unknown, base: WebchatCommerce = defaultWebchatConfig().commerce): WebchatCommerce {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const p = (s.promotions && typeof s.promotions === "object" ? s.promotions : {}) as Record<string, any>;
  const ids = Array.isArray(p.couponIds)
    ? [...new Set(p.couponIds.map((v: unknown) => String(v ?? "").trim()).filter((v: string) => /^\d{1,12}$/.test(v)))].slice(0, MAX_PROMOTION_COUPONS) as string[]
    : base.promotions.couponIds;
  const productMessagingEnabled = bool(s.productMessagingEnabled, base.productMessagingEnabled);
  return {
    productMessagingEnabled,
    // Add to cart lives on a product card: no cards, no cart.
    addToCartEnabled: productMessagingEnabled && bool(s.addToCartEnabled, base.addToCartEnabled),
    suggestComplementary: productMessagingEnabled && bool(s.suggestComplementary, base.suggestComplementary),
    promotions: { couponIds: ids },
  };
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function hex(raw: unknown, fallback: string): string {
  return typeof raw === "string" && HEX_RE.test(raw.trim()) ? raw.trim().toLowerCase() : fallback;
}

function text(raw: unknown, max: number, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  // Plain text only - no markup ever reaches a visitor's page from config.
  const cleaned = raw.replace(/[<>]/g, "").trim().slice(0, max);
  return cleaned || fallback;
}

function url(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" ? u.toString().slice(0, 1024) : null;
  } catch {
    return null;
  }
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

export function defaultWebchatConfig(): WebchatConfig {
  return {
    v: 2,
    displayName: "Website Chat",
    appearance: {
      primaryColor: "#7c3aed",
      contrastColor: "#ffffff",
      logoUrl: null,
      cornerRadius: 20,
      language: "auto",
      direction: "auto",
      showPoweredBy: true,
    },
    ux: defaultShopifyChatUx(),
    nameSource: "employee",
    // The "talk to a person" button is opt-in (Omer, 2026-10-26): unset is off.
    // The employee's own handoff in the conversation (escalate_to_human) is not this.
    behaviour: { allowHumanHandoff: false },
    offline: { message: "We are away right now. Leave a message and we will get back to you." },
    commerce: { productMessagingEnabled: false, addToCartEnabled: false, suggestComplementary: false, promotions: { couponIds: [] } },
  };
}

/**
 * The widget's own copy in the workspace's language (2026-10-25: onboarding
 * created a Hebrew workspace's widget with every text in English, and the
 * first Settings save stored that English for good).
 *
 * Only what the merchant reads as "my widget's words": the name, the welcome,
 * the three questions, the offline line and the teaser. English is the
 * built-in default, so it has no entry here.
 */
export const WEBCHAT_COPY: Record<"he", {
  displayName: string; channelName: string;
  welcome: { title: string; subtitle: string; assistantName: string; suggestedQuestions: string[] };
  proactive: { title: string; message: string; actionLabel: string };
  offline: string;
}> = {
  he: {
    displayName: "\u05e6'\u05d0\u05d8 \u05d1\u05d0\u05ea\u05e8",
    channelName: "\u05e6'\u05d0\u05d8 \u05d1\u05d0\u05ea\u05e8",
    welcome: {
      title: "\u05d1\u05de\u05d4 \u05d0\u05e4\u05e9\u05e8 \u05dc\u05e2\u05d6\u05d5\u05e8?",
      subtitle: "\u05d0\u05e4\u05e9\u05e8 \u05dc\u05e9\u05d0\u05d5\u05dc \u05d0\u05d5\u05ea\u05e0\u05d5 \u05db\u05dc \u05d3\u05d1\u05e8 \u05e2\u05dc \u05d4\u05de\u05d5\u05e6\u05e8\u05d9\u05dd, \u05d5\u05e0\u05e2\u05d6\u05d5\u05e8 \u05dc\u05d1\u05d7\u05d5\u05e8.",
      assistantName: "\u05e6\u05d5\u05d5\u05ea \u05d4\u05d7\u05e0\u05d5\u05ea",
      suggestedQuestions: [
        "\u05d0\u05d9\u05d6\u05d4 \u05de\u05d5\u05e6\u05e8 \u05de\u05ea\u05d0\u05d9\u05dd \u05dc\u05d9?",
        "\u05d0\u05e4\u05e9\u05e8 \u05d4\u05de\u05dc\u05e6\u05d4 \u05e2\u05dc \u05de\u05e9\u05d4\u05d5 \u05e9\u05d9\u05ea\u05d0\u05d9\u05dd \u05dc\u05d9?",
        "\u05de\u05d4 \u05d9\u05e9 \u05db\u05e8\u05d2\u05e2 \u05d1\u05de\u05dc\u05d0\u05d9?",
      ],
    },
    proactive: {
      title: "\u05d9\u05e9 \u05e9\u05d0\u05dc\u05d4?",
      message: "\u05d0\u05e4\u05e9\u05e8 \u05dc\u05e9\u05d0\u05d5\u05dc \u05d0\u05d5\u05ea\u05e0\u05d5 \u05e2\u05dc \u05db\u05dc \u05de\u05d5\u05e6\u05e8 \u05e9\u05de\u05e2\u05e0\u05d9\u05d9\u05df \u05d0\u05ea\u05db\u05dd.",
      actionLabel: "\u05dc\u05e9\u05d9\u05d7\u05d4 \u05d0\u05d9\u05ea\u05e0\u05d5",
    },
    offline: "\u05d0\u05e0\u05d7\u05e0\u05d5 \u05dc\u05d0 \u05d6\u05de\u05d9\u05e0\u05d9\u05dd \u05db\u05e8\u05d2\u05e2. \u05d0\u05e4\u05e9\u05e8 \u05dc\u05d4\u05e9\u05d0\u05d9\u05e8 \u05d4\u05d5\u05d3\u05e2\u05d4 \u05d5\u05e0\u05d7\u05d6\u05d5\u05e8 \u05d1\u05d4\u05e7\u05d3\u05dd.",
  },
};

/**
 * The credentials a new widget is created with: its copy in the workspace's
 * language, and nothing else (every other field keeps its default). English,
 * or any other locale: `{}`, exactly as before. Carries `v: 2` so it is never
 * read as a legacy blob, and `nameSource: "employee"` because a non-empty
 * stored blob without one reads as "custom".
 */
export function webchatSeedConfig(locale: unknown): Record<string, unknown> {
  const c = locale === "he" ? WEBCHAT_COPY.he : null;
  if (!c) return {};
  return {
    v: 2,
    nameSource: "employee",
    displayName: c.displayName,
    ux: { welcome: { ...c.welcome, suggestedQuestions: [...c.welcome.suggestedQuestions] }, proactive: { ...c.proactive } },
    offline: { message: c.offline },
  };
}

/**
 * The one-click "my widget's words in Hebrew": a patch over the CURRENT
 * config that sets only the copy fields above. Appearance, hero, logo,
 * commerce, behaviour and the name source are left exactly as they are.
 */
export function webchatCopyResetPatch(current: WebchatConfig, locale: "he"): WebchatConfig {
  const c = WEBCHAT_COPY[locale];
  return normalizeWebchatConfig({
    displayName: c.displayName,
    ux: { ...current.ux, welcome: { ...current.ux.welcome, ...c.welcome }, proactive: { ...current.ux.proactive, ...c.proactive } },
    offline: { message: c.offline },
  }, current);
}

/**
 * The settings this widget had before it shared an experience with the
 * storefront one: a flat blob stored straight into `credentials`.
 *
 * `welcome` there was a single string - the first bubble the visitor saw -
 * which is the SUBTITLE of the new welcome screen, not its title. Reading
 * it as the title would replace every tenant's greeting with a sentence.
 */
export interface LegacyWebchatSettings {
  color?: unknown;
  iconUrl?: unknown;
  title?: unknown;
  subtitle?: unknown;
  welcome?: unknown;
  position?: unknown;
}

export function isLegacyWebchatSettings(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  if (r.v === 2) return false;
  // Any of the old flat keys, and none of the new structure.
  return ["color", "iconUrl", "title", "subtitle", "welcome", "position"].some((k) => k in r);
}

/**
 * Carry a tenant's existing branding into the shared experience.
 *
 * Nobody should log in after this ships and find their widget reset to
 * defaults, so every old field lands somewhere it means the same thing.
 */
export function migrateLegacyWebchat(
  legacy: LegacyWebchatSettings,
  base = defaultWebchatConfig(),
): WebchatConfig {
  const primary = hex(legacy.color, base.appearance.primaryColor);
  const side = oneOf(legacy.position, ["right", "left"] as const, "right");

  return {
    ...base,
    // A legacy widget was configured, its name included.
    nameSource: "custom",
    appearance: {
      ...base.appearance,
      primaryColor: primary,
      logoUrl: url(legacy.iconUrl) ?? base.appearance.logoUrl,
    },
    ux: {
      ...base.ux,
      launcher: {
        ...base.ux.launcher,
        backgroundColor: primary,
        position: side,
        mobilePosition: side,
      },
      welcome: normalizeWelcome(
        {
          title: text(legacy.title, 60, base.ux.welcome.title),
          // The old single-line `welcome` message becomes the subtitle: it
          // was a sentence, and a sentence is not a heading.
          subtitle: text(legacy.welcome, 200, base.ux.welcome.subtitle),
          assistantName: text(legacy.subtitle, 40, base.ux.welcome.assistantName),
          avatarUrl: url(legacy.iconUrl),
        },
        base.ux.welcome,
      ),
    },
  };
}

/**
 * Normalize whatever is stored, from any era, into the current shape.
 *
 * Never throws: this runs on a public request path, and a widget that
 * refuses to load because of a stray field is worse than one that falls
 * back to a sane default.
 */
export function normalizeWebchatConfig(raw: unknown, current?: WebchatConfig): WebchatConfig {
  const base = current ?? defaultWebchatConfig();
  if (isLegacyWebchatSettings(raw)) {
    return migrateLegacyWebchat(raw as LegacyWebchatSettings, base);
  }

  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const a = (s.appearance && typeof s.appearance === "object" ? s.appearance : {}) as Record<string, any>;
  const b = (s.behaviour && typeof s.behaviour === "object" ? s.behaviour : {}) as Record<string, any>;
  const o = (s.offline && typeof s.offline === "object" ? s.offline : {}) as Record<string, any>;

  return {
    v: 2,
    displayName: text(s.displayName, 60, base.displayName),
    appearance: {
      primaryColor: hex(a.primaryColor, base.appearance.primaryColor),
      contrastColor: hex(a.contrastColor, base.appearance.contrastColor),
      logoUrl: "logoUrl" in a ? url(a.logoUrl) : base.appearance.logoUrl,
      cornerRadius: Math.max(0, Math.min(28, Number(a.cornerRadius) || base.appearance.cornerRadius)),
      language: oneOf(a.language, ["auto", "en", "he"] as const, base.appearance.language),
      direction: oneOf(a.direction, ["auto", "ltr", "rtl"] as const, base.appearance.direction),
      showPoweredBy: effectivePoweredBy(a.showPoweredBy, base.appearance.showPoweredBy),
    },
    ux: normalizeShopifyChatUx(s.ux, base.ux),
    // Absent from a patch over the current config: unchanged. Absent from a
    // stored widget: configured before the field = "custom", never configured
    // ({}) = "employee".
    nameSource: oneOf(s.nameSource, WEBCHAT_NAME_SOURCES, current ? current.nameSource : Object.keys(s).length ? "custom" : base.nameSource),
    behaviour: { allowHumanHandoff: bool(b.allowHumanHandoff, base.behaviour.allowHumanHandoff) },
    offline: { message: text(o.message, 300, base.offline.message) },
    commerce: normalizeWebchatCommerce(s.commerce, base.commerce),
  };
}

/**
 * The ONLY configuration a visitor's browser ever receives.
 *
 * Deliberately the same shape the storefront widget is served, because it
 * is the same widget. Note what is absent: tenant id, channel account id,
 * widget id, and anything about routing or AI.
 */
export function publicWebchatConfig(
  config: WebchatConfig,
  opts: {
    offline: boolean;
    /** True only while the workspace's WooCommerce store is connected (W9). */
    storeConnected?: boolean;
  },
): {
  appearance: Record<string, unknown>;
  welcome: Record<string, unknown>;
  offline: Record<string, unknown>;
  features: { humanHandoff: boolean; productMessaging: boolean; addToCart: boolean; waHandoffMode?: "phone" | "code" | "off" };
  ux: ReturnType<typeof publicUx>;
} {
  return {
    appearance: {
      primaryColor: config.appearance.primaryColor,
      contrastColor: config.appearance.contrastColor,
      logoUrl: config.appearance.logoUrl,
      avatarUrl: config.ux.welcome.avatarUrl,
      launcherIcon: config.ux.launcher.icon,
      launcherPosition: config.ux.launcher.position,
      cornerRadius: config.appearance.cornerRadius,
      language: config.appearance.language,
      direction: config.appearance.direction,
      showPoweredBy: effectivePoweredBy(config.appearance.showPoweredBy),
    },
    // The legacy block the widget still reads as a fallback.
    welcome: {
      headline: config.ux.welcome.title,
      subline: config.ux.welcome.subtitle,
      assistantName: config.ux.welcome.assistantName,
      suggestedQuestions: config.ux.welcome.suggestedQuestions,
    },
    offline: {
      active: opts.offline,
      message: config.offline.message,
      behavior: "ai",
      formFields: [],
      consentRequired: false,
      consentText: "",
    },
    features: {
      humanHandoff: config.behaviour.allowHumanHandoff,
      // Products only when the merchant turned them on AND the store they
      // come from is connected now (W9).
      productMessaging: !!opts.storeConnected && config.commerce.productMessagingEnabled,
      addToCart: !!opts.storeConnected && config.commerce.addToCartEnabled,
    },
    ux: publicUx(config.ux),
  };
}

function publicUx(ux: ShopifyChatUx) {
  return {
    welcome: ux.welcome,
    launcher: ux.launcher,
    hero: ux.hero,
    proactive: { ...ux.proactive },
    sounds: ux.sounds,
    behavior: ux.behavior,
    kind: ux.kind,
    look: ux.kind === "whatsapp" ? "whatsapp" : ux.look,
  };
}
