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

export const WEBCHAT_CHANNEL = "WEBCHAT" as const;

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
  behaviour: {
    /** Offer "talk to a person" in the composer footer. */
    allowHumanHandoff: boolean;
  };
  /** Copy shown when the business is closed. Availability itself is the tenant's. */
  offline: {
    message: string;
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
    behaviour: { allowHumanHandoff: true },
    offline: { message: "We are away right now. Leave a message and we will get back to you." },
  };
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
export function normalizeWebchatConfig(raw: unknown, base = defaultWebchatConfig()): WebchatConfig {
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
      showPoweredBy: bool(a.showPoweredBy, base.appearance.showPoweredBy),
    },
    ux: normalizeShopifyChatUx(s.ux, base.ux),
    behaviour: { allowHumanHandoff: bool(b.allowHumanHandoff, base.behaviour.allowHumanHandoff) },
    offline: { message: text(o.message, 300, base.offline.message) },
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
  opts: { offline: boolean },
): {
  appearance: Record<string, unknown>;
  welcome: Record<string, unknown>;
  offline: Record<string, unknown>;
  features: { humanHandoff: boolean; productMessaging: boolean; addToCart: boolean };
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
      showPoweredBy: config.appearance.showPoweredBy,
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
      // A website widget has no catalogue to show.
      productMessaging: false,
      addToCart: false,
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
  };
}
