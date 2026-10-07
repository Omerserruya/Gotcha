/**
 * ★ Private contacts per WhatsApp number (/api/channels/whatsapp/exclusions):
 *   - the same contact on two numbers is two rules; adding it on number B
 *     never moves number A's rule (it used to: the key had no number)
 *   - re-adding on the same number updates the note (200), not a duplicate
 *   - a new rule needs a number of this workspace (400 / 404)
 *   - GET ?channelAccountId= lists that number's rules plus the legacy
 *     "every number" rules; without it, all
 *   - two adds at once: the loser of the unique index becomes an update
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const S = vi.hoisted(() => ({ rows: [] as any[], accounts: [] as any[], seq: 0, raceOnce: false }));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  const match = (r: any, w: any): boolean => Object.entries(w).every(([k, v]: [string, any]) =>
    k === "OR" ? v.some((x: any) => match(r, x)) : (r[k] ?? null) === v);
  const sameKey = (a: any, b: any) => a.tenantId === b.tenantId && a.channel === b.channel && a.customerExternalId === b.customerExternalId
    && (a.channelAccountId ?? null) === (b.channelAccountId ?? null);
  return {
    ...actual,
    prisma: {
      channelAccount: { findFirst: async (a: any) => S.accounts.find((x) => match(x, a.where)) ?? null },
      inboundExclusion: {
        findMany: async (a: any) => S.rows.filter((r) => match(r, a.where)),
        findFirst: async (a: any) => S.rows.find((r) => match(r, a.where)) ?? null,
        create: async (a: any) => {
          if (S.raceOnce) {
            // Another request inserted the same key a moment earlier.
            S.raceOnce = false;
            S.rows.push({ id: `ex_${++S.seq}`, ...a.data, note: "first" });
          }
          if (S.rows.some((r) => sameKey(r, a.data))) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
          const r = { id: `ex_${++S.seq}`, createdAt: new Date(S.seq), ...a.data };
          S.rows.push(r);
          return r;
        },
        update: async (a: any) => { const r = S.rows.find((x) => x.id === a.where.id); Object.assign(r, a.data); return r; },
        deleteMany: async (a: any) => { const n = S.rows.length; S.rows = S.rows.filter((r) => !match(r, a.where)); return { count: n - S.rows.length }; },
      },
    },
    authenticate: (req: any, _r: any, next: any) => { req.user = { userId: "user_1" }; next(); },
    resolveTenant: (req: any, _r: any, next: any) => { req.tenantId = req.headers["x-test-tenant"] || "T"; next(); },
    requirePermission: () => (_q: any, _r: any, next: any) => next(),
    requireCapacity: () => (_q: any, _r: any, next: any) => next(),
  };
});

import whatsappRouter from "../routes/whatsapp-numbers";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/channels/whatsapp", whatsappRouter); return a; };
const add = (body: any, tenant = "T") => request(app()).post("/api/channels/whatsapp/exclusions").set("x-test-tenant", tenant).send(body);
const list = (q = "") => request(app()).get(`/api/channels/whatsapp/exclusions${q}`);

beforeEach(() => {
  S.seq = 0; S.raceOnce = false;
  S.accounts = [
    { id: "num_a", tenantId: "T", channel: "WHATSAPP" },
    { id: "num_b", tenantId: "T", channel: "WHATSAPP" },
    { id: "num_x", tenantId: "OTHER", channel: "WHATSAPP" },
  ];
  // A legacy rule from before numbers: applies to every number.
  S.rows = [{ id: "legacy", tenantId: "T", channel: "WHATSAPP", channelAccountId: null, customerExternalId: "972500000001", displayValue: "+972 50-000-0001", note: "old", createdAt: new Date(0) }];
});

describe("★ one rule per number", () => {
  it("the same contact on two numbers is two rules; neither moves", async () => {
    expect((await add({ value: "+972 52 111 2222", channelAccountId: "num_a", note: "family" })).status).toBe(201);
    expect((await add({ value: "+972 52 111 2222", channelAccountId: "num_b", note: "friend" })).status).toBe(201);
    const mine = S.rows.filter((r) => r.customerExternalId === "972521112222");
    expect(mine.map((r) => [r.channelAccountId, r.note]).sort()).toEqual([["num_a", "family"], ["num_b", "friend"]]);
  });

  it("re-adding on the same number updates the note (200), no duplicate", async () => {
    await add({ value: "0521112222", channelAccountId: "num_a", note: "v1" });
    const again = await add({ value: "0521112222", channelAccountId: "num_a", note: "v2" });
    expect(again.status).toBe(200);
    const rows = S.rows.filter((r) => r.channelAccountId === "num_a");
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("v2");
  });

  it("a new rule needs a number, and one of this workspace", async () => {
    const none = await add({ value: "0521112222" });
    expect(none.status).toBe(400);
    expect(none.body.error).toBe("channel_account_required");
    expect((await add({ value: "0521112222", channelAccountId: "num_x" })).status).toBe(404);
    expect(S.rows).toHaveLength(1);
  });

  it("two adds at once: the second becomes an update, never a 500", async () => {
    S.raceOnce = true;
    const r = await add({ value: "0521112222", channelAccountId: "num_a", note: "second" });
    expect(r.status).toBe(200);
    const rows = S.rows.filter((x) => x.channelAccountId === "num_a");
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("second");
  });
});

describe("★ listing per number", () => {
  it("?channelAccountId= shows that number's rules and the legacy every-number ones, not another number's", async () => {
    await add({ value: "0521112222", channelAccountId: "num_a" });
    await add({ value: "0533334444", channelAccountId: "num_b" });
    const a = (await list("?channelAccountId=num_a")).body.data.map((r: any) => r.normalized).sort();
    expect(a).toEqual(["0521112222", "972500000001"]);
    expect((await list("?channelAccountId=num_a")).body.data.find((r: any) => r.normalized === "972500000001").channelAccountId).toBeNull();
    expect((await list()).body.data).toHaveLength(3);
  });
});
