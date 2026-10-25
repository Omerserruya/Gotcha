/**
 * The website widget's own words in the workspace's language: the creation seed
 * and the one-click reset (2026-10-25).
 */
import { describe, it, expect } from "vitest";


describe("★ a widget's own words in the workspace's language (2026-10-25)", () => {
  it("a Hebrew seed normalises to Hebrew copy and every other default, as an employee-named widget", async () => {
    const { webchatSeedConfig, WEBCHAT_COPY, normalizeWebchatConfig, defaultWebchatConfig } = await import("../lib/webchat-widget");
    const cfg = normalizeWebchatConfig(webchatSeedConfig("he"));
    const d = defaultWebchatConfig();
    expect(cfg.displayName).toBe(WEBCHAT_COPY.he.displayName);
    expect(cfg.ux.welcome.title).toBe(WEBCHAT_COPY.he.welcome.title);
    expect(cfg.ux.welcome.suggestedQuestions).toEqual(WEBCHAT_COPY.he.welcome.suggestedQuestions);
    expect(cfg.ux.proactive.actionLabel).toBe(WEBCHAT_COPY.he.proactive.actionLabel);
    expect(cfg.offline.message).toBe(WEBCHAT_COPY.he.offline);
    expect(cfg.nameSource).toBe("employee");
    expect(cfg.appearance).toEqual(d.appearance);
    expect(cfg.commerce).toEqual(d.commerce);
    expect(cfg.ux.proactive.enabled).toBe(false);
  });

  it("English and unknown locales seed nothing: created exactly as before", async () => {
    const { webchatSeedConfig } = await import("../lib/webchat-widget");
    expect(webchatSeedConfig("en")).toEqual({});
    expect(webchatSeedConfig(undefined)).toEqual({});
    expect(webchatSeedConfig("ar")).toEqual({});
  });

  it("the reset changes ONLY the copy: hero, logo, colours, commerce and name source stay", async () => {
    const { webchatCopyResetPatch, WEBCHAT_COPY, normalizeWebchatConfig } = await import("../lib/webchat-widget");
    const current = normalizeWebchatConfig({
      v: 2, nameSource: "custom", displayName: "Website Chat",
      appearance: { primaryColor: "#123456", logoUrl: "https://dev.gotcha.co.il/api/uploads/widget/logo.png" },
      ux: { hero: { mediaUrl: "https://dev.gotcha.co.il/api/uploads/widget/h.jpg" }, welcome: { title: "How can I help?", avatarSize: 72 } },
      commerce: { productMessagingEnabled: true, addToCartEnabled: true, promotions: { couponIds: ["486"] } },
    });
    const next = webchatCopyResetPatch(current, "he");
    expect(next.ux.welcome.title).toBe(WEBCHAT_COPY.he.welcome.title);
    expect(next.ux.welcome.assistantName).toBe(WEBCHAT_COPY.he.welcome.assistantName);
    expect(next.offline.message).toBe(WEBCHAT_COPY.he.offline);
    expect(next.displayName).toBe(WEBCHAT_COPY.he.displayName);
    expect(next.ux.welcome.avatarSize).toBe(72);
    expect(next.ux.hero).toEqual(current.ux.hero);
    expect(next.appearance).toEqual(current.appearance);
    expect(next.commerce).toEqual(current.commerce);
    expect(next.nameSource).toBe("custom");
  });

  it("the Hebrew copy has no dash, no maqaf and no slashed gender form", async () => {
    const { WEBCHAT_COPY } = await import("../lib/webchat-widget");
    const all = JSON.stringify(WEBCHAT_COPY.he);
    expect(all).not.toMatch(/[–—־]|\s-\s|\/י|\/ה/);
  });
});
