/**
 * RTL in the storefront widget, driven against the REAL bundle in jsdom.
 *
 * The rule under test throughout: direction belongs to a MESSAGE, not to
 * the widget. A Hebrew shopper's conversation routinely contains English
 * product names, URLs, prices and part codes, and an agent may join and
 * type English into it. One direction for the whole panel is wrong for at
 * least one of those, every time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

const WIDGET_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../../../../public/widget/gotcha-shopify-chat.js"),
  "utf8",
);

const SHOP = "demo-store.myshopify.com";

function msg(overrides: Record<string, any> = {}) {
  return {
    id: `m${Math.random().toString(36).slice(2, 8)}`,
    direction: "INBOUND",
    body: "hello",
    messageType: "text",
    author: null,
    authorKind: "visitor",
    createdAt: new Date().toISOString(),
    commerce: null,
    ...overrides,
  };
}

function product(overrides: Record<string, any> = {}) {
  return {
    productId: "111",
    handle: "cloud-pro",
    title: "Cloud Pro Runner",
    imageUrl: "https://cdn.shopify.com/s/files/1/x.jpg",
    productUrl: `https://${SHOP}/products/cloud-pro`,
    currency: "ILS",
    price: "120.00",
    compareAtPrice: "150.00",
    available: true,
    published: true,
    selectedVariantId: "9001",
    optionNames: [],
    variants: [
      {
        variantId: "9001",
        title: "Default",
        price: "120.00",
        compareAtPrice: "150.00",
        available: true,
        options: [],
        requiresSellingPlan: false,
      },
    ],
    reason: "מתאים למה שחיפשת.",
    ...overrides,
  };
}

interface Harness {
  app: any;
  shadow: ShadowRoot;
  post: ReturnType<typeof vi.fn>;
}

async function boot(
  options: {
    messages?: any[];
    appearance?: Record<string, any>;
    /** Storefront locale the theme reports. */
    storefrontLocale?: string;
    welcome?: Record<string, any>;
  } = {},
): Promise<Harness> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const storeData: Record<string, string> = {
    session: "opaque-session-token",
    conversation: "conv1",
  };

  const post = vi.fn(async (p: string) => {
    if (p.endsWith("/conversation")) {
      return {
        data: {
          conversationId: "conv1",
          status: "OPEN",
          isHandedOver: false,
          messages: options.messages ?? [],
        },
      };
    }
    return { data: {} };
  });

  (globalThis as any).fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as any;

  const state = {
    api: "https://api.gotcha.co.il",
    assets: "https://app.gotcha.co.il",
    context: {
      pageType: "product",
      productHandle: "cloud-pro",
      locale: options.storefrontLocale ?? "he",
    },
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
        language: "he",
        direction: "auto",
        showPoweredBy: true,
        ...(options.appearance ?? {}),
      },
      welcome: {
        headline: "שלום",
        subline: "אפשר לשאול אותנו כל דבר.",
        assistantName: "עוזר החנות",
        suggestedQuestions: ["איזה מוצר מתאים לי?"],
        ...(options.welcome ?? {}),
      },
      offline: { active: false, message: "", behavior: "ai", formFields: [], consentRequired: false, consentText: "" },
      features: { humanHandoff: true, productMessaging: true, addToCart: true },
      ux: undefined,
    },
  };

  const app = (window as any).__gotchaShopifyChatApp(state);
  app.open();
  await new Promise((r) => setTimeout(r, 20));
  return { app, shadow, post };
}

function bubbles(shadow: ShadowRoot): HTMLElement[] {
  return Array.from(shadow.querySelectorAll(".bub")) as HTMLElement[];
}

function css(shadow: ShadowRoot): string {
  return (shadow.querySelector("style") as HTMLStyleElement).textContent ?? "";
}

