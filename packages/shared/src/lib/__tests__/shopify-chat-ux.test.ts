/**
 * The merchant-configurable chat experience.
 *
 * Everything here is reached by a merchant typing into a form and by a
 * shopper's browser rendering the result, so the tests are weighted
 * toward the two ways that goes wrong: a config that is partial, ancient
 * or hostile, and an interruption rule that fires when it should not.
 */
import { describe, it, expect } from "vitest";
import {
  resolveWidgetState,
  defaultWelcome,
  normalizeWelcome,
  migrateLegacyWelcome,
  resolveHeroHeight,
  heroHeightWarning,
  showsHero,
  sanitizeMediaUrl,
  defaultLauncher,
  normalizeLauncher,
  defaultHero,
  normalizeHero,
  defaultProactive,
  normalizeProactive,
  shouldShowTeaser,
  defaultSounds,
  normalizeSounds,
  shouldPlaySound,
  defaultShopifyChatUx,
  normalizeShopifyChatUx,
  publicUxConfig,
  SHOPIFY_CHAT_UX_SCHEMA_VERSION,
} from "../shopify-chat-ux";

// ─── State machine ───────────────────────────────────────────

describe("widget state", () => {
  it("closed unless opened, and a teaser is a closed state", () => {
    expect(resolveWidgetState({ open: false })).toBe("CLOSED");
    expect(resolveWidgetState({ open: false, teaserVisible: true })).toBe("PROACTIVE_TEASER");
  });

  it("puts a live conversation ahead of the welcome hero", () => {
    // A returning shopper must never be shown marketing media above
    // their own messages.
    expect(resolveWidgetState({ open: true, hasConversation: true })).toBe("CONVERSATION");
    expect(resolveWidgetState({ open: true })).toBe("WELCOME");
  });

  it("lets an error outrank everything", () => {
    expect(
      resolveWidgetState({ open: true, hasConversation: true, hasError: true }),
    ).toBe("ERROR");
  });

  it("shows the hero only in welcome and offline", () => {
    expect(showsHero("WELCOME")).toBe(true);
    expect(showsHero("OFFLINE")).toBe(true);
    expect(showsHero("CONVERSATION")).toBe(false);
    expect(showsHero("CLOSED")).toBe(false);
  });
});

// ─── Media safety ────────────────────────────────────────────

describe("media URLs", () => {
  it("accepts ordinary https media", () => {
    expect(sanitizeMediaUrl("https://cdn.shopify.com/a/hero.jpg")).toBe(
      "https://cdn.shopify.com/a/hero.jpg",
    );
    expect(sanitizeMediaUrl("https://cdn.shopify.com/a/loop.gif")).toContain(".gif");
    expect(sanitizeMediaUrl("https://cdn.shopify.com/a/clip.mp4", "video")).toContain(".mp4");
  });

  it("refuses SVG outright, in both slots", () => {
    // An SVG is a document that can carry script. Convenience is not
    // worth an <img src> pointed at an attacker-controlled host.
    expect(sanitizeMediaUrl("https://evil.example/x.svg")).toBeNull();
    expect(sanitizeMediaUrl("https://evil.example/x.svgz")).toBeNull();
    expect(sanitizeMediaUrl("https://evil.example/x.svg", "video")).toBeNull();
  });

  it("refuses every non-https scheme", () => {
    expect(sanitizeMediaUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeMediaUrl("data:image/png;base64,iVBORw0KGgo=")).toBeNull();
    expect(sanitizeMediaUrl("http://cdn.example.com/a.jpg")).toBeNull();
    expect(sanitizeMediaUrl("blob:https://x/y")).toBeNull();
    expect(sanitizeMediaUrl("file:///etc/passwd")).toBeNull();
  });

  it("refuses a video URL in an image slot and vice versa", () => {
    expect(sanitizeMediaUrl("https://cdn.example.com/a.mp4", "image")).toBeNull();
    expect(sanitizeMediaUrl("https://cdn.example.com/a.jpg", "video")).toBeNull();
  });

  it("allows extensionless CDN paths, which are normal", () => {
    expect(sanitizeMediaUrl("https://cdn.example.com/media/abc123")).toBe(
      "https://cdn.example.com/media/abc123",
    );
  });

  it("shrugs off nonsense", () => {
    expect(sanitizeMediaUrl(null)).toBeNull();
    expect(sanitizeMediaUrl("")).toBeNull();
    expect(sanitizeMediaUrl(42 as any)).toBeNull();
    expect(sanitizeMediaUrl("not a url")).toBeNull();
  });
});

