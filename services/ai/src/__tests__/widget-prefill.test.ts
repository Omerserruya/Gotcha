/**
 * The website widget designed from the merchant's site during onboarding
 * (2026-11-11), through the real ensureWebchat / putWidget on an in-memory
 * channel table:
 *   - a fresh tenant ends with a WEBCHAT row carrying the filled values, and
 *     the images are OUR copies (the upload), never the merchant's URLs
 *   - only fields still at a default are written (the Hebrew seed counts)
 *   - unsure means unset; an SVG or a non-image is never offered or stored
 *   - a units refusal or a failed upload leaves the defaults; the row still exists
 *   - no dashes in the copy; the bubble stays off
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ accounts: [] as any[], locale: null as string | null }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const match = (a: any, w: any) => Object.entries(w ?? {}).every(([k, v]) => a[k] === v);
  return {
    ...actual,
    prisma: {
      tenant: { findUnique: async () => ({ defaultLocale: H.locale }) },
      channelAccount: {
        create: async (a: any) => { const r = { id: `ca_${H.accounts.length}`, createdAt: new Date(), ...a.data }; H.accounts.push(r); return r; },
        findFirst: async (a: any) => H.accounts.find((r) => match(r, a.where)) ?? null,
        findMany: async (a: any) => H.accounts.filter((r) => match(r, a.where)),
        update: async (a: any) => { const r = H.accounts.find((x) => x.id === a.where.id); Object.assign(r, a.data); return r; },
      },
    },
    writeDurableSetting: vi.fn(async () => undefined),
  };
});
vi.mock("../services/shopify-live-chat.service", () => ({ listChannels: async () => [], saveChannelConfig: async () => undefined }));
vi.mock("../services/ai.service", () => ({ generateResponse: vi.fn(), getDefaultModel: () => "test-model" }));

import { normalizeWebchatConfig } from "@chatcenter/shared";
import { prefillWidget, openFields, type PrefillDeps, type PrefillInput } from "../services/widget-prefill.service";

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(40);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}

const IMAGES: Record<string, Buffer> = {
  "https://shop.example/logo.png": png(180, 180),
  "https://shop.example/hero.jpg": png(1600, 600),
  "https://shop.example/notimage.png": Buffer.from("<html>no</html>"),
};

const input = (over: Partial<PrefillInput> = {}): PrefillInput => ({
  tenantId: "T",
  authorization: "Bearer admin",
  domain: "https://shop.example",
  language: "he",
  logos: [{ url: "https://shop.example/logo.png" }],
  heroes: [{ url: "https://shop.example/hero.jpg" }],
  colors: [{ hex: "#1d4ed8" }],
  context: { businessName: "Shop", summary: "Handmade scarves" },
  ...over,
});

const ANSWER = {
  logo: "L0", color: "#1d4ed8", hero: "H0",
  title: "היי, במה נעזור היום?",
  assistantName: "צוות Shop",
  suggestedQuestions: ["איזה צעיף מתאים לחורף?", "כמה זמן לוקח משלוח?", "אפשר להחליף מידה?"],
  proactiveMessage: "מחפשים צעיף מיוחד? אנחנו כאן",
};

let uploads: any[] = [];
let modelCalls: any[] = [];
const deps = (answer: any = ANSWER, over: Partial<PrefillDeps> = {}): PrefillDeps => ({
  fetchImage: async (url) => IMAGES[url] ?? null,
  upload: async (u) => { uploads.push(u); return `https://app.gotcha.test/api/uploads/widget/${u.slot}-copy.png`; },
  model: async (m) => { modelCalls.push(m); if (answer instanceof Error) throw answer; return JSON.stringify(answer); },
  record: async () => undefined,
  ...over,
});

const webchat = () => normalizeWebchatConfig(H.accounts.find((a) => a.channel === "WEBCHAT")?.credentials);

beforeEach(() => { H.accounts = []; H.locale = null; uploads = []; modelCalls = []; });

describe("a fresh tenant", () => {
  it("ends the scan with a WEBCHAT row carrying the filled values, images as our own copies", async () => {
    const r = await prefillWidget(input(), deps());
    expect(r.status).toBe("done");
    expect(H.accounts.filter((a) => a.channel === "WEBCHAT")).toHaveLength(1);
    const c = webchat();
    expect(c.appearance.primaryColor).toBe("#1d4ed8");
    expect(c.appearance.logoUrl).toBe("https://app.gotcha.test/api/uploads/widget/logo-copy.png");
    expect(c.ux.hero).toMatchObject({ mediaType: "image", mediaUrl: "https://app.gotcha.test/api/uploads/widget/cover-copy.png" });
    expect(c.appearance.language).toBe("he");
    expect(c.ux.welcome.title).toBe(ANSWER.title);
    expect(c.ux.welcome.assistantName).toBe(ANSWER.assistantName);
    expect(c.ux.welcome.suggestedQuestions).toEqual(ANSWER.suggestedQuestions);
    expect(c.ux.proactive.message).toBe(ANSWER.proactiveMessage);
    // The bubble stays off and the header still names the employee.
    expect(c.ux.proactive.enabled).toBe(false);
    expect(c.nameSource).toBe("employee");
    // Nothing of the merchant's host is stored.
    expect(JSON.stringify(H.accounts[0].credentials)).not.toContain("shop.example");
    // The upload got the vetted bytes, not a link.
    expect(uploads.map((u) => [u.slot, u.type, Buffer.isBuffer(u.bytes)])).toEqual([["logo", "png", true], ["cover", "png", true]]);
    // The model saw the images as bytes, not the merchant's URLs.
    expect(JSON.stringify(modelCalls[0].messages)).not.toContain("https://shop.example/logo.png");
  });
});

describe("only the defaults are written", () => {
  it("a field the merchant set is never overwritten; the Hebrew seed counts as a default", async () => {
    H.locale = "he";
    H.accounts.push({
      id: "ca_x", tenantId: "T", channel: "WEBCHAT", createdAt: new Date(),
      credentials: { v: 2, nameSource: "employee", appearance: { primaryColor: "#ff0055" }, ux: { welcome: { title: "My own title" } } },
    });
    await prefillWidget(input(), deps());
    const c = webchat();
    expect(c.appearance.primaryColor).toBe("#ff0055");
    expect(c.ux.welcome.title).toBe("My own title");
    expect(c.appearance.logoUrl).toContain("logo-copy");
    expect(c.ux.welcome.suggestedQuestions).toEqual(ANSWER.suggestedQuestions);
  });

  it("the Hebrew seed copy is open; a set hero closes the hero", () => {
    const seeded = normalizeWebchatConfig({ v: 2, nameSource: "employee", ...{} });
    expect(openFields(seeded).has("ux.welcome.title")).toBe(true);
    const withHero = normalizeWebchatConfig({ v: 2, ux: { hero: { mediaType: "image", mediaUrl: "https://x.test/a.png" } } });
    expect(openFields(withHero).has("ux.hero.mediaUrl")).toBe(false);
  });

  it("nothing at default: no model call at all", async () => {
    H.accounts.push({
      id: "ca_x", tenantId: "T", channel: "WEBCHAT", createdAt: new Date(),
      credentials: {
        v: 2, nameSource: "custom",
        appearance: { primaryColor: "#ff0055", logoUrl: "https://cdn.test/l.png", language: "en" },
        ux: { hero: { mediaType: "image", mediaUrl: "https://cdn.test/h.png" }, welcome: { title: "a", assistantName: "b", suggestedQuestions: ["q"] }, proactive: { message: "m" } },
      },
    });
    const r = await prefillWidget(input(), deps());
    expect(r.status).toBe("none");
    expect(modelCalls).toHaveLength(0);
  });
});

describe("unsure means unset", () => {
  it("nulls from the model leave those fields alone; a colour not offered is refused", async () => {
    await prefillWidget(input(), deps({ ...ANSWER, logo: null, hero: null, color: "#123456" }));
    const c = webchat();
    expect(c.appearance.logoUrl).toBeNull();
    expect(c.ux.hero.mediaType).toBe("none");
    expect(c.appearance.primaryColor).toBe("#7c3aed");
    expect(uploads).toHaveLength(0);
  });

  it("a non-image candidate is never shown to the model; a colour white text cannot sit on is never offered", async () => {
    await prefillWidget(input({ logos: [{ url: "https://shop.example/notimage.png" }], heroes: [], colors: [{ hex: "#ffee88" }] }), deps());
    expect(JSON.stringify(modelCalls[0].messages)).not.toContain("image_url");
    expect(modelCalls[0].messages[0].content[0].text).toContain("Colour candidates: none");
    expect(webchat().appearance.logoUrl).toBeNull();
  });

  it("no brand and nothing learned: no model call, defaults stay, the chat still exists", async () => {
    const r = await prefillWidget(input({ logos: [], heroes: [], colors: [], context: {} }), deps());
    expect(r).toMatchObject({ status: "none", reason: "no_brand" });
    expect(modelCalls).toHaveLength(0);
    expect(H.accounts.filter((a) => a.channel === "WEBCHAT")).toHaveLength(1);
  });
});

describe("failures keep the defaults", () => {
  it("a units refusal: failed, nothing written, the chat exists", async () => {
    const refused = Object.assign(new Error("ai_units:units_exhausted"), { name: "AiUnitsExhaustedError" });
    const r = await prefillWidget(input(), deps(refused));
    expect(r).toMatchObject({ status: "failed", reason: "units_refused" });
    expect(H.accounts).toHaveLength(1);
    expect(webchat().appearance.primaryColor).toBe("#7c3aed");
  });

  it("an upload that fails leaves that image unset (never the hotlink)", async () => {
    await prefillWidget(input(), deps(ANSWER, { upload: async () => null }));
    const c = webchat();
    expect(c.appearance.logoUrl).toBeNull();
    expect(c.ux.hero.mediaType).toBe("none");
    expect(c.appearance.primaryColor).toBe("#1d4ed8");
  });

  it("copy with dashes or too long is dropped, three questions or none", async () => {
    await prefillWidget(input(), deps({ ...ANSWER, title: "Hi \u2014 welcome", assistantName: "x".repeat(41), suggestedQuestions: ["a", "b"] }));
    const c = webchat();
    expect(c.ux.welcome.title).toBe("Hi - welcome"); // the house sanitizer: never a wide dash
    expect(c.ux.welcome.title).not.toMatch(/[\u2013\u2014]/);
    expect(c.ux.welcome.assistantName).toBe("Store Assistant");
    expect(c.ux.welcome.suggestedQuestions).toHaveLength(3);
    expect(c.ux.welcome.suggestedQuestions[0]).toBe("Which product is right for me?");
  });
});