beforeEach(() => {
  document.body.innerHTML = "";
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

// ─── Per-message direction ───────────────────────────────────

describe("per-message direction", () => {
  it("a Hebrew-only message is rtl", async () => {
    const h = await boot({ messages: [msg({ body: "שלום, אני מחפש נעליים" })] });
    expect(bubbles(h.shadow)[0].getAttribute("dir")).toBe("rtl");
  });

  it("an English-only message is ltr", async () => {
    const h = await boot({ messages: [msg({ body: "Hi, I am looking for running shoes" })] });
    expect(bubbles(h.shadow)[0].getAttribute("dir")).toBe("ltr");
  });

  it("an Arabic message is rtl", async () => {
    const h = await boot({ messages: [msg({ body: "مرحبا، أبحث عن حذاء رياضي" })] });
    expect(bubbles(h.shadow)[0].getAttribute("dir")).toBe("rtl");
  });

  it("a Persian message is rtl", async () => {
    const h = await boot({ messages: [msg({ body: "سلام، دنبال یک کفش ورزشی هستم" })] });
    expect(bubbles(h.shadow)[0].getAttribute("dir")).toBe("rtl");
  });

  it("an Urdu message is rtl", async () => {
    const h = await boot({ messages: [msg({ body: "سلام، میں ایک جوتا تلاش کر رہا ہوں" })] });
    expect(bubbles(h.shadow)[0].getAttribute("dir")).toBe("rtl");
  });

  it("customer and AI messages in the same thread can disagree", async () => {
    // THE case the whole feature exists for: a Hebrew shopper, an English
    // agent, one conversation.
    const h = await boot({
      messages: [
        msg({ body: "שלום, יש לכם את זה במידה 42?" }),
        msg({
          direction: "OUTBOUND",
          authorKind: "agent",
          author: "Dana",
          body: "Hi, let me check that size for you.",
        }),
        msg({ direction: "OUTBOUND", authorKind: "ai", author: "עוזר החנות", body: "בדקתי, יש במלאי." }),
      ],
    });
    expect(bubbles(h.shadow).map((b) => b.getAttribute("dir"))).toEqual(["rtl", "ltr", "rtl"]);
  });

  it("a message with no strong characters falls back to the conversation language", async () => {
    const h = await boot({ messages: [msg({ body: "👍" })] });
    expect(bubbles(h.shadow)[0].getAttribute("dir")).toBe("rtl");
  });

  it("explicit message locale metadata outranks the script in the body", async () => {
    const h = await boot({ messages: [msg({ body: "Cloud Pro Runner", locale: "he" })] });
    expect(bubbles(h.shadow)[0].getAttribute("dir")).toBe("rtl");
  });

  it("a merchant direction override wins over everything", async () => {
    const h = await boot({
      appearance: { direction: "ltr" },
      messages: [msg({ body: "שלום, אני מחפש נעליים" })],
    });
    expect(bubbles(h.shadow)[0].getAttribute("dir")).toBe("ltr");
  });
});

// ─── Mixed content ───────────────────────────────────────────

describe("mixed Hebrew and Latin content", () => {
  it("Hebrew naming an English product stays rtl", async () => {
    const h = await boot({ messages: [msg({ body: "אני מחפש משהו כמו Nike Air Max 90" })] });
    expect(bubbles(h.shadow)[0].getAttribute("dir")).toBe("rtl");
  });

  it("a URL inside Hebrew is isolated so its punctuation cannot migrate", async () => {
    const h = await boot({
      messages: [msg({ body: `הנה הקישור https://${SHOP}/products/cloud-pro ותודה` })],
    });
    const bubble = bubbles(h.shadow)[0];
    expect(bubble.getAttribute("dir")).toBe("rtl");
    const isolates = Array.from(bubble.querySelectorAll("bdi"));
    expect(isolates).toHaveLength(1);
    expect(isolates[0].textContent).toBe(`https://${SHOP}/products/cloud-pro`);
    expect(isolates[0].getAttribute("dir")).toBe("ltr");
    // The visible text is unchanged - isolation is presentation, never
    // an edit to what the shopper or the assistant actually wrote.
    expect(bubble.textContent).toBe(`הנה הקישור https://${SHOP}/products/cloud-pro ותודה`);
  });

  it("prices and part codes inside Hebrew are isolated", async () => {
    const h = await boot({
      messages: [msg({ body: "המחיר $120.00 והמק״ט AIR-MAX-90" })],
    });
    const bubble = bubbles(h.shadow)[0];
    expect(bubble.getAttribute("dir")).toBe("rtl");
    expect(Array.from(bubble.querySelectorAll("bdi")).map((b) => b.textContent)).toEqual([
      "$120.00",
      "AIR-MAX-90",
    ]);
  });

  it("an email address inside Hebrew is isolated", async () => {
    const h = await boot({ messages: [msg({ body: "אפשר לכתוב ל dana@example.com" })] });
    const bdi = bubbles(h.shadow)[0].querySelector("bdi");
    expect(bdi?.textContent).toBe("dana@example.com");
  });

  it("a bare number in Hebrew is NOT isolated - the bidi algorithm handles it", async () => {
    const h = await boot({ messages: [msg({ body: "יש לי 3 מוצרים בסל" })] });
    expect(bubbles(h.shadow)[0].querySelectorAll("bdi")).toHaveLength(0);
  });

  it("plain Hebrew prose round-trips with no extra markup", async () => {
    const h = await boot({ messages: [msg({ body: "שלום, איך אפשר לעזור?" })] });
    const bubble = bubbles(h.shadow)[0];
    expect(bubble.querySelectorAll("bdi")).toHaveLength(0);
    expect(bubble.textContent).toBe("שלום, איך אפשר לעזור?");
  });

  it("a multiline Hebrew list keeps its line breaks", async () => {
    const body = "מצאתי שלוש אפשרויות:\n1. נעל ריצה\n2. נעל הליכה\n3. סנדל";
    const h = await boot({ messages: [msg({ direction: "OUTBOUND", authorKind: "ai", author: "עוזר החנות", body })] });
    expect(bubbles(h.shadow)[0].textContent).toBe(body);
    // pre-wrap is what makes a numbered list readable rather than one run-on line.
    expect(css(h.shadow)).toContain("white-space:pre-wrap");
  });
});

// ─── Chrome ──────────────────────────────────────────────────

describe("panel chrome", () => {
  it("the panel takes the storefront direction", async () => {
    const h = await boot();
    expect((h.shadow.querySelector(".panel") as HTMLElement).getAttribute("dir")).toBe("rtl");
  });

  it("an English storefront gets an ltr panel", async () => {
    const h = await boot({ appearance: { language: "en" }, storefrontLocale: "en" });
    expect((h.shadow.querySelector(".panel") as HTMLElement).getAttribute("dir")).toBe("ltr");
  });

  it('the composer uses dir="auto" so typing starts on the writer\'s side', async () => {
    const h = await boot();
    const ta = h.shadow.querySelector("textarea.ta") as HTMLTextAreaElement;
    expect(ta.getAttribute("dir")).toBe("auto");
    expect(css(h.shadow)).toContain(".ta{text-align:start;}");
    expect(css(h.shadow)).toContain(".ta::placeholder{color:#9aa7b8;text-align:start;}");
  });

  it("the placeholder is in the widget language", async () => {
    const h = await boot();
    const ta = h.shadow.querySelector("textarea.ta") as HTMLTextAreaElement;
    expect(ta.getAttribute("placeholder")).toBe("אפשר לשאול אותנו הכל");
  });

  it("bubbles align to their own start edge, not the panel's", async () => {
    const h = await boot();
    const sheet = css(h.shadow);
    expect(sheet).toContain("text-align:start;");
    expect(sheet).toContain(".bub[dir='rtl']{text-align:right;}");
    expect(sheet).toContain(".bub[dir='ltr']{text-align:left;}");
  });

  it("the send control points along the reading direction", async () => {
    const rtl = await boot();
    const ltr = await boot({ appearance: { language: "en" }, storefrontLocale: "en" });
    const arrow = (h: Harness) =>
      (h.shadow.querySelector("button.snd") as HTMLElement).innerHTML;
    expect(arrow(rtl)).not.toBe(arrow(ltr));
  });

  it("the close control stays a 44px target on the inline-end corner", async () => {
    const h = await boot();
    // Universal-meaning icon: the glyph itself is NOT mirrored, only the
    // corner it lives in moves.
    const closeBtn = h.shadow.querySelector('[data-act="close"]') as HTMLElement;
    expect(closeBtn).toBeTruthy();
    expect(closeBtn.innerHTML).toContain("M6 6l12 12M18 6L6 18");
    expect(css(h.shadow)).toContain("position:absolute;top:var(--s2);left:var(--s2);");
  });

  it("suggested questions resolve their own direction", async () => {
    const h = await boot({
      welcome: { suggestedQuestions: ["איזה מוצר מתאים לי?", "Do you ship to Israel?"] },
      messages: [],
    });
    // The welcome screen only shows with no conversation history, so boot
    // a fresh panel with none.
    const chips = Array.from(h.shadow.querySelectorAll(".sug-b")) as HTMLElement[];
    expect(chips.map((c) => c.getAttribute("dir"))).toEqual(["rtl", "ltr"]);
    expect(css(h.shadow)).toContain(".sug-b{text-align:start;");
  });

  it("the typing indicator follows the conversation direction", async () => {
    const h = await boot({ messages: [msg({ body: "שלום" })] });
    const ta = h.shadow.querySelector("textarea.ta") as HTMLTextAreaElement;
    ta.value = "עוד שאלה";
    (h.shadow.querySelector("form.cmp") as HTMLFormElement).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 5));
    const typing = h.shadow.querySelector(".typ")?.parentElement as HTMLElement | null;
    if (typing) expect(typing.getAttribute("dir")).toBe("rtl");
  });
});