// ─── Launcher ────────────────────────────────────────────────

describe("launcher", () => {
  it("normalizes an empty object to the safe defaults", () => {
    expect(normalizeLauncher({})).toEqual(defaultLauncher());
    expect(normalizeLauncher(undefined)).toEqual(defaultLauncher());
    expect(normalizeLauncher("nonsense")).toEqual(defaultLauncher());
  });

  it("keeps the tap target above the accessibility floor", () => {
    expect(normalizeLauncher({ size: 10 }).size).toBe(44);
    expect(normalizeLauncher({ size: 9999 }).size).toBe(96);
  });

  it("falls back to a built-in icon when a custom one is unusable", () => {
    // Case 8: a rejected URL must not leave a broken image where the
    // launcher should be.
    const l = normalizeLauncher({ icon: "custom", iconUrl: "https://evil.example/x.svg" });
    expect(l.icon).toBe("chat");
    expect(l.iconUrl).toBeNull();
  });

  it("keeps a valid custom icon", () => {
    const l = normalizeLauncher({ icon: "custom", iconUrl: "https://cdn.example.com/i.png" });
    expect(l.icon).toBe("custom");
    expect(l.iconUrl).toBe("https://cdn.example.com/i.png");
  });

  it("rejects junk colours and shapes without throwing", () => {
    const l = normalizeLauncher({ backgroundColor: "red; }", shape: "triangle", shadow: 99 });
    expect(l.backgroundColor).toBe(defaultLauncher().backgroundColor);
    expect(l.shape).toBe("circle");
    expect(l.shadow).toBe(3);
  });

  it("strips markup out of the label", () => {
    expect(normalizeLauncher({ label: "<img onerror=x>Help" }).label).not.toContain("<");
  });
});

// ─── Hero ────────────────────────────────────────────────────

describe("welcome hero", () => {
  it("is off by default", () => {
    expect(defaultHero().mediaType).toBe("none");
  });

  it("downgrades to none when the media URL is refused", () => {
    // Otherwise every shopper gets a grey rectangle at the top of the chat.
    const h = normalizeHero({ mediaType: "image", mediaUrl: "javascript:alert(1)" });
    expect(h.mediaType).toBe("none");
    expect(h.mediaUrl).toBeNull();
  });

  it("keeps a valid image, gif and video hero", () => {
    expect(normalizeHero({ mediaType: "image", mediaUrl: "https://c.example.com/a.jpg" }).mediaType).toBe("image");
    expect(normalizeHero({ mediaType: "gif", mediaUrl: "https://c.example.com/a.gif" }).mediaType).toBe("gif");
    const v = normalizeHero({ mediaType: "video", mediaUrl: "https://c.example.com/a.mp4" });
    expect(v.mediaType).toBe("video");
    expect(v.mediaUrl).toContain(".mp4");
  });

  it("clamps layout numbers into a survivable range", () => {
    const h = normalizeHero({ height: 9999, fadeStrength: 300 });
    // 220 desktop / 180 mobile: 320 let a hero eat half the panel.
    expect(h.height).toBe(220);
    expect(normalizeHero({ mobileHeight: 9999 }).mobileHeight).toBe(180);
    expect(h.fadeStrength).toBe(100);
  });

  it("defaults short enough to leave room for content", () => {
    expect(defaultHero().height).toBe(124);
    expect(defaultHero().mobileHeight).toBe(108);
  });

  it("only accepts a well-formed focal point", () => {
    expect(normalizeHero({ focalPoint: "50% 20%" }).focalPoint).toBe("50% 20%");
    expect(normalizeHero({ focalPoint: "url(x)" }).focalPoint).toBe("50% 50%");
  });
});

// ─── Proactive teaser ────────────────────────────────────────

