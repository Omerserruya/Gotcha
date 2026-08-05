import { describe, it, expect, afterEach, vi } from "vitest";
import { withAdapterTimeout } from "../services/connectors/integration-framework";

afterEach(() => {
  vi.useRealTimers();
  delete process.env.ADAPTER_TIMEOUT_MS;
});

describe("adapter calls are bounded in time", () => {
  it("returns the result untouched when the adapter answers in time", async () => {
    await expect(withAdapterTimeout("shopify", "get_order", Promise.resolve({ id: 7 })))
      .resolves.toEqual({ id: 7 });
  });

  it("rejects with a NAMED timeout instead of hanging forever", async () => {
    process.env.ADAPTER_TIMEOUT_MS = "20";
    // A provider that never answers. Before this, the caller - a customer
    // conversation turn holding a worker - waited indefinitely.
    const hung = new Promise(() => {});
    await expect(withAdapterTimeout("shopify", "get_order", hung as Promise<unknown>))
      .rejects.toThrow(/adapter_timeout_after_20ms: shopify\.get_order/);
  });

  it("propagates a real adapter error unchanged - it must not look like a timeout", async () => {
    const boom = Promise.reject(new Error("shopify_403: missing write scope"));
    await expect(withAdapterTimeout("shopify", "process_refund", boom))
      .rejects.toThrow(/shopify_403/);
  });

  it("honours ADAPTER_TIMEOUT_MS and ignores a nonsensical value", async () => {
    process.env.ADAPTER_TIMEOUT_MS = "15";
    await expect(withAdapterTimeout("x", "y", new Promise(() => {}) as Promise<unknown>))
      .rejects.toThrow(/after_15ms/);

    // Garbage must fall back to the default rather than producing a 0ms or NaN
    // timeout that fires on every healthy call.
    process.env.ADAPTER_TIMEOUT_MS = "not-a-number";
    await expect(withAdapterTimeout("x", "y", Promise.resolve("ok"))).resolves.toBe("ok");
    process.env.ADAPTER_TIMEOUT_MS = "-5";
    await expect(withAdapterTimeout("x", "y", Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("clears its timer on success - otherwise every call keeps the loop alive", async () => {
    const clear = vi.spyOn(global, "clearTimeout");
    await withAdapterTimeout("hubspot", "get_contact", Promise.resolve(1));
    expect(clear).toHaveBeenCalled();
  });

  it("clears its timer on failure too", async () => {
    const clear = vi.spyOn(global, "clearTimeout");
    await withAdapterTimeout("hubspot", "get_contact", Promise.reject(new Error("nope")))
      .catch(() => {});
    expect(clear).toHaveBeenCalled();
  });
});
