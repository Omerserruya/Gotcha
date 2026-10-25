/**
 * The website widget opens in the business's language (2026-10-25, Omer's
 * decision): a Hebrew shop whose theme leaves <html lang="en-US"> opened its
 * widget in English. Through the real bootstrap route. Pinned:
 *   - language "auto": the bootstrap names the tenant's defaultLocale, so both
 *     bundles (which honour a named language over the page's) open in it;
 *   - a language the merchant chose wins over the business's;
 *   - the tenant unreadable: English, as before, and the widget still draws.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ accounts: [] as any[], tenant: null as any, tenantFails: false }));

vi.mock("express-rate-limit", () => ({ default: () => (_q: any, _r: any, n: any) => n() }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const match = (r: any, w: any) => Object.entries(w ?? {}).every(([k, v]: [string, any]) =>
    v && typeof v === "object" && "in" in v ? v.in.includes(r[k]) : r[k] === v);
  return {
    ...actual,
    withCrossTenantAccess: (fn: any) => fn(),
    readDurableSetting: async () => null,
    getRedis: () => ({ get: async () => null, set: async () => "OK" }),
    prisma: {
      channelAccount: {
        findFirst: async (a: any) => H.accounts.find((r) => match(r, a.where)) ?? null,
        findMany: async (a: any) => H.accounts.filter((r) => match(r, a.where)),
        update: async () => ({}),
      },
      chatbotFlow: { findMany: async () => [] },
      aIAgent: { findFirst: async () => null },
      flowCanvas: { findUnique: async () => null },
      whatsAppNumber: { findMany: async () => [] },
      businessProfile: { findUnique: async () => null },
      tenant: {
        findUnique: async () => {
          if (H.tenantFails) throw new Error("db down");
          return H.tenant;
        },
      },
      shopifyChatInstallation: { findMany: async () => [] },
      $executeRaw: async () => 1,
    },
  };
});

import chat from "../routes/embedded-chat";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/embedded-chat", chat); return a; };
const web = (language?: string) => ({
  id: "ca_web", tenantId: "T", channel: "WEBCHAT", externalId: "widget-1", connectionStatus: "CONNECTED", platformMeta: null, lastHealthCheck: new Date(),
  credentials: { v: 2, ...(language ? { appearance: { language } } : {}) },
});
const boot = async () => (await request(app()).post("/api/embedded-chat/bootstrap").send({ widgetId: "widget-1" })).body.data.widget;

beforeEach(() => {
  H.tenant = { name: "Noa", defaultLocale: "he" };
  H.tenantFails = false;
});

describe("★ the widget opens in the business's language", () => {
  it.each([undefined, "auto"])("language %s and a Hebrew business: he", async (language) => {
    H.accounts = [web(language)];
    expect((await boot()).appearance.language).toBe("he");
  });

  it.each([["en", "en"], ["he-IL", "he"], [null, "en"]])("defaultLocale %s: %s", async (defaultLocale, want) => {
    H.tenant = { name: "Shop", defaultLocale };
    H.accounts = [web("auto")];
    expect((await boot()).appearance.language).toBe(want);
  });

  it("the merchant's own choice wins over the business's", async () => {
    H.accounts = [web("en")];
    expect((await boot()).appearance.language).toBe("en");
  });

  it("the tenant unreadable: English, and the widget still draws", async () => {
    H.tenantFails = true;
    H.accounts = [web("auto")];
    const w = await boot();
    expect(w).toBeTruthy();
    expect(w.appearance.language).toBe("en");
  });
});
