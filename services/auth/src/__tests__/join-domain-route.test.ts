/**
 * GET/PUT /api/tenant/security/join-domain (2026-11-22).
 *
 * The screen's contract: a bare body (no envelope), an admin only, and a
 * domain that is never typed: it is the asking admin's own address, read from
 * their membership in this organization.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  user: { userId: "u_dana", role: "ADMIN", tenantId: "T1", email: "dana@acme-flowers.co.il" } as any,
  me: { id: "u_dana", email: "dana@acme-flowers.co.il" } as any,
  guards: [] as any[],
  lookups: [] as any[],
  views: [] as any[],
  sets: [] as any[],
  view: { domain: "acme-flowers.co.il", joinByDomain: false, publicDomain: false, activeDomain: null } as any,
  result: null as any,
  setThrows: false,
}));

vi.mock("@chatcenter/shared", () => ({
  authenticate: (req: any, _res: any, next: any) => { req.user = { ...H.user }; next(); },
  resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = "T1"; next(); },
  requirePermissionOrRole: (permission: string, ...roles: string[]) => {
    H.guards.push([permission, ...roles]);
    return (req: any, res: any, next: any) => (roles.includes(req.user.role) ? next() : res.status(403).json({ error: "Insufficient permissions" }));
  },
  writeAudit: vi.fn(async () => undefined),
  AuditAction: {},
  mfaRequirementFor: () => ({ required: false }),
  getMfaEnrollmentMap: async () => new Map(),
  prisma: {
    user: { findFirst: async (q: any) => { H.lookups.push(q); return H.me; }, findMany: async () => [] },
  },
}));
vi.mock("../services/mfa-required-flag.service", () => ({ syncMfaRequiredFlagsForTenant: async () => undefined }));
vi.mock("../services/domain-join.service", () => ({
  joinDomainView: async (...a: any[]) => { H.views.push(a); return H.view; },
  setJoinDomain: async (...a: any[]) => {
    H.sets.push(a);
    if (H.setThrows) throw new Error("the setting was not removed");
    return H.result ?? { ok: true, view: { ...H.view, joinByDomain: a[2], activeDomain: a[2] ? H.view.domain : null } };
  },
}));

import router from "../routes/tenant-security";

const app = express();
app.use(express.json());
app.use("/api/tenant/security", router);
const URL = "/api/tenant/security/join-domain";

beforeEach(() => {
  H.user = { userId: "u_dana", role: "ADMIN", tenantId: "T1", email: "dana@acme-flowers.co.il" };
  H.me = { id: "u_dana", email: "dana@acme-flowers.co.il" };
  H.lookups = []; H.views = []; H.sets = [];
  H.view = { domain: "acme-flowers.co.il", joinByDomain: false, publicDomain: false, activeDomain: null };
  H.result = null; H.setThrows = false;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("who may open it", () => {
  it("both routes sit behind the workspace-settings guard, admin as the fallback", () => {
    const ours = H.guards.filter((g) => g[0] === "settings:workspace:update");
    expect(ours.length).toBeGreaterThanOrEqual(2);
    for (const g of ours) expect(g).toEqual(["settings:workspace:update", "ADMIN"]);
  });

  it.each([["AGENT"], ["MANAGER"]])("a %s is refused on both, and nothing is read or changed", async (role) => {
    H.user.role = role;
    expect((await request(app).get(URL)).status).toBe(403);
    expect((await request(app).put(URL).send({ joinByDomain: true })).status).toBe(403);
    expect(H.views).toEqual([]); expect(H.sets).toEqual([]); expect(H.lookups).toEqual([]);
  });

  it("an admin with no active membership here is refused", async () => {
    H.me = null;
    expect((await request(app).get(URL)).status).toBe(403);
    expect((await request(app).put(URL).send({ joinByDomain: true })).status).toBe(403);
    expect(H.views).toEqual([]); expect(H.sets).toEqual([]);
  });
});

describe("reading", () => {
  it("answers the bare view", async () => {
    const r = await request(app).get(URL);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ domain: "acme-flowers.co.il", joinByDomain: false, publicDomain: false, activeDomain: null });
  });

  it("the address is the membership's in THIS organization, not the token's", async () => {
    H.user.email = "support@platform.example";
    await request(app).get(URL);
    expect(H.lookups).toEqual([{ where: { id: "u_dana", tenantId: "T1", isActive: true }, select: { id: true, email: true } }]);
    expect(H.views).toEqual([["T1", "dana@acme-flowers.co.il"]]);
  });

  it("an address with no domain: 409 no_domain", async () => {
    H.view = null;
    const r = await request(app).get(URL);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "no_domain" });
  });
});

describe("switching", () => {
  it.each([[true], [false]])("joinByDomain %s: 200 with the same bare shape", async (on) => {
    const r = await request(app).put(URL).send({ joinByDomain: on });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ domain: "acme-flowers.co.il", joinByDomain: on, publicDomain: false, activeDomain: on ? "acme-flowers.co.il" : null });
    expect(H.sets).toHaveLength(1);
    expect(H.sets[0][0]).toBe("T1");
    expect(H.sets[0][1]).toMatchObject({ userId: "u_dana", email: "dana@acme-flowers.co.il" });
    expect(H.sets[0][2]).toBe(on);
  });

  it("a domain typed into the request is not used", async () => {
    H.user.email = "someone@else.example";
    await request(app).put(URL).send({ joinByDomain: true, domain: "victim-corp.com", email: "ceo@victim-corp.com" });
    expect(H.sets[0][1]).toMatchObject({ userId: "u_dana", email: "dana@acme-flowers.co.il" });
    expect(JSON.stringify(H.sets)).not.toContain("victim-corp");
    expect(JSON.stringify(H.sets)).not.toContain("else.example");
  });

  it.each([["public_domain"], ["domain_taken"], ["no_domain"]])("409 %s, as the screen expects it", async (error) => {
    H.result = { ok: false, status: 409, error };
    const r = await request(app).put(URL).send({ joinByDomain: true });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error });
  });

  it.each([
    [{}, "required"], [{ joinByDomain: null }, "required"], [{ joinByDomain: "true" }, "invalid"],
    [{ joinByDomain: 1 }, "invalid"], [{ joinByDomain: "on" }, "invalid"],
  ])("%j is not a switch: 400, nothing changed", async (body, why) => {
    const r = await request(app).put(URL).send(body);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "validation", fields: { joinByDomain: why } });
    expect(H.sets).toEqual([]);
  });

  it("a save that did not happen is a 500, never a 200", async () => {
    H.setThrows = true;
    const r = await request(app).put(URL).send({ joinByDomain: false });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "not_saved" });
  });
});
