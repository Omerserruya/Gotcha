/**
 * ★ The 6-hourly channel check stores a WhatsApp number's own details
 * (2026-10-09: the channels screen named "Demo WhatsApp" but could never show
 * its phone number; it was fetched at connect and dropped).
 *   - a valid WhatsApp token: one GET of the number (display_phone_number,
 *     verified_name, quality_rating) with the account's own token, merged into
 *     platformMeta without erasing what is there
 *   - that read failing changes nothing else: still CONNECTED, no error
 *   - Messenger and Instagram accounts are not read for a number
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => {
  process.env.META_APP_ID = "app";
  process.env.META_APP_SECRET = "secret";
  return { accounts: [] as any[], updates: [] as any[], gets: [] as any[], numberFails: false };
});

vi.mock("axios", () => ({
  default: {
    get: async (url: string, opts: any) => {
      H.gets.push({ url, opts });
      if (url.endsWith("/debug_token")) return { data: { data: { is_valid: true, expires_at: 0 } } };
      if (H.numberFails) throw Object.assign(new Error("boom"), { response: { data: { error: { message: "unsupported" } } } });
      return { data: { id: "1010938148762991", display_phone_number: "+972 52-540-1686", verified_name: "GOTCHA Demo", quality_rating: "GREEN" } };
    },
    post: async () => ({ data: {} }),
  },
}));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    decryptCredentials: () => { throw new Error("not encrypted in this test"); },
    prisma: {
      channelAccount: {
        findMany: async () => H.accounts,
        update: async (a: any) => { H.updates.push(a); return {}; },
      },
    },
  };
});

import { runHealthCheck } from "../workers/channel-health.worker";

const wa = (o: any = {}) => ({ id: "ca_wa", tenantId: "T", channel: "WHATSAPP", externalId: "1010938148762991", isActive: true, connectionStatus: "CONNECTED", credentials: { accessToken: "tok_wa" }, platformMeta: { wabaId: "waba_1", historyImport: "done" }, ...o });

beforeEach(() => { H.accounts = []; H.updates = []; H.gets = []; H.numberFails = false; });

describe("★ the WhatsApp number is stored by the channel check", () => {
  it("valid token: the number's details merged into platformMeta, read with the account's own token", async () => {
    H.accounts = [wa()];
    await runHealthCheck();
    const numberRead = H.gets.find((g) => g.url.endsWith("/1010938148762991"));
    expect(numberRead.opts).toMatchObject({ params: { fields: "display_phone_number,verified_name,quality_rating" }, headers: { Authorization: "Bearer tok_wa" } });
    expect(H.updates).toHaveLength(1);
    expect(H.updates[0].data).toMatchObject({
      connectionStatus: "CONNECTED", lastError: null,
      platformMeta: { wabaId: "waba_1", historyImport: "done", displayPhoneNumber: "+972 52-540-1686", verifiedName: "GOTCHA Demo", qualityRating: "GREEN" },
    });
  });

  it("an account with no platformMeta yet (the legacy dev account) gets one", async () => {
    H.accounts = [wa({ platformMeta: null })];
    await runHealthCheck();
    expect(H.updates[0].data.platformMeta).toEqual({ displayPhoneNumber: "+972 52-540-1686", verifiedName: "GOTCHA Demo", qualityRating: "GREEN" });
  });

  it("the number read failing changes nothing else", async () => {
    H.accounts = [wa()];
    H.numberFails = true;
    await runHealthCheck();
    expect(H.updates[0].data).toMatchObject({ connectionStatus: "CONNECTED", lastError: null });
    expect(H.updates[0].data).not.toHaveProperty("platformMeta");
  });

  it("Messenger is not read for a number", async () => {
    H.accounts = [wa({ id: "ca_m", channel: "MESSENGER", externalId: "page_1" })];
    await runHealthCheck();
    expect(H.gets.filter((g) => !g.url.endsWith("/debug_token"))).toEqual([]);
    expect(H.updates[0].data).not.toHaveProperty("platformMeta");
  });
});
