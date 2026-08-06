/**
 * Shopify Live Chat - the storefront widget itself.
 *
 * This drives the REAL `public/widget/gotcha-shopify-chat.js` inside
 * jsdom, because that file is the only part of the feature that runs on
 * a merchant's own page next to their theme. It ships without a bundler
 * or a framework, so a type checker cannot catch anything here: this is
 * the safety net.
 *
 * What matters most and is asserted below:
 *   - a hostile product title or message body can never become markup
 *   - Add to Cart posts the SERVER's variant id to the theme's own cart
 *   - a product with real options does not get one picked for the shopper
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

const WIDGET_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../../../../public/widget/gotcha-shopify-chat.js"),
  "utf8",
);

const SHOP = "demo-store.myshopify.com";

function makeProduct(overrides: Record<string, any> = {}) {
  return {
    productId: "111",
    handle: "cloud-pro",
    title: "Cloud Pro Runner",
    imageUrl: "https://cdn.shopify.com/s/files/1/x.jpg",
    productUrl: `https://${SHOP}/products/cloud-pro`,
    currency: "USD",
    price: "120.00",
    compareAtPrice: "150.00",
    available: true,
    published: true,
    selectedVariantId: null,
    optionNames: ["Size"],
    variants: [
      { variantId: "9001", title: "41", price: "120.00", compareAtPrice: "150.00", available: true, options: ["41"], requiresSellingPlan: false },
      { variantId: "9002", title: "42", price: "120.00", compareAtPrice: null, available: false, options: ["42"], requiresSellingPlan: false },
    ],
    reason: "Lighter cushioning.",
    ...overrides,
  };
}

interface Harness {
  app: any;
  shadow: ShadowRoot;
  post: ReturnType<typeof vi.fn>;
  fetchMock: ReturnType<typeof vi.fn>;
  storeData: Record<string, string>;
}

/**
 * Boot the widget the way a storefront does, then open it.
 *
 * A returning shopper is the interesting case for almost everything
 * here, so the harness seeds a conversation id and opens the panel; the
 * history comes back from the stubbed /conversation call.
 */
async function boot(
  options: {
    messages?: any[];
    features?: Record<string, boolean>;
    ux?: any;
    /** Merchant branding, so accent-colour behaviour can be tested with a real second brand. */
    appearance?: Record<string, any>;
    /** Wire the visitor mute control, which only renders when the host offers it. */
    sounds?: boolean;
    /** Settings-editor preview: renders everything, takes nothing (not even focus). */
    preview?: boolean;
  } = {},
): Promise<Harness> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const storeData: Record<string, string> = { session: "opaque-session-token", conversation: "conv1" };

  const post = vi.fn(async (path: string) => {
    if (path.endsWith("/conversation")) {
      return { data: { conversationId: "conv1", status: "OPEN", isHandedOver: false, messages: options.messages ?? [] } };
    }
    if (path.endsWith("/cart/validate")) {
      // The server hands back the variant it is willing to stand behind.
      return { data: { variantId: "9001", quantity: 1, price: "120.00", currency: "USD", title: "Cloud Pro Runner", variantTitle: "41", productUrl: "https://x" } };
    }
    return { data: {} };
  });

  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ items: [] }),
  })) as any;
  (globalThis as any).fetch = fetchMock;

  const state = {
    api: "https://api.gotcha.co.il",
    assets: "https://app.gotcha.co.il",
    context: { pageType: "product", productHandle: "cloud-pro", locale: "en" },
    availability: "online",
    store: {
      get: (k: string) => storeData[k] ?? null,
      set: (k: string, v: string) => { storeData[k] = v; },
      del: (k: string) => { delete storeData[k]; },
    },
    post,
    shadow,
    ...(options.preview ? { preview: true } : {}),
    setUnread: vi.fn(),
    onOpened: vi.fn(),
    onClosed: vi.fn(),
    // The mute button is offered only when the bootstrap can actually
    // mute anything, so the widget checks for these before rendering it.
    ...(options.sounds
      ? (() => {
          let muted = false;
          return {
            visitorMuted: () => muted,
            setVisitorMuted: (v: boolean) => { muted = v; },
          };
        })()
      : {}),
    widget: {
      appearance: {
        ...{
        primaryColor: "#111827",
        contrastColor: "#ffffff",
        logoUrl: null,
        avatarUrl: null,
        launcherIcon: "chat",
        launcherPosition: "right",
        cornerRadius: 20,
        language: "en",
        direction: "auto",
        showPoweredBy: true,
        },
        ...(options.appearance ?? {}),
      },
      welcome: {
        headline: "Hi there",
        subline: "Ask us anything.",
        assistantName: "Store Assistant",
        suggestedQuestions: ["Which product is right for me?"],
      },
      offline: { active: false, message: "Away", behavior: "ai", formFields: [], consentRequired: false, consentText: "" },
      features: { humanHandoff: true, productMessaging: true, addToCart: true, ...(options.features ?? {}) },
      ux: options.ux,
    },
  };

  const factory = (window as any).__gotchaShopifyChatApp;
  const app = factory(state);
  app.open();
  await new Promise((r) => setTimeout(r, 20));
  return { app, shadow, post, fetchMock, storeData };
}

