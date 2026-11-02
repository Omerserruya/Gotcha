/**
 * The WhatsApp widget without a connected WhatsApp channel (Omer, 2026-11-02):
 * a number typed by hand, normalised, used when no connected number can take
 * the handoff; the connected one wins; a bad number is refused with its field.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ accounts: [] as any[], numbers: [] as any[] }));
vi.mock("@chatcenter/shared", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  prisma: {
    channelAccount: { findMany: async () => H.accounts },
    whatsAppNumber: { findMany: async () => H.numbers },
  },
}));

import { handoffTarget } from "../services/website-widget.service";
import { normalizeWhatsappPhone, normalizeWhatsapp, defaultShopifyChatUx, plainHandoffMessage } from "@chatcenter/shared";

const ux = (whatsapp: any) => ({ ...defaultShopifyChatUx(), whatsapp: normalizeWhatsapp(whatsapp) }) as any;
beforeEach(() => { H.accounts = []; H.numbers = []; });

describe("normalizeWhatsappPhone", () => {
  it("stores +<digits>; an Israeli local mobile becomes +972; 00 becomes +", () => {
    expect(normalizeWhatsappPhone("+972 52-123-4567")).toBe("+972521234567");
    expect(normalizeWhatsappPhone("052-1234567")).toBe("+972521234567");
    expect(normalizeWhatsappPhone("00972521234567")).toBe("+972521234567");
    expect(normalizeWhatsappPhone("(212) 555 0100")).toBe("+2125550100");
  });
  it("not a number: null", () => {
    for (const bad of ["abc", "123", "+12345678901234567", "", null, 52]) expect(normalizeWhatsappPhone(bad as any)).toBeNull();
  });
  it("the stored ux keeps the normalised number", () => {
    expect(normalizeWhatsapp({ enabled: true, phone: "052-1234567" }).phone).toBe("+972521234567");
    expect(normalizeWhatsapp({ enabled: true }).phone).toBeNull();
  });
});

describe("handoffTarget", () => {
  it("a typed number alone: wa.me to it, no channel behind it", async () => {
    expect(await handoffTarget("T", ux({ enabled: true, phone: "052-1234567" }))).toEqual({ channelAccountId: null, digits: "972521234567" });
  });
  it("a connected number wins over a typed one", async () => {
    H.accounts = [{ id: "wa1", displayName: "Shop", connectionStatus: "CONNECTED", isActive: true, platformMeta: {} }];
    H.numbers = [{ channelAccountId: "wa1", displayPhoneNumber: "+972 3-555-0000" }];
    expect(await handoffTarget("T", ux({ enabled: true, channelAccountId: "wa1", phone: "052-1234567" }))).toEqual({ channelAccountId: "wa1", digits: "97235550000" });
  });
  it("the chosen channel is disconnected: the typed number takes over", async () => {
    H.accounts = [{ id: "wa1", displayName: "Shop", connectionStatus: "DISCONNECTED", isActive: false, platformMeta: {} }];
    H.numbers = [{ channelAccountId: "wa1", displayPhoneNumber: "+97235550000" }];
    expect((await handoffTarget("T", ux({ enabled: true, channelAccountId: "wa1", phone: "052-1234567" })))?.channelAccountId).toBeNull();
  });
  it("off, or neither set: no target (the old shape still works)", async () => {
    expect(await handoffTarget("T", ux({ enabled: false, phone: "052-1234567" }))).toBeNull();
    expect(await handoffTarget("T", ux({ enabled: true }))).toBeNull();
  });
  it("the no-code opening line, in both languages", () => {
    expect(plainHandoffMessage("he")).toBe("היי, הגעתי מהאתר");
    expect(plainHandoffMessage("en")).not.toMatch(/\(/);
  });
});