describe("proactive teaser", () => {
  const base = () => ({
    config: { ...defaultProactive(), enabled: true },
    isMobile: false,
    chatOpen: false,
    hasConversation: false,
    dismissedAt: null,
    shownThisSession: 0,
    shownEver: 0,
    isReturningVisitor: false,
    offline: false,
    path: "/products/x",
    now: 1_000_000_000_000,
  });

  it("is disabled by default", () => {
    expect(defaultProactive().enabled).toBe(false);
    expect(shouldShowTeaser({ ...base(), config: defaultProactive() })).toBe(false);
  });

  it("defaults to a teaser, not an auto-open, and to silence", () => {
    expect(defaultProactive().autoOpen).toBe(false);
    expect(defaultProactive().playSound).toBe(false);
    expect(defaultProactive().maxPerSession).toBe(1);
  });

  it("never fires while the chat is open", () => {
    expect(shouldShowTeaser({ ...base(), chatOpen: true })).toBe(false);
  });

  it("never fires once a conversation exists", () => {
    expect(shouldShowTeaser({ ...base(), hasConversation: true })).toBe(false);
  });

  it("respects a dismissal for the whole cooldown, then allows again", () => {
    const b = base();
    const justDismissed = b.now - 60_000;
    expect(shouldShowTeaser({ ...b, dismissedAt: justDismissed })).toBe(false);
    const longAgo = b.now - 25 * 3600_000;
    expect(shouldShowTeaser({ ...b, dismissedAt: longAgo })).toBe(true);
  });

  it("stops at the per-session and per-visitor ceilings", () => {
    expect(shouldShowTeaser({ ...base(), shownThisSession: 1 })).toBe(false);
    expect(shouldShowTeaser({ ...base(), shownEver: 3 })).toBe(false);
  });

  it("honours per-device switches", () => {
    const cfg = { ...defaultProactive(), enabled: true, mobileEnabled: false };
    expect(shouldShowTeaser({ ...base(), config: cfg, isMobile: true })).toBe(false);
    expect(shouldShowTeaser({ ...base(), config: cfg, isMobile: false })).toBe(true);
  });

  it("stays quiet outside business hours when asked to", () => {
    expect(shouldShowTeaser({ ...base(), offline: true })).toBe(false);
    const cfg = { ...defaultProactive(), enabled: true, respectBusinessHours: false };
    expect(shouldShowTeaser({ ...base(), config: cfg, offline: true })).toBe(true);
  });

  it("applies include and exclude paths", () => {
    const excluded = { ...defaultProactive(), enabled: true, excludeUrls: ["/checkout"] };
    expect(shouldShowTeaser({ ...base(), config: excluded, path: "/checkout/step" })).toBe(false);

    const included = { ...defaultProactive(), enabled: true, includeUrls: ["/products"] };
    expect(shouldShowTeaser({ ...base(), config: included, path: "/products/x" })).toBe(true);
    expect(shouldShowTeaser({ ...base(), config: included, path: "/pages/about" })).toBe(false);
  });

  it("refuses to enable a custom-event trigger with no event name", () => {
    // It could never fire, and a merchant would be left waiting.
    const c = normalizeProactive({ enabled: true, trigger: "custom_event", customEvent: "" });
    expect(c.enabled).toBe(false);
  });

  it("will not let a merchant configure an instant interruption", () => {
    expect(normalizeProactive({ delaySeconds: 0 }).delaySeconds).toBe(3);
  });
});

// ─── Sounds ──────────────────────────────────────────────────

describe("sounds", () => {
  const base = () => ({
    config: { ...defaultSounds(), enabled: true },
    event: "incoming_ai" as const,
    visitorMuted: false,
    userInteracted: true,
    chatOpen: true,
    tabVisible: true,
  });

  it("is off by default", () => {
    expect(defaultSounds().enabled).toBe(false);
    expect(shouldPlaySound({ ...base(), config: defaultSounds() })).toBe(false);
  });

  it("waits for a real user interaction", () => {
    // Browsers refuse audio before a gesture; trying anyway just logs an
    // error on the merchant's storefront.
    expect(shouldPlaySound({ ...base(), userInteracted: false })).toBe(false);
  });

  it("never plays for messages replayed from history", () => {
    expect(shouldPlaySound({ ...base(), fromHistory: true })).toBe(false);
  });

  it("never chimes 'sent' for a send that failed", () => {
    expect(shouldPlaySound({ ...base(), event: "outgoing", sendFailed: true })).toBe(false);
    expect(shouldPlaySound({ ...base(), event: "outgoing", sendFailed: false })).toBe(true);
  });

  it("obeys the visitor's mute over every merchant setting", () => {
    expect(shouldPlaySound({ ...base(), visitorMuted: true })).toBe(false);
  });

  it("respects per-event switches", () => {
    const cfg = { ...defaultSounds(), enabled: true, incomingAi: false };
    expect(shouldPlaySound({ ...base(), config: cfg })).toBe(false);
    expect(shouldPlaySound({ ...base(), config: cfg, event: "incoming_human" })).toBe(true);
  });

  it("can stay silent while the panel is closed", () => {
    const cfg = { ...defaultSounds(), enabled: true, playWhenClosed: false };
    expect(shouldPlaySound({ ...base(), config: cfg, chatOpen: false })).toBe(false);
    expect(shouldPlaySound({ ...base(), config: cfg, chatOpen: true })).toBe(true);
  });

  it("can stay silent while the tab is focused", () => {
    const cfg = { ...defaultSounds(), enabled: true, playWhenTabActive: false };
    expect(shouldPlaySound({ ...base(), config: cfg, tabVisible: true })).toBe(false);
    expect(shouldPlaySound({ ...base(), config: cfg, tabVisible: false })).toBe(true);
  });
});

