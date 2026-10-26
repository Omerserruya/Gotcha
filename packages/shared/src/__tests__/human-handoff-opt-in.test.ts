/**
 * The widget's "talk to a person" button is opt-in (Omer, 2026-10-26): unset is
 * off in both widgets, a stored true stays true, and what the storefront is told
 * (features.humanHandoff) follows the normalised value.
 */
import { describe, it, expect } from "vitest";

describe("★ the talk-to-a-person button is opt-in", () => {
  it("website widget: off by default, unset is off, a stored true or false is kept", async () => {
    const { defaultWebchatConfig, normalizeWebchatConfig, publicWebchatConfig } = await import("../lib/webchat-widget");
    expect(defaultWebchatConfig().behaviour.allowHumanHandoff).toBe(false);
    expect(normalizeWebchatConfig({ v: 2 }).behaviour.allowHumanHandoff).toBe(false);
    expect(normalizeWebchatConfig({ v: 2, behaviour: {} }).behaviour.allowHumanHandoff).toBe(false);
    expect(normalizeWebchatConfig({ v: 2, behaviour: { allowHumanHandoff: true } }).behaviour.allowHumanHandoff).toBe(true);
    expect(normalizeWebchatConfig({ v: 2, behaviour: { allowHumanHandoff: false } }).behaviour.allowHumanHandoff).toBe(false);
    expect(publicWebchatConfig(normalizeWebchatConfig({ v: 2 }), { offline: false } as any).features.humanHandoff).toBe(false);
    expect(publicWebchatConfig(normalizeWebchatConfig({ v: 2, behaviour: { allowHumanHandoff: true } }), { offline: false } as any).features.humanHandoff).toBe(true);
  });
  it("a save that does not touch it keeps what is stored", async () => {
    const { normalizeWebchatConfig } = await import("../lib/webchat-widget");
    const on = normalizeWebchatConfig({ v: 2, behaviour: { allowHumanHandoff: true } });
    expect(normalizeWebchatConfig({ v: 2, appearance: { primaryColor: "#000000" } }, on).behaviour.allowHumanHandoff).toBe(true);
  });
  it("Shopify Live Chat: off by default, unset is off, a stored true is kept", async () => {
    const { defaultShopifyLiveChatConfig, normalizeShopifyLiveChatConfig } = await import("../lib/shopify-live-chat");
    expect(defaultShopifyLiveChatConfig().routing.allowHumanHandoff).toBe(false);
    expect(normalizeShopifyLiveChatConfig({}).routing.allowHumanHandoff).toBe(false);
    expect(normalizeShopifyLiveChatConfig({ routing: {} }).routing.allowHumanHandoff).toBe(false);
    expect(normalizeShopifyLiveChatConfig({ routing: { allowHumanHandoff: true } }).routing.allowHumanHandoff).toBe(true);
  });
});
