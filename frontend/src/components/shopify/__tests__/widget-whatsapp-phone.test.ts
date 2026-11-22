/**
 * ★★ "Continue on WhatsApp? Leave your number" (Omer, 2026-11-22) in the REAL
 * bundle: drawn only in the server's "phone" mode, the business's name in the
 * consent, the number sent in the same conversation, and every refusal said.
 * The harness is widget-whatsapp-look.test.ts's, with the mode and the host's
 * phone call added.
 *
 * Original header, for the harness:
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

async function boot(o: { look?: "gotcha" | "whatsapp"; available?: boolean; withHost?: boolean; socket?: boolean; mode?: string; brand?: string | null; withPhone?: boolean; phoneFails?: any } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const storeData: Record<string, string> = { session: "conv1", conversation: "conv1", token: "secret" };
  const post = vi.fn(async (p: string) => (p.endsWith("/conversation") ? { data: { conversationId: "conv1", status: "OPEN", isHandedOver: false, messages: [] } } : { data: {} }));
  const get = vi.fn(async () => ({ data: { conversationId: "conv1", messages: [] } }));
  const whatsappHandoff = vi.fn(async (opts: any) => ({ url: `https://wa.me/972525551234?text=${encodeURIComponent((opts.text || "Hi") + " (K7Q2MX)")}`, ref: "K7Q2MX" }));
  const whatsappPhoneHandoff = vi.fn(async () => {
    if (o.phoneFails) throw o.phoneFails;
    return {};
  });
  const normalize = vi.fn((list: any[]) => list.map((m) => ({ ...m, author: m.senderName, messageType: "text" })));
  const socketAuth = vi.fn(() => ({ webchatToken: "secret", conversationId: "conv1" }));
  const state: any = {
    api: "https://dev.gotcha.co.il", assets: "https://dev.gotcha.co.il", apiPath: "/api/embedded-chat",
    context: { pageType: "page", productHandle: null, locale: "en" }, availability: "online",
    store: { get: (k: string) => storeData[k] ?? null, set: (k: string, v: string) => { storeData[k] = v; }, del: (k: string) => { delete storeData[k]; } },
    post, get, shadow, setUnread: vi.fn(), onOpened: vi.fn(), onClosed: vi.fn(),
    ...(o.withHost === false ? {} : { whatsappHandoff }),
    ...(o.withPhone === false ? {} : { whatsappPhoneHandoff }),
    ...(o.socket ? { socketAuth, normalize } : {}),
    widget: {
      appearance: { primaryColor: "#111827", contrastColor: "#ffffff", logoUrl: null, avatarUrl: null, launcherIcon: "chat", launcherPosition: "right", cornerRadius: 20, language: "en", direction: "auto", showPoweredBy: true },
      welcome: { headline: "Hi there", subline: "", assistantName: "Store Assistant", suggestedQuestions: [] },
      offline: { active: false, message: "", behavior: "ai", formFields: [], consentRequired: false, consentText: "" },
      features: { humanHandoff: true, productMessaging: false, addToCart: false, whatsappHandoff: o.available !== false, ...(o.mode ? { waHandoffMode: o.mode } : {}) },
      ux: { look: o.look ?? "gotcha" },
      brand: o.brand === null ? null : { name: o.brand ?? "Aviv Boutique", initial: "A" },
    },
  };
  const app = (window as any).__gotchaShopifyChatApp(state);
  app.open();
  await flush();
  return { app, shadow, post, whatsappHandoff, whatsappPhoneHandoff, normalize, socketAuth };
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

const fail = (status: number, code: string) => Object.assign(new Error(code), { status });
const typeNumber = async (h: any, value: string) => {
  const input = h.shadow.querySelector(".wa-form input") as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input"));
  (h.shadow.querySelector(".wa-form") as HTMLFormElement).dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
};

describe("★★ phone mode: the business's number writes to the visitor", () => {
  it("★★ the WhatsApp button opens the form - no window, no link - with the business's name in the consent", async () => {
    const h = await boot({ mode: "phone" });
    (h.shadow.querySelector("[data-act=whatsapp]") as HTMLButtonElement).click();
    await flush();
    expect(opened).toHaveLength(0);
    expect(h.whatsappHandoff).not.toHaveBeenCalled();
    const form = h.shadow.querySelector(".wa-form") as HTMLElement;
    expect(form.textContent).toContain("Continue on WhatsApp? Leave your number");
    expect(form.querySelector("input")?.getAttribute("type")).toBe("tel");
    expect(form.querySelector(".wa-consent")?.textContent).toBe(
      "By sending, you agree to receive a WhatsApp message from Aviv Boutique about this conversation.",
    );
    expect(form.textContent).not.toMatch(/GOTCHA/);
  });

  it("★★ sends the number with the consent as shown, then says so - in the same chat", async () => {
    const h = await boot({ mode: "phone" });
    (h.shadow.querySelector("[data-act=whatsapp]") as HTMLButtonElement).click();
    await flush();
    await typeNumber(h, " 052-555-1234 ");
    expect(h.whatsappPhoneHandoff).toHaveBeenCalledWith({
      locale: "en",
      phone: "052-555-1234",
      text: undefined,
      consentText: "By sending, you agree to receive a WhatsApp message from Aviv Boutique about this conversation.",
    });
    expect(h.shadow.querySelector(".wa-form")).toBeNull();
    expect(h.shadow.querySelector(".wa-note")?.textContent).toContain("We've sent you a WhatsApp message. You can continue there.");
  });

  it.each([
    [fail(400, "invalid_phone"), "That number doesn't look right. Check it and try again."],
    [fail(429, "rate_limited"), "Several requests were sent in a row. Try again in a few minutes."],
    [fail(500, "request_failed"), "We couldn't send the message. Try again in a moment."],
  ])("⚠ a refusal (%s) is said, and the number stays to fix", async (error, words) => {
    const h = await boot({ mode: "phone", phoneFails: error });
    (h.shadow.querySelector("[data-act=whatsapp]") as HTMLButtonElement).click();
    await flush();
    await typeNumber(h, "0525551234");
    expect(h.shadow.querySelector(".wa-err")?.textContent).toBe(words);
    expect((h.shadow.querySelector(".wa-form input") as HTMLInputElement).value).toBe("0525551234");
  });

  it("⚠ an empty number is never sent", async () => {
    const h = await boot({ mode: "phone" });
    (h.shadow.querySelector("[data-act=whatsapp]") as HTMLButtonElement).click();
    await flush();
    await typeNumber(h, "   ");
    expect(h.whatsappPhoneHandoff).not.toHaveBeenCalled();
    expect(h.shadow.querySelector(".wa-err")).toBeTruthy();
  });
});

describe("★★ the mode is the server's, and nothing else", () => {
  it("★ code: today's link, unchanged", async () => {
    const h = await boot({ mode: "code" });
    (h.shadow.querySelector("[data-act=whatsapp]") as HTMLButtonElement).click();
    expect(opened).toHaveLength(1);
    await flush();
    expect(h.whatsappHandoff).toHaveBeenCalled();
    expect(h.shadow.querySelector(".wa-form")).toBeNull();
  });

  it("★ off: no WhatsApp at all, whatever the old flag says", async () => {
    expect((await boot({ mode: "off" })).shadow.querySelector("[data-act=whatsapp]")).toBeNull();
  });

  it("★ no mode (an older server): today's behaviour from the old flag", async () => {
    const h = await boot();
    (h.shadow.querySelector("[data-act=whatsapp]") as HTMLButtonElement).click();
    expect(opened).toHaveLength(1);
  });

  it("⚠⚠ phone without the business's name, or on a host that cannot send a number: today's link instead", async () => {
    for (const h of [await boot({ mode: "phone", brand: null }), await boot({ mode: "phone", withPhone: false })]) {
      (h.shadow.querySelector("[data-act=whatsapp]") as HTMLButtonElement).click();
      await flush();
      expect(h.shadow.querySelector(".wa-form")).toBeNull();
      expect(h.whatsappHandoff).toHaveBeenCalled();
    }
  });
});

describe("★★ the way back to the code link (Backend's shape, 2026-11-22)", () => {
  it("★★ 409 not_available with the code link: shown in the chat, no second call", async () => {
    const refusal = Object.assign(new Error("not_available"), {
      status: 409,
      data: { url: "https://wa.me/972525551234?text=Hi%20(K7Q2MX)", ref: "K7Q2MX" },
    });
    const h = await boot({ mode: "phone", phoneFails: refusal });
    (h.shadow.querySelector("[data-act=whatsapp]") as HTMLButtonElement).click();
    await flush();
    await typeNumber(h, "0525551234");
    expect(h.shadow.querySelector(".wa-form")).toBeNull();
    expect((h.shadow.querySelector(".wa-note a") as HTMLAnchorElement).href).toContain("wa.me/972525551234");
    expect(h.whatsappHandoff).not.toHaveBeenCalled();
  });

  it("⚠ 409 with no link at all: the generic line, the form stays", async () => {
    const h = await boot({ mode: "phone", phoneFails: Object.assign(new Error("not_available"), { status: 409 }) });
    (h.shadow.querySelector("[data-act=whatsapp]") as HTMLButtonElement).click();
    await flush();
    await typeNumber(h, "0525551234");
    expect(h.shadow.querySelector(".wa-err")?.textContent).toBe("We couldn't send the message. Try again in a moment.");
  });

  it("★★ after \"sent\" the code link stays one tap away - a delivery failure is never reported back", async () => {
    const h = await boot({ mode: "phone" });
    (h.shadow.querySelector("[data-act=whatsapp]") as HTMLButtonElement).click();
    await flush();
    await typeNumber(h, "0525551234");
    const link = h.shadow.querySelector("[data-act=wa-link]") as HTMLAnchorElement;
    expect(link.textContent).toBe("Open WhatsApp");
    link.click();
    // Opened inside the click (popup blockers), then pointed at the code link.
    expect(opened).toHaveLength(1);
    await flush();
    expect(h.whatsappHandoff).toHaveBeenCalled();
  });
});