// ─── The bundle ──────────────────────────────────────────────

describe("configuration bundle", () => {
  it("normalizes nothing at all into a complete object", () => {
    // Case 31: a channel written before any of this existed.
    const ux = normalizeShopifyChatUx(undefined);
    expect(ux).toEqual(defaultShopifyChatUx());
    expect(ux.schemaVersion).toBe(SHOPIFY_CHAT_UX_SCHEMA_VERSION);
    expect(ux.launcher.size).toBeGreaterThan(0);
    expect(Array.isArray(ux.proactive.excludeUrls)).toBe(true);
  });

  it("survives a half-written blob without losing the written half", () => {
    const ux = normalizeShopifyChatUx({ launcher: { size: 72 }, hero: null, sounds: "junk" });
    expect(ux.launcher.size).toBe(72);
    expect(ux.launcher.shape).toBe("circle");
    expect(ux.hero).toEqual(defaultHero());
    expect(ux.sounds).toEqual(defaultSounds());
  });

  it("drops unknown fields rather than carrying them forward", () => {
    const ux = normalizeShopifyChatUx({ launcher: { size: 60, evil: "<script>" } } as any);
    expect((ux.launcher as any).evil).toBeUndefined();
  });

  it("always stamps the current schema version", () => {
    expect(normalizeShopifyChatUx({ schemaVersion: 0 }).schemaVersion).toBe(
      SHOPIFY_CHAT_UX_SCHEMA_VERSION,
    );
  });

  it("exposes no internal identifiers to the storefront", () => {
    // Case 32.
    const body = JSON.stringify(publicUxConfig(defaultShopifyChatUx()));
    for (const leak of ["tenantId", "channelAccountId", "tenantIntegrationId", "accessToken", "secret"]) {
      expect(body).not.toContain(leak);
    }
  });
});

// ─── One welcome, not four ───────────────────────────────────
//
// The same ideas used to live in appearance.logoUrl, appearance.avatarUrl,
// welcome.headline, welcome.subline and welcome.suggestedQuestions, edited
// from four settings sections, with the renderer silently resolving the
// avatar as `hero.avatarUrl || appearance.logoUrl`. A merchant could not
// tell which control won. These pin the replacement.

describe("canonical welcome", () => {
  it("normalizes nothing into a complete, renderable object", () => {
    const w = normalizeWelcome(undefined);
    expect(w).toEqual(defaultWelcome());
    expect(Array.isArray(w.suggestedQuestions)).toBe(true);
  });

  it("strips markup out of merchant copy", () => {
    const w = normalizeWelcome({ title: "<img onerror=x>Hi", subtitle: "<script>bad</script>ok" });
    expect(w.title).not.toContain("<");
    expect(w.subtitle).not.toContain("<");
  });

  it("refuses an unsafe avatar without losing the rest", () => {
    const w = normalizeWelcome({ title: "Kept", avatarUrl: "https://evil.example/x.svg" });
    expect(w.avatarUrl).toBeNull();
    expect(w.title).toBe("Kept");
  });
});

