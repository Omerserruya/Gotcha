/**
 * Website, industry and country are editable through PATCH /api/workspace
 * (2026-10-11), with the same validation and If-Match - and saving a website
 * never starts a re-scan. Harness copied from workspace-languages-capacity.
 *
 * (Original header follows.)
 * The endpoint must not say yes to something it will not do.
 *
 * `PATCH /api/workspace` validated `languages` up to six entries and the writer
 * kept `languages[0]`. The response is a re-read, so two languages in came back
 * as one language out with a 200: a merchant adding English beside Hebrew was
 * told it worked and lost English. Visible only to a caller that diffed the
 * response against what it sent, and invisible to anything that did the normal
 * thing and trusted the success.
 *
 * The ARRAY SHAPE is deliberate and is not the defect - it is the contract for
 * when a second column exists. What was wrong was the promise. So the shape
 * stays forward-compatible and the capacity is honest.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import workspaceRouter, { normalizeWebsite } from "../routes/workspace";

// vi.hoisted, because `vi.mock` is lifted above every top-level const and its
// factory would otherwise reference these before initialization - which is
// exactly how this file first collected zero tests.
const hoistedState = vi.hoisted(() => ({
  profile: null as any,
  /** Every write the route attempted, so a refusal can be shown to write nothing. */
  writes: [] as Array<{ model: string; data: any }>,
}));
const state = hoistedState;

const prismaMock = vi.hoisted(() => ({
  businessProfile: {
    // Honours `select`, as the real client does: a route that forgets to
    // select a column must not still see it here.
    findUnique: async (a: any) => {
      const p = hoistedState.profile;
      if (!p || !a?.select) return p;
      return Object.fromEntries(Object.keys(a.select).filter((k) => a.select[k]).map((k) => [k, p[k]]));
    },
    update: async ({ data }: any) => {
      hoistedState.writes.push({ model: "businessProfile", data });
      return { ...hoistedState.profile, ...data };
    },
  },
  tenant: { findUnique: async () => ({ name: "Fixture Workspace" }) },
}));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: prismaMock,
    // Pass-through gates: this suite is about the route's own validation, not
    // about auth, which has its own tests.
    authenticate: (_req: any, _res: any, next: any) => next(),
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = "t1"; next(); },
    requireOnboardingOrActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
    readDurableSetting: async () => null,
    writeDurableSetting: async () => undefined,
  };
});

// Provenance is stamped by the same handler; stubbed so the assertions here are
// about the language capacity and nothing else.
const stamps = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("../services/field-provenance.service", () => ({
  readProvenance: async () => ({}),
  fieldSources: () => ({}),
  stampProvenance: async (_t: string, fields: string[]) => { stamps.calls.push(fields); },
}));
const rescans = vi.hoisted(() => ({ n: 0 }));
vi.mock("../services/business-scan.service", () => ({ runProfileRescan: async () => { rescans.n++; return { ok: false, reason: "no_domain" }; }, acceptScanProposal: async () => ({}) }));

// Static import, not `await import`. A top-level await compiles under vitest
// but `tsc` rejects it for this module target - the same shape as the type
// errors that reached a commit earlier today because a green suite was mistaken
// for a typecheck. `vi.mock` is hoisted, so the mocks above still apply.

const app = express();
app.use(express.json());
app.use("/api", workspaceRouter);

const UPDATED = new Date("2026-10-11T10:00:00.000Z");
beforeEach(() => {
  stamps.calls = []; rescans.n = 0;
  state.profile = { id: "bp1", organizationName: "Fixture", businessDescription: "d", address: null, currency: "ILS", primaryLanguage: "he",
    websiteDomain: "https://old.example.com", industry: "ecommerce", country: "IL", updatedAt: UPDATED };
  state.writes = [];
});

const patch = (body: Record<string, unknown>, ifMatch?: string) => {
  const r = request(app).patch("/api/workspace").send(body);
  return ifMatch ? r.set("If-Match", ifMatch) : r;
};

describe("website, industry, country", () => {
  it("are saved, normalised, stamped as a person's - and no re-scan starts", async () => {
    const r = await patch({ website: "  WWW.Shop.Example.com/about?x=1 ", industry: "Furniture", country: "us" });
    expect(r.status).toBe(200);
    expect(state.writes).toEqual([{ model: "businessProfile", data: { websiteDomain: "https://www.shop.example.com", industry: "Furniture", country: "US" } }]);
    expect(stamps.calls[0]).toEqual(["websiteDomain", "industry", "country"]);
    expect(rescans.n).toBe(0);
  });

  it("a website and a country can be cleared; the industry cannot (it is required)", async () => {
    expect((await patch({ website: null, country: null })).status).toBe(200);
    expect(state.writes[0].data).toEqual({ websiteDomain: null, country: null });
    expect((await patch({ industry: "" })).status).toBe(422);
  });

  it("refused with 422 and nothing written: a non-http website, a bad country, an over-long industry", async () => {
    for (const body of [{ website: "ftp://example.com" }, { website: "not a site" }, { website: "https://user:pw@example.com" }, { country: "USA" }, { country: 7 }, { industry: "x".repeat(121) }]) {
      const r = await patch(body);
      expect(r.status, JSON.stringify(body)).toBe(422);
    }
    expect(state.writes).toHaveLength(0);
  });

  it("the same If-Match as every other field: a stale write is 409, nothing written", async () => {
    const r = await patch({ industry: "Furniture" }, "2020-01-01T00:00:00.000Z");
    expect(r.status).toBe(409);
    expect(state.writes).toHaveLength(0);
    expect((await patch({ industry: "Furniture" }, UPDATED.toISOString())).status).toBe(200);
  });

  it("an unchanged value is written but not stamped as a person's edit", async () => {
    await patch({ industry: "ecommerce", country: "IL" });
    expect(stamps.calls[0]).toEqual([]);
  });
});

describe("normalizeWebsite", () => {
  it("the origin, the way onboarding stores it", () => {
    expect(normalizeWebsite("example.com")).toBe("https://example.com");
    expect(normalizeWebsite("http://Example.com:8080/x")).toBe("http://example.com:8080");
    expect(normalizeWebsite("javascript:alert(1)")).toBeNull();
    expect(normalizeWebsite("localhost")).toBeNull();
  });
});
