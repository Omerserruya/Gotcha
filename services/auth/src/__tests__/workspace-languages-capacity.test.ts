/**
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
import workspaceRouter from "../routes/workspace";

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
    findUnique: async () => hoistedState.profile,
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
vi.mock("../services/business-scan.service", () => ({ runProfileRescan: async () => ({ ok: false, reason: "no_domain" }) }));

// Static import, not `await import`. A top-level await compiles under vitest
// but `tsc` rejects it for this module target - the same shape as the type
// errors that reached a commit earlier today because a green suite was mistaken
// for a typecheck. `vi.mock` is hoisted, so the mocks above still apply.

const app = express();
app.use(express.json());
app.use("/api", workspaceRouter);

beforeEach(() => {
  stamps.calls = [];
  state.profile = { id: "bp1", organizationName: "Fixture", businessDescription: "Old description", address: "1 Old St", currency: "ILS", primaryLanguage: "he", updatedAt: new Date() };
  state.writes = [];
});

describe("languages capacity is honest", () => {
  it("★ REFUSES two languages instead of storing one and reporting success", async () => {
    const res = await request(app).patch("/api/workspace").send({ languages: ["he", "en"] });

    expect(res.status).toBe(422);
    expect(res.body.details).toEqual([
      { field: "languages", message: "languages accepts one entry today; additional entries would not be stored" },
    ]);
    // And nothing was written. The old behaviour wrote "he" and dropped "en".
    expect(state.writes).toEqual([]);
  });

  it("accepts one language and stores it", async () => {
    const res = await request(app).patch("/api/workspace").send({ languages: ["EN"] });

    expect(res.status).toBe(200);
    expect(state.writes).toHaveLength(1);
    // Normalised on the way in, as before.
    expect(state.writes[0]!.data.primaryLanguage).toBe("en");
  });

  it("accepts an empty list as clearing the language", async () => {
    const res = await request(app).patch("/api/workspace").send({ languages: [] });

    expect(res.status).toBe(200);
    // A legitimate "I do not want to state a language", distinct from refusing.
    expect(state.writes[0]!.data.primaryLanguage).toBeNull();
  });

  it("keeps the ARRAY shape in the response, so a second column changes no client", async () => {
    const res = await request(app).get("/api/workspace");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.languages)).toBe(true);
    expect(res.body.data.languages).toEqual(["he"]);
  });

  it("still rejects a non-array and a non-string entry", async () => {
    const notArray = await request(app).patch("/api/workspace").send({ languages: "he" });
    expect(notArray.status).toBe(422);

    const notStrings = await request(app).patch("/api/workspace").send({ languages: [7] });
    expect(notStrings.status).toBe(422);

    expect(state.writes).toEqual([]);
  });
});

/**
 * A no-op write must not claim a human edited the field.
 *
 * Found because the frontend's ETag-conflict capture PATCHes the description
 * back UNCHANGED, on purpose, to move `updatedAt` so a conflict is real and
 * photographable - and that stamped provenance on every capture run. The same
 * thing happens to any person who opens the screen and presses Save without
 * editing: every field would be marked theirs, and a rescan would then only ever
 * OFFER those fields rather than refreshing them.
 *
 * The write itself stays unconditional. Moving `updatedAt` by re-writing a value
 * is a legitimate thing for a caller to do; claiming a human authored it is not.
 */
describe("the stamp means a human CHANGED the value, not submitted it", () => {
  it("★ does not stamp a field written back with its own current value", async () => {
    const res = await request(app).patch("/api/workspace").send({ description: "Old description" });

    expect(res.status).toBe(200);
    // The write still happened - that is how a caller moves updatedAt.
    expect(state.writes).toHaveLength(1);
    // But nothing was claimed.
    expect(stamps.calls.flat()).toEqual([]);
  });

  it("stamps only the field that actually changed", async () => {
    const res = await request(app)
      .patch("/api/workspace")
      .send({ description: "Old description", name: "A New Name" });

    expect(res.status).toBe(200);
    expect(stamps.calls.flat()).toEqual(["organizationName"]);
  });

  it("stamps a field whose stored value is null and is now set", async () => {
    state.profile = { ...state.profile, address: null };

    await request(app).patch("/api/workspace").send({ address: "1 Example St" });

    expect(stamps.calls.flat()).toEqual(["address"]);
  });

  it("does not stamp clearing a field that is already null", async () => {
    state.profile = { ...state.profile, address: null };

    await request(app).patch("/api/workspace").send({ address: null });

    expect(stamps.calls.flat()).toEqual([]);
  });
});