describe("legacy migration", () => {
  const legacy = {
    appearance: { logoUrl: "https://cdn.example.com/logo.png", avatarUrl: null },
    welcome: {
      headline: "Old title",
      subline: "Old subtitle",
      assistantName: "Old assistant",
      suggestedQuestions: ["Old question"],
    },
  };

  it("carries an old channel across without losing anything", () => {
    const w = migrateLegacyWelcome(legacy);
    expect(w.title).toBe("Old title");
    expect(w.subtitle).toBe("Old subtitle");
    expect(w.assistantName).toBe("Old assistant");
    expect(w.suggestedQuestions).toEqual(["Old question"]);
    expect(w.avatarUrl).toBe("https://cdn.example.com/logo.png");
  });

  it("prefers avatarUrl over logoUrl, and the v1 hero avatar over both", () => {
    expect(
      migrateLegacyWelcome({
        ...legacy,
        appearance: { logoUrl: "https://cdn.example.com/logo.png", avatarUrl: "https://cdn.example.com/av.png" },
      }).avatarUrl,
    ).toBe("https://cdn.example.com/av.png");

    expect(
      migrateLegacyWelcome({ ...legacy, hero: { avatarUrl: "https://cdn.example.com/hero-av.png" } }).avatarUrl,
    ).toBe("https://cdn.example.com/hero-av.png");
  });

  it("lets a newly saved value beat every legacy value", () => {
    // The whole point: once a merchant edits the canonical field, no
    // stale legacy value may creep back over it.
    const w = migrateLegacyWelcome({ ...legacy, ux: { welcome: { title: "New title" } } });
    expect(w.title).toBe("New title");
    // ...and untouched fields still come from legacy rather than defaults.
    expect(w.subtitle).toBe("Old subtitle");
  });

  it("survives a channel with no legacy block at all", () => {
    expect(migrateLegacyWelcome({})).toEqual(defaultWelcome());
  });

  it("survives half a legacy block", () => {
    const w = migrateLegacyWelcome({ welcome: { headline: "Only a title" } as any });
    expect(w.title).toBe("Only a title");
    expect(w.subtitle).toBe(defaultWelcome().subtitle);
  });
});

describe("hero height is a preference, not a promise", () => {
  it("honours the configured height when there is room", () => {
    expect(resolveHeroHeight({ configured: 140, panelHeight: 640, isMobile: false })).toBe(140);
  });

  it("clamps on a short phone so content survives", () => {
    // 568px tall screen: a 180px hero would trap the last suggestion.
    const h = resolveHeroHeight({ configured: 180, panelHeight: 480, isMobile: true });
    expect(h).toBeLessThan(180);
    expect(h).toBeLessThanOrEqual(Math.round(480 * 0.28));
  });

  it("drops the hero entirely rather than render a stripe", () => {
    expect(resolveHeroHeight({ configured: 200, panelHeight: 320, isMobile: true })).toBe(0);
  });

  it("tells the merchant when their choice will not fit", () => {
    expect(heroHeightWarning({ configured: 140, panelHeight: 640, isMobile: false })).toBe("ok");
    expect(heroHeightWarning({ configured: 220, panelHeight: 480, isMobile: true })).toBe("tight");
    expect(heroHeightWarning({ configured: 200, panelHeight: 320, isMobile: true })).toBe("dropped");
  });
});