// ─── Product cards and the carousel ──────────────────────────

describe("product cards in RTL", () => {
  const commerce = (products: any[]) => ({ addToCartEnabled: true, products });

  it("a card follows the WIDGET direction, not the message it sits under", async () => {
    // "Do not globally reverse product cards or controls": an English
    // product title inside a Hebrew reply must not flip the image, the
    // buttons and the stepper to the other side mid-conversation.
    const h = await boot({
      messages: [msg({ direction: "OUTBOUND", authorKind: "ai", author: "עוזר", body: "", commerce: commerce([product()]) })],
    });
    expect((h.shadow.querySelector(".card") as HTMLElement).getAttribute("dir")).toBe("rtl");
  });

  it("an English product title inside an RTL card reads left to right", async () => {
    const h = await boot({
      messages: [msg({ direction: "OUTBOUND", authorKind: "ai", body: "", commerce: commerce([product()]) })],
    });
    const title = h.shadow.querySelector(".card-ti") as HTMLElement;
    expect(title.getAttribute("dir")).toBe("ltr");
    expect(title.textContent).toBe("Cloud Pro Runner");
  });

  it("a Hebrew recommendation reason reads right to left in the same card", async () => {
    const h = await boot({
      messages: [msg({ direction: "OUTBOUND", authorKind: "ai", body: "", commerce: commerce([product()]) })],
    });
    expect((h.shadow.querySelector(".why") as HTMLElement).getAttribute("dir")).toBe("rtl");
  });

  it("prices are always ltr atoms so the currency symbol cannot move", async () => {
    const h = await boot({
      messages: [msg({ direction: "OUTBOUND", authorKind: "ai", body: "", commerce: commerce([product()]) })],
    });
    const priceRow = h.shadow.querySelector(".card-pr") as HTMLElement;
    expect(priceRow.getAttribute("dir")).toBe("ltr");
    const atoms = Array.from(priceRow.querySelectorAll("bdi"));
    expect(atoms.length).toBeGreaterThanOrEqual(2);
    for (const a of atoms) expect(a.getAttribute("dir")).toBe("ltr");
    // The discount badge is a negative number; a migrated minus sign
    // would turn a 20% discount into a 20% rise.
    expect(atoms.some((a) => a.textContent === "-20%")).toBe(true);
  });

  it("a sold-out product is still marked in an RTL card", async () => {
    const h = await boot({
      messages: [
        msg({
          direction: "OUTBOUND",
          authorKind: "ai",
          body: "",
          commerce: commerce([
            product({
              available: false,
              variants: [{ variantId: "9001", title: "Default", price: "120.00", compareAtPrice: null, available: false, options: [], requiresSellingPlan: false }],
            }),
          ]),
        }),
      ],
    });
    expect(h.shadow.querySelector(".tag-out")?.textContent).toBe("אזל מהמלאי");
  });
});

