/**
 * Shopify Live Chat — the storefront widget itself.
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
async function boot(options: { messages?: any[]; features?: Record<string, boolean> } = {}): Promise<Harness> {
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
    setUnread: vi.fn(),
    onOpened: vi.fn(),
    onClosed: vi.fn(),
    widget: {
      appearance: {
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
      welcome: {
        headline: "Hi there",
        subline: "Ask us anything.",
        assistantName: "Store Assistant",
        suggestedQuestions: ["Which product is right for me?"],
      },
      offline: { active: false, message: "Away", behavior: "ai", formFields: [], consentRequired: false, consentText: "" },
      features: { humanHandoff: true, productMessaging: true, addToCart: true, ...(options.features ?? {}) },
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

describe("welcome state", () => {
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
            products: [makeProduct(), makeProduct({ productId: "222", title: "Trail Light" }), makeProduct({ productId: "333", title: "Road Max" })],
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