beforeEach(() => {
  document.body.innerHTML = "";
  // jsdom has no matchMedia; the widget uses it to tell phone from desktop.
  (window as any).matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  // eslint-disable-next-line no-eval
  (0, eval)(WIDGET_SOURCE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Rendering ──────────────────────────────────────────────

describe("welcome polish", () => {
  function css(shadow: ShadowRoot) {
    return Array.from(shadow.querySelectorAll("style")).map((n) => n.textContent ?? "").join("\n");
  }

  // (3) The touch target and the visible control are no longer the same
  // size. 44x44 stays because it is the accessibility floor for the
  // shopper's way out; the chip you can actually see is 30px, because at
  // 44 it was the loudest thing in the hero.
  it("keeps a 44px target while the visible chip is 30px", async () => {
    const sheet = css((await boot({ messages: [], ux: hero() })).shadow);
    expect(sheet).toContain(".x,.mute{width:44px;height:44px;min-width:44px;min-height:44px;");
    expect(sheet).toContain(".x::before,.mute::before{content:'';position:absolute;width:30px;height:30px;");
    expect(sheet).toContain(".x svg,.mute svg{position:relative;width:15px;height:15px;");
  });

  it("gives the chip its own contrast over a photograph", async () => {
    // A merchant's hero can be any colour; the way out must be legible on
    // all of them without being a black disc on a pale one.
    const sheet = css((await boot({ messages: [], ux: hero() })).shadow);
    expect(sheet).toContain(".panel[data-view='welcome'][data-hero='1'] .x::before{background:rgba(15,23,42,.32);");
    expect(sheet).toContain("backdrop-filter:blur(8px)");
    // ...and stays quiet everywhere else.
    expect(sheet).toContain(".x::before,.mute::before{content:'';position:absolute;width:30px;height:30px;border-radius:50%;");
    expect(sheet).toContain("background:rgba(15,23,42,.06);");
  });

  // (4) One scale, referenced by name, instead of a number per rule.
  it("declares a single spacing scale the layout refers to", async () => {
    const sheet = css((await boot({ messages: [] })).shadow);
    expect(sheet).toContain("--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:20px;");
    expect(sheet).toContain("--pad:16px;");
    // The rules consume the scale rather than restating pixels.
    expect(sheet).toContain(".wel{display:flex;flex-direction:column;gap:var(--s3);");
    expect(sheet).toContain(".sug{display:flex;flex-direction:column;gap:var(--s1);}");
    expect(sheet).toContain("padding:var(--pad) var(--pad) var(--s4);");
  });

  it("hangs the avatar off the hero with no margin of its own", async () => {
    // The gap to the title belongs to .wel, so there is one number to tune
    // rather than a margin here fighting a gap there.
    const h = await boot({
      messages: [],
      ux: { ...hero(), welcome: { avatarUrl: "https://cdn.example.com/a.png" } },
    });
    const av = h.shadow.querySelector(".wel-av") as HTMLImageElement;
    expect(av.style.marginTop).toBe("-30px");
    expect(css(h.shadow)).toContain("box-shadow:0 3px 10px rgba(15,23,42,.14);margin-bottom:0;");
  });

  it("groups the title and subtitle so they read as one thought", async () => {
    const h = await boot({ messages: [] });
    const copy = h.shadow.querySelector(".wel-cp")!;
    expect(copy.querySelector(".wel-h")).toBeTruthy();
    expect(copy.querySelector(".wel-s")).toBeTruthy();
    // A tighter gap inside the pair than between it and the questions.
    expect(css(h.shadow)).toContain(".wel-cp{display:flex;flex-direction:column;gap:var(--s1);}");
  });

  it("gives the subtitle a measure so it breaks where a person would", async () => {
    expect(css((await boot({ messages: [] })).shadow)).toContain("max-width:34ch;");
  });

  // (5) Compact suggestions.
  it("sizes suggested questions compactly", async () => {
    const sheet = css((await boot({ messages: [] })).shadow);
    expect(sheet).toContain("border-radius:11px;padding:9px 12px;font:inherit;font-size:13.5px;line-height:1.35;");
    // Still a usable target.
    expect(sheet).toContain("min-height:38px;");
  });

  // (6) A long question wraps rather than being clipped or ellipsised.
  it("lets a long question wrap instead of clipping it", async () => {
    const sheet = css((await boot({ messages: [] })).shadow);
    expect(sheet).not.toMatch(/\.sug-b\{[^}"]*white-space:nowrap/);
    expect(sheet).not.toMatch(/\.sug-b\{[^}"]*text-overflow:ellipsis/);
    // align-items:center rather than a fixed height, so two lines fit.
    expect(sheet).toContain("display:flex;align-items:center;");
  });

  it("collapses a fourth question behind a quiet toggle", async () => {
    const h = await boot({
      messages: [],
      ux: { welcome: { suggestedQuestions: ["one", "two", "three", "four", "five"] } },
    });
    const shown = () => Array.from(h.shadow.querySelectorAll(".sug-b")).filter((b) => !(b as HTMLElement).hidden);
    expect(shown()).toHaveLength(3);

    const more = h.shadow.querySelector(".sug-more") as HTMLButtonElement;
    expect(more).toBeTruthy();
    expect(more.textContent).toBe("Show 2 more");

    more.click();
    // All of them reachable, and the toggle gets out of the way.
    expect(shown()).toHaveLength(5);
    expect(h.shadow.querySelector(".sug-more")).toBeNull();
  });

  it("shows no toggle when everything already fits", async () => {
    const h = await boot({ messages: [], ux: { welcome: { suggestedQuestions: ["one", "two", "three"] } } });
    expect(h.shadow.querySelector(".sug-more")).toBeNull();
    expect(h.shadow.querySelectorAll(".sug-b")).toHaveLength(3);
  });

  // (8, 9) Composer.
  it("defaults the composer to one line and bounds its growth", async () => {
    const sheet = css((await boot({ messages: [] })).shadow);
    expect(sheet).toContain("min-height:38px;");
    expect(sheet).toContain("max-height:104px;");
    expect(sheet).toContain(".ft{border-top:1px solid #f0f3f7;padding:var(--s2) var(--s3);");
    expect(sheet).toContain(".snd{width:38px;height:38px;");
  });

  it("keeps the composer a flex sibling of the scroll region, never an overlay", async () => {
    // An absolutely-positioned composer is how content ends up trapped
    // underneath it.
    const sheet = css((await boot({ messages: [] })).shadow);
    expect(sheet).toContain(".ft{border-top:1px solid #f0f3f7;");
    expect(sheet).toMatch(/\.ft\{[^}"]*(?!position:absolute)/);
    expect(sheet).toContain("flex:0 0 auto;}");
    expect(sheet).toContain(".bd{flex:1 1 auto;min-height:0;overflow-y:auto;");
  });

  it("respects the iOS safe area at the bottom of the composer", async () => {
    expect(css((await boot({ messages: [] })).shadow)).toContain("padding-bottom:calc(var(--s2) + env(safe-area-inset-bottom));");
  });

  // (10) Footer.
  it("keeps the footer row thin", async () => {
    const sheet = css((await boot({ messages: [] })).shadow);
    expect(sheet).toContain(".sub{display:flex;align-items:center;justify-content:space-between;gap:var(--s2);margin-top:var(--s1);}");
    expect(sheet).toContain(".pw{font-size:10.5px;");
    expect(sheet).toContain("font-size:11.5px;color:#64748b;");
  });

  // (13) The accent is the merchant's, and it lands on interaction rather
  // than on every border at rest.
  it("threads the merchant's accent through the interactive states", async () => {
    const h = await boot({ messages: [] });
    const sheet = css(h.shadow);
    // #111827 is this fixture's configured primaryColor.
    expect(sheet).toContain(".sug-b:hover{border-color:#111827;background:#1118270b;");
    expect(sheet).toContain(".snd{width:38px;height:38px;flex:0 0 auto;border-radius:10px;border:0;background:#111827;");
    expect(sheet).toContain(".ta:focus{outline:none;border-color:#111827;");
    // Neutral borders stay neutral and quiet.
    expect(sheet).toContain("border:1px solid #e8edf3;");
  });

  it("uses no hardcoded brand colour for the accent", async () => {
    // A different merchant, a different accent, everywhere it matters.
    const h = await boot({ messages: [], appearance: { primaryColor: "#7c3aed", contrastColor: "#ffffff" } });
    const sheet = css(h.shadow);
    expect(sheet).toContain("background:#7c3aed;");
    expect(sheet).toContain(".sug-b:hover{border-color:#7c3aed;");
    expect(sheet).not.toContain("#111827");
  });

  // (18) RTL.
  it("mirrors the close control and the toggle for RTL", async () => {
    const h = await boot({ messages: [], appearance: { language: "he", direction: "rtl" } });
    const sheet = css(h.shadow);
    expect(sheet).toContain("position:absolute;top:var(--s2);left:var(--s2);");
    // The toggle is NOT flipped by hand any more. In a COLUMN flex
    // container `align-self` runs along the inline axis, so `flex-start`
    // already resolves to the right in RTL; flipping it here as well was
    // a double flip that put the toggle opposite the questions it belongs
    // to. Asserting the un-flipped value is what keeps it un-flipped.
    expect(sheet).toContain(".sug-more{align-self:flex-start;");
    expect(sheet).not.toContain(".sug-more{align-self:flex-end;");
  });

  // (19) Every hero media type still lays out.
  for (const mediaType of ["image", "gif", "video"] as const) {
    it(`lays out a ${mediaType} hero`, async () => {
      const url = mediaType === "video" ? "https://cdn.example.com/c.mp4" : "https://cdn.example.com/h.jpg";
      const h = await boot({ messages: [], ux: { hero: { mediaType, mediaUrl: url, height: 124, mobileHeight: 108 } } });
      const heroEl = h.shadow.querySelector(".hero") as HTMLElement;
      expect(heroEl).toBeTruthy();
      expect(heroEl.style.height).toBe("124px");
      expect(h.shadow.querySelector(mediaType === "video" ? "video.hero-m" : "img.hero-m")).toBeTruthy();
    });
  }
});

describe("panel layout", () => {
  // The storefront panel is 640px tall. Every pixel the chrome takes is a
  // pixel the conversation does not get, and the welcome screen was
  // spending ~72px on a header that named an assistant the shopper had
  // not spoken to yet, above a 10px white gap, above the hero.
  function css(shadow: ShadowRoot) {
    return Array.from(shadow.querySelectorAll("style")).map((n) => n.textContent ?? "").join("\n");
  }

  it("gives the welcome screen no conversation header at all - when a hero owns the top edge", async () => {
    const { shadow } = await boot({ messages: [], ux: hero() });
    expect(shadow.querySelector(".panel")!.getAttribute("data-view")).toBe("welcome");
    expect(shadow.querySelector(".panel")!.getAttribute("data-hero")).toBe("1");
    expect(css(shadow)).toContain(".panel[data-view='welcome'][data-hero='1'] .hd{display:none;}");
  });

  it("keeps the header when the welcome screen has NO hero", async () => {
    // Hiding it unconditionally left a bare white strip with the title
    // against the top edge and the close button - restyled white for
    // legibility over a photograph - invisible on it. Merchants went looking
    // for a blank placeholder image to prop the thing open.
    const { shadow } = await boot({ messages: [] });
    const panel = shadow.querySelector(".panel")!;
    expect(panel.getAttribute("data-view")).toBe("welcome");
    expect(panel.hasAttribute("data-hero")).toBe(false);
  });

  it("gives the welcome screen a floor as well as a ceiling", async () => {
    // Hugging the content is right WITH a hero; without one the same rule
    // collapsed the card to about half its height, which reads as broken.
    const sheet = css((await boot({ messages: [] })).shadow);
    expect(sheet).toContain("min-height:min(430px, calc(100vh - 120px))");
    expect(sheet).toContain("max-height:min(640px, calc(100vh - 120px))");
  });

  it("switches to the conversation view once there are messages", async () => {
    const now = new Date().toISOString();
    const { shadow } = await boot({
      messages: [{ id: "a", direction: "OUTBOUND", body: "hello", messageType: "text", author: "A", authorKind: "ai", createdAt: now, commerce: null }],
    });
    expect(shadow.querySelector(".panel")!.getAttribute("data-view")).toBe("conversation");
    expect(shadow.querySelector(".hd")).toBeTruthy();
  });

  it("keeps the conversation header compact", async () => {
    // 44px of chrome, not 72. The avatar shrinks with it.
    const { shadow } = await boot({ messages: [] });
    const sheet = css(shadow);
    expect(sheet).toContain("min-height:44px;max-height:48px;");
    expect(sheet).toContain(".hd-av{width:30px;height:30px;");
  });

  it("truncates a long assistant name instead of wrapping the header", async () => {
    const { shadow } = await boot({ messages: [] });
    expect(css(shadow)).toContain("text-overflow:ellipsis;");
  });

  it("removes the white gap above the hero", async () => {
    // The gap was .wel's own padding-top surviving the hero's negative
    // margin. In the welcome view the hero owns the panel's top edge.
    const sheet = css((await boot({ messages: [], ux: hero() })).shadow);
    expect(sheet).toContain(".panel[data-view='welcome'][data-hero='1'] .bd{padding-top:0;}");
    expect(sheet).toContain(".panel[data-view='welcome'][data-hero='1'] .wel{padding-top:0;}");
    expect(sheet).toContain(".panel[data-view='welcome'][data-hero='1'] .hero{margin-top:0;");
  });

  it("takes the caret on open, but never in a preview", async () => {
    // The settings editor rebuilds this widget on every keystroke. Focusing
    // the composer here pulled the merchant's caret out of the field they
    // were typing in, one character at a time, so they had to click back
    // into the box per letter.
    const live = await boot({ messages: [] });
    await new Promise((r) => setTimeout(r, 120));
    const focusedLive = live.shadow.activeElement;

    document.body.innerHTML = "";
    const preview = await boot({ messages: [], preview: true });
    const before = preview.shadow.activeElement;
    await new Promise((r) => setTimeout(r, 120));

    expect(focusedLive).not.toBeNull();
    expect(preview.shadow.activeElement).toBe(before);
  });

  it("hangs the close button off the panel, not the header", async () => {
    // Otherwise hiding the header in the welcome view would take the only
    // way out with it.
    const { shadow } = await boot({ messages: [], ux: hero() });
    const x = shadow.querySelector('[data-act="close"]')!;
    expect(x).toBeTruthy();
    expect((x.parentElement as HTMLElement).className).toContain("panel");
  });

  it("does not stack the mute button on top of the close button", async () => {
    // They look identical and must not be positioned identically. Sharing
    // one class meant sharing `position:absolute`, which put the mute
    // button exactly on the close button on a live storefront.
    const h = await boot({
      messages: [],
      ux: { sounds: { enabled: true } },
      sounds: true,
    });
    const sheet = css(h.shadow);
    // The look is shared...
    expect(sheet).toContain(".x,.mute{width:44px;height:44px;");
    expect(sheet).toContain(".x::before,.mute::before{content:'';position:absolute;width:30px;height:30px;");
    // ...the placement is not. Only the close button leaves the flow.
    expect(sheet).toContain(".x{position:absolute;top:var(--s2);");
    expect(sheet).toContain(".mute{flex:0 0 auto;}");
    expect(sheet).not.toMatch(/\.mute\{[^}"]*position:absolute/);
  });

  it("reserves the close button's corner with logical padding", async () => {
    // A physical `padding-right` reserves the wrong corner in RTL, where
    // the close button is on the left - which is how the mute button ended
    // up underneath it again in Hebrew.
    const sheet = css((await boot({ messages: [] })).shadow);
    expect(sheet).toContain("padding-block:6px;padding-inline:14px 56px;");
    expect(sheet).not.toContain("padding:6px 56px 6px 14px");
  });

  it("gives the mute button its own stable hook", async () => {
    const h = await boot({ messages: [], ux: { sounds: { enabled: true } }, sounds: true });
    const mute = h.shadow.querySelector('[data-act="mute"]');
    const close = h.shadow.querySelector('[data-act="close"]');
    expect(mute).toBeTruthy();
    expect(close).toBeTruthy();
    expect(mute).not.toBe(close);
    // A verification script once clicked mute believing it was close.
    expect((mute as HTMLElement).className).not.toContain("x");
  });

  it("still closes from the welcome screen, where there is no header", async () => {
    const { shadow } = await boot({ messages: [], ux: hero() });
    const panel = shadow.querySelector(".panel") as HTMLElement;
    (shadow.querySelector('[data-act="close"]') as HTMLElement).click();
    expect(panel.getAttribute("data-state")).toBe("closed");
    expect(panel.hidden).toBe(true);
  });

  it("declares the close button's position exactly once", async () => {
    // Two `.x{...}` blocks in one stylesheet is not a style nit: the
    // second one said `position:relative`, which put a 44px close button
    // into the panel's column flow and opened a white gap above the hero.
    const sheet = css((await boot({ messages: [] })).shadow);
    const positions = (sheet.match(/\.x\{[^}]*position:/g) ?? []).length;
    expect(positions).toBe(1);
    expect(sheet).toContain("position:absolute;top:var(--s2);");
  });

  it("sizes the header with border-box so min-height means what it says", async () => {
    // Without it, min-height:44 plus padding and a border measured 57px.
    expect(css((await boot({ messages: [] })).shadow)).toContain("box-sizing:border-box;border-bottom:1px solid #eef1f5;min-height:44px;");
  });

  it("leaves room below the last suggestion so the composer cannot cover it", async () => {
    expect(css((await boot({ messages: [] })).shadow)).toContain("padding:var(--pad) var(--pad) var(--s4);");
  });
});

describe("welcome state", () => {
  it("shows a monogram when the merchant has not uploaded a logo", async () => {
    // A solid block of brand colour reads as a broken image.
    const { shadow } = await boot();
    const avatar = shadow.querySelector(".hd-av")!;
    expect(avatar.tagName).toBe("DIV");
    expect(avatar.textContent).toBe("S");
  });

  it("labels only the first message of a run", async () => {
    // Repeating the assistant's name above every consecutive bubble
    // reads like several different people talking.
    const now = new Date().toISOString();
    const { shadow } = await boot({
      messages: [
        { id: "a", direction: "OUTBOUND", body: "one", messageType: "text", author: "Store Assistant", authorKind: "ai", createdAt: now, commerce: null },
        { id: "b", direction: "OUTBOUND", body: "two", messageType: "text", author: "Store Assistant", authorKind: "ai", createdAt: now, commerce: null },
        { id: "c", direction: "OUTBOUND", body: "three", messageType: "text", author: "dana", authorKind: "agent", createdAt: now, commerce: null },
      ],
    });
    const names = Array.from(shadow.querySelectorAll(".who")).map((n) => n.textContent);
    expect(names).toEqual(["Store Assistant", "dana"]);
  });

  it("renders the merchant's headline and suggested questions", async () => {
    const { shadow } = await boot();
    const text = shadow.textContent ?? "";
    expect(text).toContain("Hi there");
    expect(text).toContain("Which product is right for me?");
    expect(text).toContain("Store Assistant");
  });

  it("marks the panel as a dialog with the assistant's name", async () => {
    const { shadow } = await boot();
    const panel = shadow.querySelector(".panel")!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-label")).toBe("Store Assistant");
    expect(panel.getAttribute("dir")).toBe("ltr");
  });

  it("switches to RTL for Hebrew", async () => {
    const { shadow } = await boot();
    // Re-boot with Hebrew: direction follows language when set to auto.
    document.body.innerHTML = "";
    const host = document.createElement("div");
    document.body.appendChild(host);
    const rtlShadow = host.attachShadow({ mode: "open" });
    const factory = (window as any).__gotchaShopifyChatApp;
    factory({
      api: "x", assets: "y", context: {}, availability: "online",
      store: { get: () => null, set: () => {}, del: () => {} },
      post: vi.fn(async () => ({ data: {} })),
      shadow: rtlShadow,
      widget: {
        appearance: { primaryColor: "#000000", contrastColor: "#ffffff", launcherPosition: "right", cornerRadius: 16, language: "he", direction: "auto", showPoweredBy: false },
        welcome: { headline: "שלום", subline: "", assistantName: "עוזר", suggestedQuestions: [] },
        offline: { active: false, message: "", behavior: "ai", formFields: [] },
        features: { humanHandoff: true, productMessaging: true, addToCart: true },
      },
    });
    expect(rtlShadow.querySelector(".panel")!.getAttribute("dir")).toBe("rtl");
    expect(rtlShadow.textContent).toContain("שלום");
    expect(shadow).toBeTruthy();
  });

  it("hides the human-handoff link when the merchant disabled it", async () => {
    const { shadow } = await boot({ features: { humanHandoff: false } });
    const link = shadow.querySelector(".lnk") as HTMLElement;
    expect(link.hidden).toBe(true);
  });
});

// ─── Escaping ───────────────────────────────────────────────

describe("untrusted content never becomes markup", () => {
  it("renders a hostile message body as text", async () => {
    // (case 52) The widget builds DOM from element factories; there is no
    // innerHTML interpolation anywhere for it to escape into.
    const { shadow } = await boot({
      messages: [
        { id: "m1", direction: "INBOUND", body: "<img src=x onerror=alert(1)>", messageType: "text", author: null, authorKind: "visitor", createdAt: new Date().toISOString(), commerce: null },
      ],
    });
    const bubble = shadow.querySelector(".bub")!;
    expect(bubble.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(shadow.querySelector("img[onerror]")).toBeNull();
  });

  it("renders a hostile product title as text", async () => {
    const { shadow } = await boot({
      messages: [
        {
          id: "m2",
          direction: "OUTBOUND",
          body: "here",
          messageType: "shopify_product",
          author: "Store Assistant",
          authorKind: "ai",
          createdAt: new Date().toISOString(),
          commerce: { addToCartEnabled: true, products: [makeProduct({ title: "<script>alert(1)</script>Shoe" })] },
        },
      ],
    });
    expect(shadow.querySelector("script")).toBeNull();
    expect(shadow.textContent).toContain("<script>alert(1)</script>Shoe");
  });

  it("refuses a javascript: product url", async () => {
    // (case 53)
    const { shadow } = await boot({
      messages: [
        {
          id: "m3",
          direction: "OUTBOUND",
          body: "here",
          messageType: "shopify_product",
          author: "AI",
          authorKind: "ai",
          createdAt: new Date().toISOString(),
          // eslint-disable-next-line no-script-url
          commerce: { addToCartEnabled: true, products: [makeProduct({ productUrl: "javascript:alert(1)" })] },
        },
      ],
    });
    const link = shadow.querySelector("a.btn-s") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBeNull();
  });
});

// ─── Product card behaviour ─────────────────────────────────

describe("product card", () => {
  async function cardHarness(product = makeProduct()) {
    return await boot({
      messages: [
        {
          id: "p1",
          direction: "OUTBOUND",
          body: "This one",
          messageType: "shopify_product",
          author: "Store Assistant",
          authorKind: "ai",
          createdAt: new Date().toISOString(),
          commerce: { addToCartEnabled: true, products: [product] },
        },
      ],
    });
  }

  it("does not pick a variant for a product that has real options", async () => {
    // (case 25) Add to Cart stays disabled until the shopper chooses.
    const { shadow } = await cardHarness();
    const add = Array.from(shadow.querySelectorAll("button")).find((b) => b.textContent === "Add to cart") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
  });

  it("enables Add to Cart once an available option is chosen", async () => {
    const { shadow } = await cardHarness();
    const chip = Array.from(shadow.querySelectorAll(".chip")).find((c) => c.textContent === "41") as HTMLButtonElement;
    chip.click();
    const add = Array.from(shadow.querySelectorAll("button")).find((b) => b.textContent === "Add to cart") as HTMLButtonElement;
    expect(add.disabled).toBe(false);
  });

  it("disables a sold-out option instead of hiding it", async () => {
    // (case 26)
    const { shadow } = await cardHarness();
    const chip = Array.from(shadow.querySelectorAll(".chip")).find((c) => c.textContent === "42") as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
  });

  it("auto-selects the only variant of a single-variant product", async () => {
    const single = makeProduct({
      optionNames: [],
      variants: [{ variantId: "9001", title: "Default", price: "120.00", compareAtPrice: null, available: true, options: [], requiresSellingPlan: false }],
    });
    const { shadow } = await cardHarness(single);
    const add = Array.from(shadow.querySelectorAll("button")).find((b) => b.textContent === "Add to cart") as HTMLButtonElement;
    expect(add.disabled).toBe(false);
  });

  it("keeps Add to Cart out entirely when the plan or channel disallows it", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const factory = (window as any).__gotchaShopifyChatApp;
    factory({
      api: "x", assets: "y", context: {}, availability: "online",
      store: { get: () => null, set: () => {}, del: () => {} },
      post: vi.fn(async () => ({ data: {} })),
      shadow,
      widget: {
        appearance: { primaryColor: "#000000", contrastColor: "#ffffff", launcherPosition: "right", cornerRadius: 16, language: "en", direction: "ltr", showPoweredBy: false },
        welcome: { headline: "Hi", subline: "", assistantName: "A", suggestedQuestions: [] },
        offline: { active: false, message: "", behavior: "ai", formFields: [] },
        features: { humanHandoff: true, productMessaging: false, addToCart: false },
      },
    });
    expect(Array.from(shadow.querySelectorAll("button")).some((b) => b.textContent === "Add to cart")).toBe(false);
  });

  it("lazy-loads product images", async () => {
    const { shadow } = await cardHarness();
    const img = shadow.querySelector(".card-im") as HTMLImageElement;
    expect(img.getAttribute("loading")).toBe("lazy");
  });

  it("shows the sale badge and struck-through original price", async () => {
    const { shadow } = await cardHarness();
    expect(shadow.querySelector(".pr-was")).toBeTruthy();
    expect(shadow.querySelector(".tag-sale")!.textContent).toBe("-20%");
  });
});

// ─── Add to Cart ────────────────────────────────────────────

describe("add to cart", () => {
  it("posts the SERVER's variant id to the theme's own cart endpoint", async () => {
    // (cases 28, 31, 37) No Admin token is involved, and the browser's
    // idea of the variant is not what gets added.
    const { shadow, post, fetchMock } = await boot({
      messages: [
        {
          id: "p1",
          direction: "OUTBOUND",
          body: "This one",
          messageType: "shopify_product",
          author: "AI",
          authorKind: "ai",
          createdAt: new Date().toISOString(),
          commerce: { addToCartEnabled: true, products: [makeProduct({ selectedVariantId: "9001" })] },
        },
      ],
    });

    const add = Array.from(shadow.querySelectorAll("button")).find((b) => b.textContent === "Add to cart") as HTMLButtonElement;
    add.click();
    await new Promise((r) => setTimeout(r, 20));

    const validate = post.mock.calls.find((c) => String(c[0]).includes("/cart/validate"));
    expect(validate).toBeTruthy();

    const cartCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes("/cart/add.js")) as any[];
    expect(cartCall).toBeTruthy();
    expect(cartCall![1].credentials).toBe("same-origin");
    expect(JSON.parse(cartCall![1].body)).toEqual({ items: [{ id: 9001, quantity: 1 }] });
  });

  it("shows a safe message when the server refuses", async () => {
    // (case 35)
    const { shadow, post } = await boot({
      messages: [
        {
          id: "p1",
          direction: "OUTBOUND",
          body: "This one",
          messageType: "shopify_product",
          author: "AI",
          authorKind: "ai",
          createdAt: new Date().toISOString(),
          commerce: { addToCartEnabled: true, products: [makeProduct({ selectedVariantId: "9001" })] },
        },
      ],
    });
    post.mockImplementation(async (p: string) => {
      if (p.endsWith("/cart/validate")) {
        const err: any = new Error("variant_unavailable");
        err.status = 409;
        err.body = { error: "variant_unavailable", message: "That option is out of stock." };
        throw err;
      }
      return { data: {} };
    });

    const add = Array.from(shadow.querySelectorAll("button")).find((b) => b.textContent === "Add to cart") as HTMLButtonElement;
    add.click();
    await new Promise((r) => setTimeout(r, 20));

    expect(shadow.querySelector(".cart-err")!.textContent).toBe("That option is out of stock.");
  });

  it("never calls a Shopify Admin endpoint from the browser", async () => {
    const { shadow, fetchMock } = await boot({
      messages: [
        {
          id: "p1",
          direction: "OUTBOUND",
          body: "x",
          messageType: "shopify_product",
          author: "AI",
          authorKind: "ai",
          createdAt: new Date().toISOString(),
          commerce: { addToCartEnabled: true, products: [makeProduct({ selectedVariantId: "9001" })] },
        },
      ],
    });
    const add = Array.from(shadow.querySelectorAll("button")).find((b) => b.textContent === "Add to cart") as HTMLButtonElement;
    add.click();
    await new Promise((r) => setTimeout(r, 20));

    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toMatch(/\/admin\/api\//);
      expect(JSON.stringify(call[1] ?? {})).not.toMatch(/X-Shopify-Access-Token|shpat_/);
    }
  });
});

// ─── Carousel + keyboard ────────────────────────────────────

describe("carousel", () => {
  async function carouselHarness() {
    return await boot({
      messages: [
        {
          id: "c1",
          direction: "OUTBOUND",
          body: "three options",
          messageType: "shopify_product_carousel",
          author: "AI",
          authorKind: "ai",
          createdAt: new Date().toISOString(),
          commerce: {
            addToCartEnabled: true,
            products: [
              // Multi-variant: the shopper still has a size to choose.
              makeProduct(),
              // Single variant, resolved: nothing left to decide.
              makeProduct({
                productId: "222",
                title: "Trail Light",
                optionNames: [],
                selectedVariantId: "9101",
                variants: [{ variantId: "9101", title: "Default", price: "98.00", compareAtPrice: null, available: true, options: [], requiresSellingPlan: false }],
              }),
              makeProduct({ productId: "333", title: "Road Max" }),
            ],
          },
        },
      ],
    });
  }

  it("renders each product and scrolls inside its own strip", async () => {
    // (cases 23, 62)
    const { shadow } = await carouselHarness();
    expect(shadow.querySelectorAll(".car-tr .card")).toHaveLength(3);
    expect(shadow.querySelector(".car-tr")).toBeTruthy();
  });

  it("is reachable and scrollable from the keyboard", async () => {
    // (case 60)
    const { shadow } = await carouselHarness();
    const strip = shadow.querySelector(".car-tr") as HTMLElement;
    expect(strip.getAttribute("tabindex")).toBe("0");
    strip.scrollLeft = 0;
    strip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(strip.scrollLeft).toBeGreaterThan(0);
  });

  it("does not put a variant picker on a shortlist entry", async () => {
    // A carousel is a choice BETWEEN products. Configuring one belongs
    // on the single card the shopper lands on after choosing, and at
    // 186px the picker plus quantity plus two buttons buries the
    // actions below the fold.
    const { shadow } = await carouselHarness();
    expect(shadow.querySelectorAll(".car-tr .chip")).toHaveLength(0);
    expect(shadow.querySelectorAll(".car-tr .qty")).toHaveLength(0);
  });

  it("offers Add to Cart only where there is nothing left to choose", async () => {
    const { shadow } = await carouselHarness();
    const cards = Array.from(shadow.querySelectorAll(".car-tr .card"));
    const labels = cards.map((c) =>
      Array.from(c.querySelectorAll(".btn")).map((b) => b.textContent),
    );
    // Card 1 has real sizes to pick, so it links out rather than
    // pretending it can add something.
    expect(labels[0]).toEqual(["View product"]);
    // Cards 2 and 3 are single-variant: Add to Cart is honest there.
    expect(labels[1]).toContain("Add to cart");
  });

  it("gives its navigation buttons accessible names", async () => {
    const { shadow } = await carouselHarness();
    const navs = Array.from(shadow.querySelectorAll(".car-n"));
    expect(navs).toHaveLength(2);
    navs.forEach((n) => expect(n.getAttribute("aria-label")).toBeTruthy());
  });
});

// ─── Dismissal ──────────────────────────────────────────────

describe("dismissal", () => {
  it("closes on Escape rather than trapping the shopper in the widget", async () => {
    // (case 60) Escape and the close button both return them to the shop.
    const { shadow, app } = await boot();
    app.open();
    const panel = shadow.querySelector(".panel") as HTMLElement;
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.hidden).toBe(true);
  });

  it("is not aria-modal, so the storefront behind it stays reachable", async () => {
    const { shadow } = await boot();
    expect((shadow.querySelector(".panel") as HTMLElement).getAttribute("aria-modal")).toBe("false");
  });
});

// ─── Motion, contrast, mobile ───────────────────────────────

describe("presentation preferences", () => {
  it("honours reduced motion, high contrast and forced colors", async () => {
    // (case 61)
    const { shadow } = await boot();
    const css = Array.from(shadow.querySelectorAll("style")).map((s) => s.textContent).join("\n");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("prefers-contrast: more");
    expect(css).toContain("forced-colors: active");
  });

  it("goes full height on a phone and keeps the composer above the safe area", async () => {
    // (cases 58, 63)
    const { shadow } = await boot();
    const css = Array.from(shadow.querySelectorAll("style")).map((s) => s.textContent).join("\n");
    expect(css).toContain("max-width: 560px");
    expect(css).toContain("100dvh");
    expect(css).toContain("env(safe-area-inset-bottom)");
  });

  it("uses a 16px input on phones so iOS does not zoom the storefront", async () => {
    const { shadow } = await boot();
    const css = Array.from(shadow.querySelectorAll("style")).map((s) => s.textContent).join("\n");
    expect(css).toMatch(/\.ta\{[^}]*font-size:16px/);
  });
});

// ─── Opening and closing ─────────────────────────────────────
//
// The close button looked dead on a real storefront: the handler ran,
// state flipped, analytics fired, and the panel stayed on screen. The
// cause was CSS, not JavaScript - `el.hidden` is inert against an author
// rule that sets `display`, and a shadow root has no UA stylesheet of its
// own to lean on.
//
// jsdom does not implement the shadow-DOM cascade, so it CANNOT reproduce
// that: `getComputedStyle` here would have been green throughout the
// outage. The contract test below asserts the stylesheet carries the rule,
// which is the part jsdom can actually see; the visible behaviour is
// proved in a real browser instead.

describe("close and reopen", () => {
  it("ships a [hidden] rule, because .panel sets its own display", () => {
    expect(WIDGET_SOURCE).toMatch(/\[hidden\]\{display:none!important;?\}/);
    // The rule only matters because of this one:
    expect(WIDGET_SOURCE).toContain("display:flex;flex-direction:column;overflow:hidden;");
  });

  it("hides the panel and tells the bootstrap to restore the launcher", async () => {
    const h = await boot();
    const panel = h.shadow.querySelector(".panel") as HTMLElement;
    expect(panel.hidden).toBe(false);

    const close = h.shadow.querySelector('button[data-act="close"]') as HTMLButtonElement;
    close.click();

    expect(panel.hidden).toBe(true);
    // The launcher lives in the bootstrap, not here; closing must hand
    // control back or the shopper is left with no way in.
    expect((h as any).app).toBeTruthy();
  });

  it("carries an accessible label and is reachable by keyboard", async () => {
    const h = await boot();
    const close = h.shadow.querySelector('button[data-act="close"]') as HTMLButtonElement;
    expect(close.getAttribute("aria-label")).toBe("Close chat");
    expect(close.tagName).toBe("BUTTON");
    expect(close.disabled).toBe(false);
  });

  it("Escape closes the panel", async () => {
    const h = await boot();
    const panel = h.shadow.querySelector(".panel") as HTMLElement;
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.hidden).toBe(true);
  });

  it("keeps the visitor session and the conversation across close/reopen", async () => {
    const h = await boot({ messages: [{ id: "m1", direction: "OUTBOUND", body: "Hello", createdAt: new Date().toISOString() }] });
    const before = { session: h.storeData.session, conversation: h.storeData.conversation };

    h.app.close();
    h.app.open();
    await new Promise((r) => setTimeout(r, 20));

    // Closing is a view change, not the end of a conversation.
    expect(h.storeData.session).toBe(before.session);
    expect(h.storeData.conversation).toBe(before.conversation);
    const panel = h.shadow.querySelector(".panel") as HTMLElement;
    expect(panel.hidden).toBe(false);
  });

  it("does not mint a new visitor session when reopened", async () => {
    const h = await boot();
    const calls = () => h.post.mock.calls.filter((c: any[]) => String(c[0]).endsWith("/bootstrap")).length;
    const before = calls();
    h.app.close();
    h.app.open();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls()).toBe(before);
  });

  it("survives repeated open/close without stacking listeners", async () => {
    const h = await boot();
    const panel = h.shadow.querySelector(".panel") as HTMLElement;
    for (let i = 0; i < 5; i++) {
      h.app.close();
      h.app.open();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(panel.hidden).toBe(false);
    // One panel, not six: reopening must not remount the widget.
    expect(h.shadow.querySelectorAll(".panel").length).toBe(1);
  });
});

// ─── Welcome hero ────────────────────────────────────────────
//
// The hero is the first thing a shopper sees, and it is built entirely
// from URLs a merchant pasted into a form. Every case below is really the
// same question: what happens when that URL is wrong?

function hero(overrides: Record<string, any> = {}) {
  return {
    hero: {
      mediaType: "image",
      mediaUrl: "https://cdn.example.com/hero.jpg",
      posterUrl: null,
      height: 180,
      mobileHeight: 148,
      focalPoint: "50% 40%",
      objectFit: "cover",
      overlayStrength: 0,
      fadeStrength: 60,
      cornerRadius: 0,
      avatarUrl: "https://cdn.example.com/avatar.png",
      avatarSize: 64,
      avatarOverlap: 28,
      backgroundColor: "#ffffff",
      textColor: "#0f172a",
      accentColor: "#111827",
      videoLoop: true,
      videoAutoplay: true,
      ...overrides,
    },
  };
}

describe("welcome hero", () => {
  it("renders an image hero above the welcome copy", async () => {
    const h = await boot({ messages: [], ux: hero() });
    const img = h.shadow.querySelector(".hero .hero-m") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toBe("https://cdn.example.com/hero.jpg");
    expect(img.style.objectPosition).toBe("50% 40%");
    // Decorative: it must not be announced to a screen reader.
    expect(img.getAttribute("alt")).toBe("");
  });

  it("renders a GIF the same way an image is rendered", async () => {
    const h = await boot({
      messages: [],
      ux: hero({ mediaType: "gif", mediaUrl: "https://cdn.example.com/loop.gif" }),
    });
    const img = h.shadow.querySelector(".hero .hero-m") as HTMLImageElement;
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toContain(".gif");
  });

  it("renders video muted and inline, which is the only autoplayable form", async () => {
    const h = await boot({
      messages: [],
      ux: hero({ mediaType: "video", mediaUrl: "https://cdn.example.com/clip.mp4", posterUrl: "https://cdn.example.com/p.jpg" }),
    });
    const v = h.shadow.querySelector(".hero .hero-m") as HTMLVideoElement;
    expect(v.tagName).toBe("VIDEO");
    expect(v.muted).toBe(true);
    expect(v.hasAttribute("playsinline")).toBe(true);
    expect(v.getAttribute("poster")).toContain("p.jpg");
    expect(v.loop).toBe(true);
    // Nothing is fetched until the widget is actually open.
    expect(v.preload).toBe("none");
  });

  it("fades the media into the chat surface", async () => {
    const h = await boot({ messages: [], ux: hero() });
    const fade = h.shadow.querySelector(".hero .hero-fd") as HTMLElement;
    expect(fade).toBeTruthy();
    // Transparent at the top, the panel's own colour at the bottom.
    expect(fade.style.background).toContain("linear-gradient");
    expect(fade.style.background).toContain("rgba(255,255,255,0)");
  });

  it("overlaps the avatar onto the bottom edge of the media", async () => {
    // The avatar belongs to the WELCOME block, not the hero: it survives
    // when the merchant removes the media, so it cannot be a hero field.
    const h = await boot({
      messages: [],
      ux: { ...hero(), welcome: { avatarUrl: "https://cdn.example.com/a.png", avatarOverlap: 28, avatarSize: 64 } },
    });
    const av = h.shadow.querySelector(".wel-av") as HTMLImageElement;
    expect(av).toBeTruthy();
    expect(av.style.marginTop).toBe("-28px");
    expect(av.style.width).toBe("64px");
  });

  it("shows no hero at all when there is no media", async () => {
    const h = await boot({ messages: [], ux: { hero: { mediaType: "none", mediaUrl: null } } });
    expect(h.shadow.querySelector(".hero")).toBeNull();
    // ...and the welcome copy is still there.
    expect(h.shadow.querySelector(".wel-h")).toBeTruthy();
  });

  it("survives a config with no ux block at all", async () => {
    // An existing channel, configured long before any of this shipped.
    const h = await boot({ messages: [] });
    expect(h.shadow.querySelector(".hero")).toBeNull();
    expect(h.shadow.querySelector(".wel")).toBeTruthy();
  });

  it("collapses the frame if the media fails to load", async () => {
    const h = await boot({ messages: [], ux: hero() });
    const img = h.shadow.querySelector(".hero .hero-m") as HTMLImageElement;
    img.dispatchEvent(new Event("error"));
    // A broken-image glyph at the top of the chat is worse than no hero.
    expect(h.shadow.querySelector(".hero")).toBeNull();
  });
});

describe("welcome to conversation", () => {
  it("drops the hero once the shopper sends the first message", async () => {
    const h = await boot({ messages: [], ux: hero() });
    expect(h.shadow.querySelector(".hero")).toBeTruthy();

    const suggestion = h.shadow.querySelector(".sug-b") as HTMLButtonElement;
    suggestion.click();
    await new Promise((r) => setTimeout(r, 30));

    // Compact chat: the message list owns the space now.
    expect(h.shadow.querySelector(".hero")).toBeNull();
    expect(h.shadow.querySelector(".msgs")).toBeTruthy();
  });

  it("opens an existing conversation straight into compact chat", async () => {
    // Case 28: a returning shopper must never be shown marketing media
    // above their own messages.
    const h = await boot({
      messages: [{ id: "m1", direction: "OUTBOUND", body: "Hello again", createdAt: new Date().toISOString() }],
      ux: hero(),
    });
    expect(h.shadow.querySelector(".hero")).toBeNull();
    expect(h.shadow.querySelector(".msgs")).toBeTruthy();
  });

  it("does not remount the widget when transitioning", async () => {
    const h = await boot({ messages: [], ux: hero() });
    const panelBefore = h.shadow.querySelector(".panel");
    (h.shadow.querySelector(".sug-b") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 30));
    // Same panel element: the view changed, the widget did not restart.
    expect(h.shadow.querySelector(".panel")).toBe(panelBefore);
  });
});

// ─── Deterministic close ─────────────────────────────────────
//
// The first fix relied on `[hidden]`, which is the weakest rule in the
// cascade and lost to `.panel{display:flex}`. The state attribute now
// owns visibility outright, so these assert the mechanism rather than
// the symptom.

describe("close is deterministic", () => {
  it("marks the panel closed in the attribute that owns display", async () => {
    const h = await boot();
    const panel = h.shadow.querySelector(".panel") as HTMLElement;
    expect(panel.getAttribute("data-state")).toBe("open");

    (h.shadow.querySelector('button[data-act="close"]') as HTMLButtonElement).click();

    expect(panel.getAttribute("data-state")).toBe("closed");
    // Both signals, so neither a missing UA sheet nor a future author
    // rule can leave a closed panel on screen.
    expect(panel.hidden).toBe(true);
  });

  it("ships a rule that hides a closed panel without relying on [hidden]", () => {
    expect(WIDGET_SOURCE).toMatch(/\.panel\[data-state='closed'\]\{display:none!important;?\}/);
  });

  it("is born closed rather than defaulting to visible", () => {
    expect(WIDGET_SOURCE).toContain('panel.setAttribute("data-state", "closed")');
  });

  it("reopens cleanly through the same mutator", async () => {
    const h = await boot();
    const panel = h.shadow.querySelector(".panel") as HTMLElement;
    h.app.close();
    expect(panel.getAttribute("data-state")).toBe("closed");
    h.app.open();
    await new Promise((r) => setTimeout(r, 20));
    expect(panel.getAttribute("data-state")).toBe("open");
    expect(panel.hidden).toBe(false);
  });

  it("stays closed across five cycles and keeps one panel", async () => {
    const h = await boot();
    for (let i = 0; i < 5; i++) {
      h.app.close();
      expect((h.shadow.querySelector(".panel") as HTMLElement).getAttribute("data-state")).toBe("closed");
      h.app.open();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(h.shadow.querySelectorAll(".panel").length).toBe(1);
  });
});

describe("an explicit close is respected", () => {
  it("records that the shopper closed it", async () => {
    const h = await boot();
    expect(h.app.closedByVisitor()).toBe(false);
    (h.shadow.querySelector('button[data-act="close"]') as HTMLButtonElement).click();
    // The flag outlives the render, so nothing automatic may reopen.
    expect(h.app.closedByVisitor()).toBe(true);
  });

  it("does not set the flag when the widget closes itself", async () => {
    const h = await boot();
    h.app.close("internal");
    expect(h.app.closedByVisitor()).toBe(false);
  });

  it("exposes safe state for debugging and nothing else", async () => {
    const h = await boot();
    (h.shadow.querySelector('button[data-act="close"]') as HTMLButtonElement).click();
    const d = h.app.debugState();

    expect(d.state).toBe("CLOSED");
    expect(d.panelHidden).toBe(true);
    expect(d.panelDataState).toBe("closed");
    expect(d.closeClicks).toBe(1);
    expect(d.closedByVisitor).toBe(true);

    // Case 25: the debug surface must never become a leak.
    const body = JSON.stringify(d);
    for (const leak of ["t1", "session", "token", "tenant", "secret", "conversationId"]) {
      expect(body.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });
});

describe("close button ergonomics", () => {
  it("meets the 44x44 touch floor", () => {
    // Measured at 34x34 on a real storefront. It is the shopper's way
    // out of the widget; it should not be the fiddliest control in it.
    expect(WIDGET_SOURCE).toMatch(/\.x,\.mute\{width:44px;height:44px;min-width:44px;min-height:44px/);
  });

  it("is taken out of the panel's flow so it cannot push the hero down", () => {
    // It is a child of the panel (so it survives the header being hidden
    // in the welcome view). As a flex item of that column it would occupy
    // a 44px row - which is exactly the white gap that appeared above the
    // hero when a second `.x` rule reset it to position:relative.
    expect(WIDGET_SOURCE).toContain('".x{position:absolute;top:var(--s2);"');
    // ...and no other `.x` rule may quietly put it back into flow.
    const xRules = WIDGET_SOURCE.match(/\.x\{[^}"]*/g) ?? [];
    expect(xRules.some((r) => r.includes("position:relative"))).toBe(false);
  });

  it("has a visible focus style and a non-capturing icon", () => {
    // The ring goes on the visible chip, not on the 44px target - an
    // outline around the invisible hit area looks like a stray rectangle.
    expect(WIDGET_SOURCE).toContain('".x:focus-visible::before,.mute:focus-visible::before{outline:2px solid "');
    // The svg must not swallow the click and defeat the hit area.
    expect(WIDGET_SOURCE).toContain("stroke-width:2.1;stroke-linecap:round;pointer-events:none;}");
  });
});
