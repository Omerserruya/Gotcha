/**
 * The website chat widget's configuration.
 *
 * Weighted toward the migration, because the failure mode there is a
 * tenant logging in to find their widget reset to purple defaults with
 * their greeting gone - and toward the public projection, because that is
 * what reaches every visitor's browser on a customer's own website.
 */
import { describe, it, expect } from "vitest";
import {
  defaultWebchatConfig,
  normalizeWebchatConfig,
  migrateLegacyWebchat,
  isLegacyWebchatSettings,
  publicWebchatConfig,
} from "../webchat-widget";
import { defaultShopifyChatUx } from "../shopify-chat-ux";

describe("the shared experience", () => {
  it("uses the same experience block as the storefront widget", () => {
    // Not a copy: the same normalizer, so an option added for one channel
    // exists for the other and cannot drift.
    const cfg = defaultWebchatConfig();
    expect(Object.keys(cfg.ux).sort()).toEqual(Object.keys(defaultShopifyChatUx()).sort());
  });

  it("carries a launcher, hero, welcome, proactive teaser and sounds", () => {
    const { ux } = defaultWebchatConfig();
    for (const key of ["launcher", "hero", "welcome", "proactive", "sounds", "behavior"]) {
      expect(ux).toHaveProperty(key);
    }
  });
});

describe("migrating a widget configured before the two shared an editor", () => {
  const LEGACY = {
    color: "#0ea5e9",
    iconUrl: "https://cdn.example.com/logo.png",
    title: "Talk to us",
    subtitle: "Support team",
    welcome: "Hi! Ask us anything and we will get back to you quickly.",
    position: "left",
  };

  it("is recognised as the old flat shape", () => {
    expect(isLegacyWebchatSettings(LEGACY)).toBe(true);
    expect(isLegacyWebchatSettings(defaultWebchatConfig())).toBe(false);
    expect(isLegacyWebchatSettings(null)).toBe(false);
    expect(isLegacyWebchatSettings({})).toBe(false);
  });

  it("keeps the tenant's brand colour, on the launcher too", () => {
    const cfg = migrateLegacyWebchat(LEGACY);
    expect(cfg.appearance.primaryColor).toBe("#0ea5e9");
    expect(cfg.ux.launcher.backgroundColor).toBe("#0ea5e9");
  });

  it("keeps the launcher on the side it was on", () => {
    expect(migrateLegacyWebchat(LEGACY).ux.launcher.position).toBe("left");
    expect(migrateLegacyWebchat({ ...LEGACY, position: "right" }).ux.launcher.position).toBe("right");
  });

  it("reads the old welcome MESSAGE as the subtitle, not the title", () => {
    // It was the first bubble a visitor saw - a sentence. Promoting it to
    // the heading would replace every tenant's greeting with a paragraph.
    const cfg = migrateLegacyWebchat(LEGACY);
    expect(cfg.ux.welcome.title).toBe("Talk to us");
    expect(cfg.ux.welcome.subtitle).toBe("Hi! Ask us anything and we will get back to you quickly.");
    expect(cfg.ux.welcome.assistantName).toBe("Support team");
  });

  it("keeps the tenant's icon as both logo and assistant avatar", () => {
    const cfg = migrateLegacyWebchat(LEGACY);
    expect(cfg.appearance.logoUrl).toBe("https://cdn.example.com/logo.png");
    expect(cfg.ux.welcome.avatarUrl).toBe("https://cdn.example.com/logo.png");
  });

  it("falls back to defaults for anything the tenant never set", () => {
    const cfg = migrateLegacyWebchat({ color: "#0ea5e9" });
    const base = defaultWebchatConfig();
    expect(cfg.ux.welcome.title).toBe(base.ux.welcome.title);
    expect(cfg.appearance.logoUrl).toBeNull();
  });

  it("refuses an icon that is not https", () => {
    expect(migrateLegacyWebchat({ ...LEGACY, iconUrl: "http://cdn.example.com/x.png" }).appearance.logoUrl).toBeNull();
    expect(migrateLegacyWebchat({ ...LEGACY, iconUrl: "javascript:alert(1)" }).appearance.logoUrl).toBeNull();
  });

  it("migrates on read, so a stored legacy blob needs no separate backfill", () => {
    const cfg = normalizeWebchatConfig(LEGACY);
    expect(cfg.v).toBe(2);
    expect(cfg.appearance.primaryColor).toBe("#0ea5e9");
  });
});

describe("normalising", () => {
  it("survives junk without throwing", () => {
    // This runs on a public request path. A widget that refuses to load
    // because of a stray field is worse than one that uses a default.
    for (const junk of [null, undefined, 42, "x", [], { ux: "nonsense" }, { appearance: 7 }]) {
      expect(() => normalizeWebchatConfig(junk)).not.toThrow();
    }
    expect(normalizeWebchatConfig(null).v).toBe(2);
  });

  it("refuses a colour that is not a hex colour", () => {
    expect(normalizeWebchatConfig({ v: 2, appearance: { primaryColor: "url(javascript:alert(1))" } }).appearance.primaryColor)
      .toBe(defaultWebchatConfig().appearance.primaryColor);
  });

  it("strips markup from anything a visitor will see", () => {
    const cfg = normalizeWebchatConfig({ v: 2, offline: { message: "<script>alert(1)</script>Away" } });
    expect(cfg.offline.message).not.toContain("<");
    expect(cfg.offline.message).toContain("Away");
  });

  it("keeps a round trip stable", () => {
    const once = normalizeWebchatConfig({ v: 2, displayName: "Site chat", appearance: { primaryColor: "#111827" } });
    expect(normalizeWebchatConfig(once)).toEqual(once);
  });
});

describe("what reaches a visitor's browser", () => {
  const cfg = normalizeWebchatConfig({
    v: 2,
    appearance: { primaryColor: "#111827" },
    ux: { welcome: { title: "How can I help?" } },
  });

  it("is the same shape the storefront widget is served", () => {
    const pub = publicWebchatConfig(cfg, { offline: false });
    expect(Object.keys(pub).sort()).toEqual(["appearance", "features", "offline", "ux", "welcome"]);
  });

  it("says there are no products, because a website widget has no catalogue", () => {
    const pub = publicWebchatConfig(cfg, { offline: false });
    expect(pub.features.productMessaging).toBe(false);
    expect(pub.features.addToCart).toBe(false);
  });

  it("leaks no identifiers", () => {
    const serialized = JSON.stringify(publicWebchatConfig(cfg, { offline: false }));
    for (const forbidden of ["tenantId", "channelAccountId", "widgetId", "externalId", "credentials", "aiAgentId", "departmentId"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("reports closed when the business is closed", () => {
    expect(publicWebchatConfig(cfg, { offline: true }).offline).toMatchObject({ active: true });
    expect(publicWebchatConfig(cfg, { offline: false }).offline).toMatchObject({ active: false });
  });
});
