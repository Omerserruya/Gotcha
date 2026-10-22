/**
 * ★ Text this service writes (intent labels) is in the READER's language:
 *   - an explicit ?locale= wins
 *   - otherwise the user's interface language, then the workspace's
 *   - never Accept-Language: the v2 app calls from its server, and a Hebrew
 *     screen got English labels ("Returns and exchanges")
 * Through the real route.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ calls: [] as any[], userLocale: null as string | null, tenantLocale: "he", resolveThrows: false }));

vi.mock("@chatcenter/shared", () => ({
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
  requireRole: () => (_q: any, _s: any, n: any) => n(),
  requirePermission: () => (_q: any, _s: any, n: any) => n(),
  resolveEffectiveLocale: async (a: any) => {
    H.calls.push(["resolve", a]);
    if (H.resolveThrows) throw new Error("db down");
    return { effective: H.userLocale ?? H.tenantLocale, tenantDefault: H.tenantLocale, userOverride: H.userLocale };
  },
}));
vi.mock("../services/analytics.service", () => ({
  getTopQuestions: async (_t: string, _f: any, _to: any, _l: any, locale: string) => { H.calls.push(["top", locale]); return []; },
}));

import router from "../routes/analytics";
const app = express();
app.use("/api/analytics", router);
const localeSent = async (q = "", headers: Record<string, string> = {}) => {
  H.calls = [];
  await request(app).get(`/api/analytics/top-questions${q}`).set(headers);
  return H.calls.find((c) => c[0] === "top")?.[1];
};

beforeEach(() => { H.userLocale = null; H.tenantLocale = "he"; H.resolveThrows = false; });

describe("★ the reader's language", () => {
  it("no locale from a server-side caller: the workspace's Hebrew, not English", async () => {
    expect(await localeSent("", { "Accept-Language": "en-US,en;q=0.9" })).toBe("he");
    expect(H.calls.find((c) => c[0] === "resolve")?.[1]).toEqual({ tenantId: "T", userId: "u1" });
  });

  it("the user's interface language before the workspace's", async () => {
    H.userLocale = "en";
    expect(await localeSent()).toBe("en");
    H.userLocale = "he-IL"; H.tenantLocale = "en";
    expect(await localeSent()).toBe("he");
  });

  it("★ one deliberate Accept-Language tag (the page's language, from the v2 app) wins over the saved one", async () => {
    H.tenantLocale = "en";
    expect(await localeSent("", { "Accept-Language": "he" })).toBe("he");
    expect(await localeSent("", { "Accept-Language": "he-IL" })).toBe("he");
    expect(await localeSent("?locale=en", { "Accept-Language": "he" })).toBe("en");
    expect(await localeSent("", { "Accept-Language": "english" })).toBe("en");
    expect(await localeSent("", { "Accept-Language": "hebrew" })).toBe("en");
  });

  it("an explicit ?locale= wins", async () => {
    expect(await localeSent("?locale=en")).toBe("en");
    expect(await localeSent("?locale=xx")).toBe("he");
  });

  it("nothing resolvable: English, never a failed request", async () => {
    H.resolveThrows = true;
    expect(await localeSent()).toBe("en");
  });
});