describe("welcome screen proportions", () => {
  // (1) The hero was taking a third of the panel and pushing the third
  // suggested question under the composer.
  it("defaults the hero to a size that leaves room for the conversation", () => {
    const h = defaultHero();
    expect(h.height).toBeGreaterThanOrEqual(115);
    expect(h.height).toBeLessThanOrEqual(135);
    expect(h.mobileHeight).toBeGreaterThanOrEqual(95);
    expect(h.mobileHeight).toBeLessThanOrEqual(120);
    expect(h.mobileHeight).toBeLessThan(h.height);
  });

  // (2) A merchant may configure any height; the panel still has the last
  // word, because a hero that leaves no room for a question is not a
  // taller hero, it is a broken welcome screen.
  it("never lets the hero take more than a quarter of the panel", () => {
    for (const panelHeight of [568, 640, 667, 844, 932, 1024]) {
      for (const isMobile of [true, false]) {
        const resolved = resolveHeroHeight({ configured: 320, panelHeight, isMobile });
        const share = resolved / panelHeight;
        expect(share).toBeLessThanOrEqual(isMobile ? 0.22 : 0.25);
      }
    }
  });

  it("drops the hero entirely rather than showing a stripe", () => {
    // 200px of panel cannot host a hero AND a usable welcome screen.
    expect(resolveHeroHeight({ configured: 190, panelHeight: 200, isMobile: true })).toBe(0);
    expect(heroHeightWarning({ configured: 190, panelHeight: 200, isMobile: true })).toBe("dropped");
  });

  it("tells the merchant when their height will not be honoured", () => {
    expect(heroHeightWarning({ configured: 124, panelHeight: 640, isMobile: false })).toBe("ok");
    expect(heroHeightWarning({ configured: 300, panelHeight: 640, isMobile: false })).toBe("tight");
  });

  it("honours a merchant's height when the panel can afford it", () => {
    // (12) Configurability is preserved — only impractical values are cut.
    expect(resolveHeroHeight({ configured: 120, panelHeight: 900, isMobile: false })).toBe(120);
    expect(normalizeHero({ height: 150 }).height).toBe(150);
    expect(normalizeHero({ mobileHeight: 96 }).mobileHeight).toBe(96);
  });

  // (11) A launcher that does not announce itself before being asked.
  it("defaults the launcher to a restrained size and offset", () => {
    const l = defaultLauncher();
    expect(l.size).toBeLessThanOrEqual(48);
    expect(l.size).toBeGreaterThanOrEqual(40);
    expect(l.offsetSide).toBeLessThanOrEqual(18);
    expect(l.offsetBottom).toBeLessThanOrEqual(18);
    expect(l.mobileOffsetBottom).toBeLessThanOrEqual(l.offsetBottom);
  });

  it("still lets a merchant make the launcher whatever they want", () => {
    const l = normalizeLauncher({ size: 72, shape: "pill", label: "Need help?", showLabel: true, shadow: 3 });
    expect(l.size).toBe(72);
    expect(l.shape).toBe("pill");
    expect(l.label).toBe("Need help?");
    expect(l.shadow).toBe(3);
  });

  it("opens with a question rather than a greeting that asks nothing", () => {
    const w = defaultWelcome();
    expect(w.title).toBe("How can I help?");
    // Merchant copy still wins; this is only the unconfigured default.
    expect(normalizeWelcome({ title: "Shalom" }).title).toBe("Shalom");
  });

  it("attaches the avatar to the hero rather than floating it below", () => {
    const w = defaultWelcome();
    expect(w.avatarOverlap).toBeGreaterThanOrEqual(28);
    expect(w.avatarSize).toBeLessThanOrEqual(60);
    // Overlap must not swallow the avatar whole.
    expect(w.avatarOverlap).toBeLessThan(w.avatarSize);
  });
});

describe("public widget payload", () => {
  it("carries presentation only, and nothing that identifies the tenant", () => {
    const ux = normalizeShopifyChatUx({
      welcome: { title: "Hi", avatarUrl: "https://cdn.example.com/a.png" },
      hero: { mediaType: "image", mediaUrl: "https://cdn.example.com/h.jpg" },
      launcher: { label: "Need help?" },
      proactive: { enabled: true, includeUrls: ["/products/*"] },
    });
    const pub = publicUxConfig(ux);
    const serialized = JSON.stringify(pub);

    // Everything a shopper's browser needs to draw the widget.
    expect(Object.keys(pub).sort()).toEqual(
      ["behavior", "hero", "launcher", "proactive", "sounds", "welcome"].sort(),
    );

    // ...and nothing it does not. These are the shapes that would matter
    // if one ever slipped in: an id, a secret, a routing decision.
    for (const forbidden of [
      "tenantId", "tenant_id", "channelAccountId", "channelId", "integrationId",
      "accessToken", "token", "secret", "apiKey", "webhookSecret",
      "aiAgentId", "departmentId", "systemPrompt", "instructions",
      "email", "phone", "shopDomain", "adminApi", "internal",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("does not gain fields when the merchant configures more", () => {
    // A regression here is silent: the widget keeps working and the extra
    // field is simply published to every storefront visitor.
    const bare = Object.keys(publicUxConfig(defaultShopifyChatUx())).sort();
    const rich = Object.keys(
      publicUxConfig(
        normalizeShopifyChatUx({
          welcome: { title: "x" }, hero: { mediaType: "video", mediaUrl: "https://cdn.example.com/v.mp4" },
          sounds: { enabled: true }, behavior: { openOnLoad: true },
        }),
      ),
    ).sort();
    expect(rich).toEqual(bare);
  });
});
