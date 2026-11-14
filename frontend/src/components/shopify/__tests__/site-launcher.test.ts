/**
 * The code snippet's bubble and pop-up (gotcha-site.js) and the Shopify
 * bootstrap's - the two launchers a merchant's site can draw - with the
 * merchant's one logo (Omer, 2026-10-25).
 *
 * Drives the REAL files in jsdom. The chat bundle each one mounts is
 * stubbed: only the launcher is under test here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

const WIDGET_DIR = path.resolve(__dirname, "../../../../public/widget");
const SITE_SOURCE = fs.readFileSync(path.join(WIDGET_DIR, "gotcha-site.js"), "utf8");

const LOGO = "https://dev.gotcha.co.il/api/uploads/widget/logo-ok.png";

/** jsdom loads no images: one whose URL says "ok" loads, any other fails. */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(url: string) {
    setTimeout(() => (url.includes("ok") ? this.onload?.() : this.onerror?.()), 0);
  }
}

function widget(overrides: { appearance?: Record<string, unknown>; ux?: Record<string, unknown> } = {}) {
  return {
    appearance: { primaryColor: "#d9cfc2", logoUrl: null, language: "en", ...overrides.appearance },
    welcome: { headline: "Hi", subline: "", assistantName: "Noa", suggestedQuestions: [] },
    features: {},
    offline: { active: false },
    ux: {
      kind: "chat",
      look: "gotcha",
      launcher: { position: "right", iconUrl: null },
      welcome: { avatarUrl: null },
      proactive: { enabled: true, delaySeconds: 1, message: "Need a hand?", maxPerSession: 1 },
      ...overrides.ux,
    },
    brand: { name: "HALVØ", initial: "H" },
    promotions: [],
  };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

function mountSite(w: ReturnType<typeof widget>) {
  (0, eval)(SITE_SOURCE);
  (window as any).__gotchaSiteMount({
    api: "https://dev.gotcha.co.il",
    widgetId: "widget_test",
    data: { availability: "online", widget: w },
  });
  const shadow = document.getElementById("gotcha-chat-root")!.shadowRoot!;
  return { shadow, launcher: () => shadow.querySelector(".ldr") as HTMLButtonElement };
}

beforeEach(() => {
  document.body.innerHTML = "";
  delete (window as any).__gotchaSiteMounted;
  localStorage.clear();
  sessionStorage.clear();
  (window as any).Image = FakeImage;
  (window as any).matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  (window as any).__gotchaShopifyChatApp = vi.fn(() => ({ open: vi.fn(), close: vi.fn() }));
  (globalThis as any).fetch = vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("★★ the code snippet's bubble (gotcha-site.js)", () => {
  it("no logo: the brand's initial on the main colour", async () => {
    const { launcher } = mountSite(widget());
    await flush();
    expect(launcher().querySelector(".mark")!.textContent).toBe("H");
    expect(launcher().querySelector("img")).toBeNull();
    expect(launcher().getAttribute("data-logo")).not.toBe("1");
  });

  it("★ the logo once it has loaded, on white; the dot and the badge stay", async () => {
    const { shadow, launcher } = mountSite(widget({ appearance: { logoUrl: LOGO } }));
    // Until the image is there, the initial: never an empty or broken bubble.
    expect(launcher().querySelector(".mark")!.textContent).toBe("H");
    await flush();
    expect(launcher().querySelector("img.mark-img")!.getAttribute("src")).toBe(LOGO);
    expect(launcher().getAttribute("data-logo")).toBe("1");
    expect(launcher().querySelector(".on")).toBeTruthy();
    expect(launcher().querySelector(".bdg")).toBeTruthy();
    expect(shadow.querySelector("style")!.textContent).toContain(".ldr[data-logo='1']{background:#fff;}");
  });

  it("a logo that does not load leaves the initial", async () => {
    const { launcher } = mountSite(widget({ appearance: { logoUrl: "https://dev.gotcha.co.il/dead.png" } }));
    await flush();
    expect(launcher().querySelector("img")).toBeNull();
    expect(launcher().querySelector(".mark")!.textContent).toBe("H");
  });

  it("a legacy launcher.iconUrl still wins over the logo", async () => {
    const { launcher } = mountSite(
      widget({
        appearance: { logoUrl: LOGO },
        ux: { launcher: { position: "right", iconUrl: "https://cdn.example.com/icon-ok.png" } },
      }),
    );
    await flush();
    expect(launcher().querySelector("img")!.getAttribute("src")).toBe("https://cdn.example.com/icon-ok.png");
  });

  it("an empty logo is no logo, never the page's own address", async () => {
    const { launcher } = mountSite(widget({ appearance: { logoUrl: "" } }));
    await flush();
    expect(launcher().querySelector("img")).toBeNull();
  });

  it("★ the pop-up's avatar is the same logo", async () => {
    vi.useFakeTimers();
    const { shadow } = mountSite(widget({ appearance: { logoUrl: LOGO } }));
    await vi.advanceTimersByTimeAsync(4000);
    const av = shadow.querySelector(".pav")!;
    expect(av.querySelector("img")!.getAttribute("src")).toBe(LOGO);
    expect(av.getAttribute("data-logo")).toBe("1");
    expect(av.querySelector(".pav-on")).toBeTruthy();
  });
});

describe("★★ Add to cart on the store's own page (gotcha-site.js, W9c)", () => {
  it("★ after a same-origin add, the chat offers the store's cart page: its home plus cart/", async () => {
    mountSite(widget());
    const opts = (window as any).__gotchaShopifyChatApp.mock.calls[0][0];
    const fetchMock = vi.fn(async () => ({ ok: true }));
    (globalThis as any).fetch = fetchMock;
    const home = window.location.origin + "/shop/";
    // Backend's wooCartLine: the store's home with ?add-to-cart=. Stubbed: nothing reaches a real cart.
    const done = await opts.addToCart({ cartUrl: home + "?add-to-cart=12&quantity=1" });
    expect(fetchMock).toHaveBeenCalledWith(home + "?add-to-cart=12&quantity=1", expect.objectContaining({ credentials: "same-origin" }));
    expect(done).toEqual({ cartPage: home + "cart/" });
  });

  it("a store at the root: /cart/", async () => {
    mountSite(widget());
    const opts = (window as any).__gotchaShopifyChatApp.mock.calls[0][0];
    (globalThis as any).fetch = vi.fn(async () => ({ ok: true }));
    const done = await opts.addToCart({ cartUrl: window.location.origin + "/?add-to-cart=7" });
    expect(done).toEqual({ cartPage: window.location.origin + "/cart/" });
  });
});

describe("★★ talk to a person reaches the server (gotcha-site.js, 2026-10-26)", () => {
  /*
   * The adapter answered /handoff locally with { data: {} }: the visitor was
   * told "connecting you" and nobody was. Now it is the server's
   * POST /api/embedded-chat/handoff, with the visitor's own session.
   */
  const KEY = "cc_widget_test_";
  const adapter = () => (window as any).__gotchaShopifyChatApp.mock.calls[0][0];
  const answer = (status: number, body: unknown) =>
    vi.fn(async (..._args: unknown[]) => ({ ok: status < 400, status, json: async () => body }));

  beforeEach(() => {
    localStorage.setItem(KEY + "conversation", "sess_1");
    localStorage.setItem(KEY + "token", "tok_1");
  });

  it("★★ posts the visitor's session and token, and resolves on a handover", async () => {
    mountSite(widget());
    const fetchMock = answer(200, { data: { handedOver: true } });
    (globalThis as any).fetch = fetchMock;
    const res = await adapter().post("/api/embedded-chat/handoff", {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dev.gotcha.co.il/api/embedded-chat/handoff");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ sessionId: "sess_1", sessionToken: "tok_1" });
    expect(res).toEqual({ data: { handedOver: true } });
  });

  it.each([
    ["403: the merchant has not turned the button on", 403, { error: "handoff_disabled" }],
    ["404: not this visitor's session", 404, { error: "unavailable" }],
    ["500", 500, { error: "unavailable" }],
  ])("★★ %s rejects - never a quiet success", async (_name, status, body) => {
    mountSite(widget());
    (globalThis as any).fetch = answer(status, body);
    await expect(adapter().post("/api/embedded-chat/handoff", {})).rejects.toMatchObject({ status });
  });

  it("★ an ok answer that is not a handover rejects too", async () => {
    mountSite(widget());
    (globalThis as any).fetch = answer(200, { data: {} });
    await expect(adapter().post("/api/embedded-chat/handoff", {})).rejects.toThrow("not_handed_over");
  });

  it("/events and /lead still resolve here, without a request", async () => {
    mountSite(widget());
    const fetchMock = answer(200, {});
    (globalThis as any).fetch = fetchMock;
    await expect(adapter().post("/api/embedded-chat/events", {})).resolves.toEqual({ data: {} });
    await expect(adapter().post("/api/embedded-chat/lead", {})).resolves.toEqual({ data: {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
