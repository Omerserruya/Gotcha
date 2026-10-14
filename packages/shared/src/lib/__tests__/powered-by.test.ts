/**
 * ★ "Powered by GOTCHA" cannot be turned off (W8): whatever was stored
 * before, both widgets' normalisers read it as on, and both public configs
 * serve it on; an explicit off in a patch is recognised so writers can refuse it.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeWebchatConfig,
  publicWebchatConfig,
  readShopifyLiveChatConfig,
  asksToHidePoweredBy,
  effectivePoweredBy,
} from "../../index";

describe("★ always on", () => {
  it("a site widget stored off is read and served on", () => {
    const c = normalizeWebchatConfig({ v: 2, appearance: { showPoweredBy: false } });
    expect(c.appearance.showPoweredBy).toBe(true);
    expect(publicWebchatConfig({ ...c, appearance: { ...c.appearance, showPoweredBy: false } }, { offline: false }).appearance.showPoweredBy).toBe(true);
  });

  it("a Shopify chat stored off is read on", () => {
    expect(readShopifyLiveChatConfig({ shopifyLiveChat: { appearance: { showPoweredBy: false } } }).appearance.showPoweredBy).toBe(true);
  });

  it("an explicit off is recognised; anything else is not", () => {
    expect(asksToHidePoweredBy({ showPoweredBy: false })).toBe(true);
    for (const a of [{ showPoweredBy: true }, {}, null, undefined, { showPoweredBy: "false" }]) expect(asksToHidePoweredBy(a)).toBe(false);
    expect(effectivePoweredBy(false)).toBe(true);
  });
});
