/**
 * A shop's floor skips the two soft caps (Omer, 2026-10-26).
 *
 * A webchat shopper was handed to a person at "כמה?", 15.6 minutes into a
 * normal browse (dev conv cmvp9gs3s…): the 15-minute burst cap, then silence.
 * The 30-reply cap is the same wall a few turns later. On a shop's floor (an
 * employee that is not sales or booking, with a connected Woo or Shopify
 * store) neither fires. The hard ceiling (2 x the reply cap) still does, and
 * sales and booking keep both caps exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  aiReplies: 0,
  stores: 1,
  storeLookupThrows: false,
  storeLookups: 0,
  startedMinutesAgo: 0,
  contact: null as null | { email: string | null; phone: string | null },
}));

vi.mock("@chatcenter/shared", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  prisma: {
    message: {
      count: async () => H.aiReplies,
      // One message a minute from the start: no 30-minute gap, so one burst.
      findMany: async () => {
        const now = Date.now();
        const rows = [];
        for (let m = H.startedMinutesAgo; m >= 0; m--) rows.push({ createdAt: new Date(now - m * 60_000) });
        return rows.reverse().slice(0, 50).reverse();
      },
    },
    conversation: {
      findUnique: async () => ({ createdAt: new Date(Date.now() - H.startedMinutesAgo * 60_000), channel: "WEBCHAT", customerExternalId: "v1" }),
    },
    contact: { findFirst: async () => H.contact },
    tenantIntegration: {
      count: async (a: any) => {
        H.storeLookups++;
        if (H.storeLookupThrows) throw new Error("db down");
        expect(a.where).toEqual({ tenantId: "T", status: "CONNECTED", integration: { slug: { in: ["woocommerce", "shopify"] } } });
        return H.stores;
      },
    },
  },
}));

import { checkEscalationThresholds, isShopFloorAgent } from "../services/ai-bot.service";

const caps = (role: string) => ({ maxAutonomousMessages: 30, maxAutonomousMinutes: 15, role });
const check = (role: string, text = "כמה?") => checkEscalationThresholds("c1", "T", caps(role), text);

beforeEach(() => {
  H.aiReplies = 0; H.stores = 1; H.storeLookupThrows = false; H.storeLookups = 0; H.startedMinutesAgo = 0; H.contact = null;
});

describe("the time cap", () => {
  it("a shop floor: 16 minutes of browsing is not handed off (it was)", async () => {
    H.startedMinutesAgo = 16;
    expect(await check("customer_support")).toBeNull();
  });
  it("sales keeps it", async () => {
    H.startedMinutesAgo = 16;
    expect(await check("sales")).toBe("autonomous_time_cap");
  });
  it("booking keeps it", async () => {
    H.startedMinutesAgo = 16;
    expect(await check("booking")).toBe("autonomous_time_cap");
  });
  it("no connected store: not a shop floor, the cap stays", async () => {
    H.startedMinutesAgo = 16; H.stores = 0;
    expect(await check("customer_support")).toBe("autonomous_time_cap");
  });
  it("a failed store lookup keeps the cap (never fails open)", async () => {
    H.startedMinutesAgo = 16; H.storeLookupThrows = true;
    expect(await check("customer_support")).toBe("autonomous_time_cap");
  });
});

describe("the reply cap", () => {
  it("a shop floor: 30 replies is not handed off", async () => {
    H.aiReplies = 30;
    expect(await check("customer_support")).toBeNull();
  });
  it("sales and booking keep it", async () => {
    H.aiReplies = 30;
    expect(await check("sales")).toBe("autonomous_message_cap");
    expect(await check("booking")).toBe("autonomous_message_cap");
  });
});

describe("what stays for everyone", () => {
  it("the hard ceiling (60) hands off a shop floor too", async () => {
    H.aiReplies = 60;
    expect(await check("customer_support")).toBe("hard_message_ceiling");
  });
  it("an ordinary turn costs no store lookup", async () => {
    H.aiReplies = 5; H.startedMinutesAgo = 3;
    expect(await check("customer_support")).toBeNull();
    expect(H.storeLookups).toBe(0);
  });
  it("one lookup when both caps would fire", async () => {
    H.aiReplies = 30; H.startedMinutesAgo = 16;
    expect(await check("customer_support")).toBeNull();
    expect(H.storeLookups).toBe(1);
  });
});

describe("isShopFloorAgent", () => {
  it("not sales or booking, with a connected store", async () => {
    expect(await isShopFloorAgent("T", "customer_support")).toBe(true);
    expect(await isShopFloorAgent("T", "custom")).toBe(true);
    expect(await isShopFloorAgent("T", null)).toBe(true);
    expect(await isShopFloorAgent("T", "sales")).toBe(false);
    expect(await isShopFloorAgent("T", "booking")).toBe(false);
    H.stores = 0;
    expect(await isShopFloorAgent("T", "customer_support")).toBe(false);
  });
});
