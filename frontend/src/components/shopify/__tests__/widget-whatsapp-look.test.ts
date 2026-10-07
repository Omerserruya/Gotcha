/**
 * ★ Website widget stage B in the REAL bundle (public/widget/gotcha-shopify-chat.js):
 *   - "Continue on WhatsApp" chip: only when the server says the handoff is
 *     available AND the host gives a way to ask for the link; the window is
 *     opened inside the click and pointed at the link; the link stays in chat
 *   - the WhatsApp look: its header, and a send that continues on WhatsApp
 *     with the visitor's words instead of asking the website chat; without a
 *     working handoff it is a normal chat in WhatsApp colours
 *   - the socket: a host's own auth (the code snippet's session token) and its
 *     normalisation of pushed messages
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";

const WIDGET_SOURCE = fs.readFileSync(path.resolve(__dirname, "../../../../public/widget/gotcha-shopify-chat.js"), "utf8");

const flush = () => new Promise((r) => setTimeout(r, 20));

async function boot(o: { look?: "gotcha" | "whatsapp"; available?: boolean; withHost?: boolean; socket?: boolean } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const storeData: Record<string, string> = { session: "conv1", conversation: "conv1", token: "secret" };
  const post = vi.fn(async (p: string) => (p.endsWith("/conversation") ? { data: { conversationId: "conv1", status: "OPEN", isHandedOver: false, messages: [] } } : { data: {} }));
  const get = vi.fn(async () => ({ data: { conversationId: "conv1", messages: [] } }));
  const whatsappHandoff = vi.fn(async (opts: any) => ({ url: `https://wa.me/972525551234?text=${encodeURIComponent((opts.text || "Hi") + " (K7Q2MX)")}`, ref: "K7Q2MX" }));
  const normalize = vi.fn((list: any[]) => list.map((m) => ({ ...m, author: m.senderName, messageType: "text" })));
  const socketAuth = vi.fn(() => ({ webchatToken: "secret", conversationId: "conv1" }));
  const state: any = {
    api: "https://dev.gotcha.co.il", assets: "https://dev.gotcha.co.il", apiPath: "/api/embedded-chat",
    context: { pageType: "page", productHandle: null, locale: "en" }, availability: "online",
    store: { get: (k: string) => storeData[k] ?? null, set: (k: string, v: string) => { storeData[k] = v; }, del: (k: string) => { delete storeData[k]; } },
    post, get, shadow, setUnread: vi.fn(), onOpened: vi.fn(), onClosed: vi.fn(),
    ...(o.withHost === false ? {} : { whatsappHandoff }),
    ...(o.socket ? { socketAuth, normalize } : {}),
    widget: {
      appearance: { primaryColor: "#111827", contrastColor: "#ffffff", logoUrl: null, avatarUrl: null, launcherIcon: "chat", launcherPosition: "right", cornerRadius: 20, language: "en", direction: "auto", showPoweredBy: true },
      welcome: { headline: "Hi there", subline: "", assistantName: "Store Assistant", suggestedQuestions: [] },
      offline: { active: false, message: "", behavior: "ai", formFields: [], consentRequired: false, consentText: "" },
      features: { humanHandoff: true, productMessaging: false, addToCart: false, whatsappHandoff: o.available !== false },
      ux: { look: o.look ?? "gotcha" },
    },
  };
  const app = (window as any).__gotchaShopifyChatApp(state);
  app.open();
  await flush();
  return { app, shadow, post, whatsappHandoff, normalize, socketAuth };
}

let opened: any[] = [];
beforeEach(() => {
  document.body.innerHTML = "";
  opened = [];
  (window as any).open = vi.fn(() => { const w = { location: { href: "" }, opener: {}, close: vi.fn() }; opened.push(w); return w; });
  (window as any).matchMedia = vi.fn().mockImplementation((q: string) => ({ matches: false, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
  delete (window as any).io;
  (0, eval)(WIDGET_SOURCE);
});

describe("★ the Continue on WhatsApp chip (GOTCHA look)", () => {
  it("shown when available AND the host can ask for the link; a click opens WhatsApp with the code", async () => {
    const h = await boot();
    const chip = h.shadow.querySelector("[data-act=whatsapp]") as HTMLButtonElement;
    expect(chip).toBeTruthy();
    expect(chip.getAttribute("aria-label")).toBe("Continue on WhatsApp");
    chip.click();
    // Opened inside the click, before the server answered (popup blockers).
    expect(opened).toHaveLength(1);
    await flush();
    expect(h.whatsappHandoff).toHaveBeenCalledWith({ locale: "en", text: undefined });
    expect(opened[0].location.href).toBe(`https://wa.me/972525551234?text=${encodeURIComponent("Hi (K7Q2MX)")}`);
    expect(opened[0].opener).toBeNull();
    const link = h.shadow.querySelector(".wa-note a") as HTMLAnchorElement;
    expect(link.href).toContain("wa.me/972525551234");
    expect(link.rel).toBe("noopener noreferrer");
  });

  it("not shown when the server says unavailable, or the host cannot ask", async () => {
    expect((await boot({ available: false })).shadow.querySelector("[data-act=whatsapp]")).toBeNull();
    document.body.innerHTML = "";
    expect((await boot({ withHost: false })).shadow.querySelector("[data-act=whatsapp]")).toBeNull();
  });
});

describe("★ the WhatsApp look", () => {
  it("its header says what it does", async () => {
    const h = await boot({ look: "whatsapp" });
    expect(h.shadow.querySelector(".panel")!.getAttribute("data-look")).toBe("whatsapp");
    expect(h.shadow.querySelector(".hd-nm")!.textContent).toBe("Chat with us");
    expect(h.shadow.querySelector(".hd-st")!.textContent).toContain("Write here and we'll continue on WhatsApp.");
    expect(h.shadow.querySelector("[data-act=whatsapp]")).toBeNull();
    expect((h.shadow.querySelector("textarea") as HTMLTextAreaElement).placeholder).toBe("Type a message");
  });

  it("a send continues on WhatsApp with the visitor's words; the website chat is not asked", async () => {
    const h = await boot({ look: "whatsapp" });
    const ta = h.shadow.querySelector("textarea") as HTMLTextAreaElement;
    ta.value = "Do you have a dry skin cream?";
    h.shadow.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(h.whatsappHandoff).toHaveBeenCalledWith({ locale: "en", text: "Do you have a dry skin cream?" });
    expect(h.post.mock.calls.map((c: any[]) => c[0])).not.toContain(expect.stringMatching(/\/message$/));
    expect(h.post.mock.calls.some((c: any[]) => String(c[0]).endsWith("/message"))).toBe(false);
    expect(opened[0].location.href).toContain(encodeURIComponent("Do you have a dry skin cream? (K7Q2MX)"));
  });

  it("without a working handoff it is a normal chat (the website answers)", async () => {
    const h = await boot({ look: "whatsapp", available: false });
    expect(h.shadow.querySelector(".hd-nm")!.textContent).toBe("Store Assistant");
    const ta = h.shadow.querySelector("textarea") as HTMLTextAreaElement;
    ta.value = "hello";
    h.shadow.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(h.whatsappHandoff).not.toHaveBeenCalled();
    expect(h.post.mock.calls.some((c: any[]) => String(c[0]).endsWith("/message"))).toBe(true);
  });
});

describe("★ the socket with the host's own auth", () => {
  it("connects with socketAuth, and a pushed message goes through the host's normalisation", async () => {
    const handlers: Record<string, any> = {};
    let options: any = null;
    (window as any).io = vi.fn((_url: string, opts: any) => {
      options = opts;
      return { on: (ev: string, fn: any) => { handlers[ev] = fn; }, io: { on: vi.fn() }, connected: false, disconnect: vi.fn(), close: vi.fn() };
    });
    const h = await boot({ socket: true });
    await flush();
    expect(options?.auth).toEqual({ webchatToken: "secret", conversationId: "conv1" });
    handlers["visitor:message"]({ conversationId: "conv1", message: { id: "m9", direction: "OUTBOUND", body: "Pushed hello", senderName: "Maya", createdAt: new Date().toISOString() } });
    await flush();
    expect(h.normalize).toHaveBeenCalled();
    expect(h.shadow.textContent).toContain("Pushed hello");
  });
});