describe("carousel in RTL", () => {
  const three = () => ({
    addToCartEnabled: true,
    products: [
      product({ productId: "1", handle: "a", title: "Alpha" }),
      product({ productId: "2", handle: "b", title: "Beta" }),
      product({ productId: "3", handle: "c", title: "Gamma" }),
    ],
  });

  async function bootCarousel(appearance?: Record<string, any>, storefrontLocale?: string) {
    return boot({
      appearance,
      storefrontLocale,
      messages: [msg({ direction: "OUTBOUND", authorKind: "ai", body: "", commerce: three() })],
    });
  }

  it("advances toward the reading END, which is NEGATIVE scrollLeft in RTL", async () => {
    // The bug this pins: `scrollLeft += step` in an RTL container walks
    // into the start edge, so the arrows appeared dead.
    const h = await bootCarousel();
    const strip = h.shadow.querySelector(".car-tr") as HTMLElement;
    strip.scrollLeft = 0;
    (h.shadow.querySelector('[data-act="carousel-next"]') as HTMLElement).click();
    expect(strip.scrollLeft).toBe(-224);
    (h.shadow.querySelector('[data-act="carousel-prev"]') as HTMLElement).click();
    expect(strip.scrollLeft).toBe(0);
  });

  it("advances toward POSITIVE scrollLeft in LTR", async () => {
    const h = await bootCarousel({ language: "en" }, "en");
    const strip = h.shadow.querySelector(".car-tr") as HTMLElement;
    strip.scrollLeft = 0;
    (h.shadow.querySelector('[data-act="carousel-next"]') as HTMLElement).click();
    expect(strip.scrollLeft).toBe(224);
  });

  it("the chevrons point along the reading order", async () => {
    const rtl = await bootCarousel();
    expect(rtl.shadow.querySelector('[data-act="carousel-next"]')?.textContent).toBe("‹");
    expect(rtl.shadow.querySelector('[data-act="carousel-prev"]')?.textContent).toBe("›");

    const ltr = await bootCarousel({ language: "en" }, "en");
    expect(ltr.shadow.querySelector('[data-act="carousel-next"]')?.textContent).toBe("›");
    expect(ltr.shadow.querySelector('[data-act="carousel-prev"]')?.textContent).toBe("‹");
  });

  it("keeps arrow keys PHYSICAL so the keycap means what it says", async () => {
    const h = await bootCarousel();
    const strip = h.shadow.querySelector(".car-tr") as HTMLElement;
    strip.scrollLeft = 0;
    strip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(strip.scrollLeft).toBe(224);
    strip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(strip.scrollLeft).toBe(0);
  });

  it("the strip stays focusable and labelled in RTL", async () => {
    const h = await bootCarousel();
    const strip = h.shadow.querySelector(".car-tr") as HTMLElement;
    expect(strip.getAttribute("tabindex")).toBe("0");
    expect(strip.getAttribute("role")).toBe("group");
    expect(strip.getAttribute("dir")).toBe("rtl");
  });

  it("accessibility order follows the DOM, so it stays logical in RTL", async () => {
    const h = await bootCarousel();
    const titles = Array.from(h.shadow.querySelectorAll(".card-ti")).map((n) => n.textContent);
    expect(titles).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});

// ─── Mobile ──────────────────────────────────────────────────

describe("mobile layout in RTL", () => {
  it("the phone panel is driven by logical insets, not a hardcoded side", async () => {
    (window as any).matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: true,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }));
    const h = await boot({ messages: [msg({ body: "שלום" })] });
    const sheet = css(h.shadow);
    // width:auto driven by insets is what keeps the panel on screen when
    // the theme is wide; a physical `width:100%` overflows.
    expect(sheet).toContain("width:auto");
    expect(bubbles(h.shadow)[0].getAttribute("dir")).toBe("rtl");
  });
});
