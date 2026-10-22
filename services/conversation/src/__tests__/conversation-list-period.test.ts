/**
 * ★ The inbox's period filter (`GET /api/conversations?from=&to=`), the target
 * of the Home chat's "this week" links (docs/api/assistant-threads-v1.md §9.5):
 *   - the days are the WORKSPACE's (business-hours time zone): a conversation
 *     started at 22:30 UTC on 1 October is on 2 October in Jerusalem, exactly
 *     as the Home chat's chart counted it
 *   - `to` is inclusive; either end may be omitted
 *   - a malformed period is a 400, never "every conversation"
 *   - the caller's visibility clause stays the top-level OR beside it
 * Through the real router.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  viewer: { userId: "admin1", role: "ADMIN", departmentId: undefined as string | undefined },
  convs: [] as any[],
  wheres: [] as any[],
  tz: "Asia/Jerusalem" as string | null,
}));

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    if (k === "AND") return (v as any[]).every((w) => matches(row, w));
    if (k === "NOT") return !matches(row, v);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("not" in v) return row[k] !== v.not;
      if ("startsWith" in v) return String(row[k] ?? "").startsWith(v.startsWith);
      if ("gte" in v || "lt" in v) return (!v.gte || row[k] >= v.gte) && (!v.lt || row[k] < v.lt);
      return true;
    }
    return (row[k] ?? null) === v;
  });
}

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { ...H.viewer }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    withHistoricalRecords: (fn: any) => fn(),
    readDurableSetting: async (_t: string, key: string) =>
      key === "businessHours" && H.tz ? JSON.stringify({ timezone: H.tz, schedule: {} }) : null,
    prisma: {
      conversation: {
        findMany: async (a: any) => {
          H.wheres.push(a.where);
          return H.convs.filter((c) => matches(c, a.where)).map((c) => ({ ...c, messages: [] }));
        },
        count: async (a: any) => H.convs.filter((c) => matches(c, a.where)).length,
      },
      contact: { findMany: async () => [] },
    },
  };
});

import router from "../routes/conversations";

const app = express();
app.use(express.json());
app.use("/api/conversations", router);

const conv = (id: string, createdAt: string, o: any = {}) => ({
  id, tenantId: "T", status: "OPEN", channel: "WHATSAPP", handledBy: "human", isHandedOver: false, assignedAgentId: null,
  departmentId: null, customerExternalId: `9725${id}`, createdAt: new Date(createdAt), lastMessageAt: new Date(createdAt), ...o,
});
const ids = (res: any) => res.body.data.map((c: any) => c.id).sort();

beforeEach(() => {
  H.wheres = []; H.tz = "Asia/Jerusalem";
  H.viewer = { userId: "admin1", role: "ADMIN", departmentId: undefined };
  H.convs = [
    conv("a", "2026-09-30T20:59:00Z"), // 23:59 on 30 September in Jerusalem
    conv("b", "2026-09-30T21:00:00Z"), // 00:00 on 1 October in Jerusalem
    conv("c", "2026-10-01T22:30:00Z"), // 01:30 on 2 October
    conv("d", "2026-10-07T20:59:00Z"), // 23:59 on 7 October
    conv("e", "2026-10-07T21:00:00Z"), // 00:00 on 8 October
  ];
});

describe("★ the period is the workspace's days", () => {
  it("1 to 7 October in Jerusalem: from its midnight to the end of the 7th", async () => {
    const res = await request(app).get("/api/conversations?from=2026-10-01&to=2026-10-07");
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(["b", "c", "d"]);
  });

  it("one day: the conversation at 22:30 UTC on the 1st is on the 2nd", async () => {
    expect(ids(await request(app).get("/api/conversations?from=2026-10-02&to=2026-10-02"))).toEqual(["c"]);
    expect(ids(await request(app).get("/api/conversations?from=2026-10-01&to=2026-10-01"))).toEqual(["b"]);
  });

  it("either end may be omitted", async () => {
    expect(ids(await request(app).get("/api/conversations?from=2026-10-07"))).toEqual(["d", "e"]);
    expect(ids(await request(app).get("/api/conversations?to=2026-09-30"))).toEqual(["a"]);
  });

  it("no business hours set: UTC days", async () => {
    H.tz = null;
    expect(ids(await request(app).get("/api/conversations?from=2026-10-01&to=2026-10-01"))).toEqual(["c"]);
    expect(ids(await request(app).get("/api/conversations?from=2026-09-30&to=2026-09-30"))).toEqual(["a", "b"]);
  });

  it("no period: unchanged", async () => {
    expect(ids(await request(app).get("/api/conversations"))).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("★ the header's total is the whole match, not the page", () => {
  it("a page of 2 from a period of 3 still says 3 (keyset with total=1, and offset)", async () => {
    const k = await request(app).get("/api/conversations?from=2026-10-01&to=2026-10-07&includeAutomated=true&limit=2&cursor=&total=1");
    expect(k.body.data).toHaveLength(2);
    expect(k.body.viewTotal).toBe(3);
    const o = await request(app).get("/api/conversations?from=2026-10-01&to=2026-10-07&includeAutomated=true&limit=2");
    expect(o.body.viewTotal).toBe(3);
  });

  it("with a channel, the same filters as the rows", async () => {
    H.convs[2].channel = "WEBCHAT";
    const r = await request(app).get("/api/conversations?from=2026-10-01&to=2026-10-07&channel=WEBCHAT&includeAutomated=true&cursor=&total=1");
    expect(r.body.viewTotal).toBe(1);
  });

  it("a keyset page that does not ask pays no count (scrolling)", async () => {
    const r = await request(app).get("/api/conversations?from=2026-10-01&to=2026-10-07&includeAutomated=true&limit=2&cursor=");
    expect(r.body.viewTotal).toBeUndefined();
  });
});

describe("refused, never widened", () => {
  it.each([
    ["from=yesterday"],
    ["to=2026-10-32"],
    ["from=2026-02-30"],
    ["from=2026-10-07&to=2026-10-01"],
    ["from="],
  ])("%s is a 400", async (q) => {
    const res = await request(app).get(`/api/conversations?${q}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid_period/);
  });
});

describe("★ visibility stays beside it", () => {
  it("a department agent: the visibility OR is still top-level, the period inside AND", async () => {
    H.viewer = { userId: "u1", role: "AGENT", departmentId: "sales" };
    await request(app).get("/api/conversations?from=2026-10-01&to=2026-10-07&view=queue");
    const w = H.wheres[0];
    expect(Array.isArray(w.OR)).toBe(true);
    expect(w.AND.some((c: any) => c.createdAt?.gte instanceof Date && c.createdAt?.lt instanceof Date)).toBe(true);
  });
});
