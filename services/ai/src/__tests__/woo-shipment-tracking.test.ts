/**
 * get_shipment_tracking is offered only where the Shipment Tracking extension
 * was seen on the store (cached per store, probed in the background).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const R = vi.hoisted(() => ({ kv: new Map<string, string>(), down: false }));
vi.mock("@chatcenter/shared", () => ({
  assertPublicUrl: vi.fn(async () => undefined),
  getRedis: () => {
    if (R.down) throw new Error("redis down");
    return {
      get: async (k: string) => R.kv.get(k) ?? null,
      set: async (k: string, v: string) => { R.kv.set(k, v); return "OK"; },
    };
  },
}));

import { shipmentTrackingVisible, probeShipmentTracking } from "../services/connectors/woo-shipment-tracking";

const STORE = "https://shop.example.com/";
const KEY = "woo:shipment-tracking:https://shop.example.com";
const answer = (status: number) => vi.fn(async () => ({ status }) as any);
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { R.kv.clear(); R.down = false; });
afterEach(() => vi.unstubAllGlobals());

describe("shipmentTrackingVisible", () => {
  it("★ an unknown store: hidden this turn, probed once in the background, shown once seen", async () => {
    const f = answer(200);
    vi.stubGlobal("fetch", f);
    expect(await shipmentTrackingVisible(STORE)).toBe(false);
    expect(await shipmentTrackingVisible(STORE)).toBe(false);
    await settle();
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as any[])[0]).toBe("https://shop.example.com/wp-json/wc-shipment-tracking/v3");
    expect(R.kv.get(KEY)).toBe("1");
    expect(await shipmentTrackingVisible(STORE)).toBe(true);
  });

  it("★ a store without the extension (404): stays hidden, no further probes", async () => {
    const f = answer(404);
    vi.stubGlobal("fetch", f);
    await shipmentTrackingVisible(STORE);
    await settle();
    expect(R.kv.get(KEY)).toBe("0");
    expect(await shipmentTrackingVisible(STORE)).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a store that did not answer (500, timeout) is not a verdict: nothing cached", async () => {
    vi.stubGlobal("fetch", answer(503));
    expect(await probeShipmentTracking(STORE)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("timeout"); }));
    expect(await probeShipmentTracking(STORE)).toBeNull();
    expect(R.kv.size).toBe(0);
  });

  it("Redis unreachable or no store address: hidden, never throws", async () => {
    vi.stubGlobal("fetch", answer(200));
    R.down = true;
    expect(await shipmentTrackingVisible(STORE)).toBe(false);
    expect(await shipmentTrackingVisible("")).toBe(false);
  });
});
