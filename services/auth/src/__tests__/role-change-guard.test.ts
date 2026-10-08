/**
 * ★ Changing a role cannot lock the workspace out of itself (design 12).
 * Through the REAL routes, on the three that change who is an admin:
 *   PUT /users/:id/role, POST and DELETE /users/:id/roles/:roleId
 *   - the last admin cannot be demoted (409 LAST_ADMIN), by requireRole's
 *     rule: User.role ADMIN, or the latest assignment is owner/admin
 *   - the caller cannot remove their own admin (409 SELF_LOCKOUT)
 *   - a refused change writes nothing (rolled back)
 *   - User.role follows the assigned built-in: a legacy ADMIN "changed to
 *     Agent" is no longer an admin
 *   - another workspace's user is 404, and nothing is written
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const DB = vi.hoisted(() => ({ users: [] as any[], roles: [] as any[], assignments: [] as any[], audits: [] as any[], locks: [] as string[], actor: "a1", clock: 0 }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const roleOf = (id: string) => DB.roles.find((r) => r.id === id);
  const matchAssignment = (a: any, w: any) =>
    (!w.userId || a.userId === w.userId) && (!w.roleId || a.roleId === w.roleId) && (!w.role?.tenantId || roleOf(a.roleId)?.tenantId === w.role.tenantId);
  const withRole = (a: any) => (a ? { ...a, role: { builtinKey: roleOf(a.roleId)?.builtinKey ?? null } } : null);
  const matchUser = (u: any, w: any) =>
    (!w.id || u.id === w.id) && (!w.tenantId || u.tenantId === w.tenantId) && (w.isActive === undefined || u.isActive === w.isActive) && (!w.role?.not || u.role !== w.role.not);
  const client: any = {
    $executeRaw: async (strings: TemplateStringsArray, ...vals: any[]) => { DB.locks.push(String(vals[0])); return 1; },
    user: {
      findFirst: async (a: any) => DB.users.find((u) => matchUser(u, a.where)) ?? null,
      findMany: async (a: any) => DB.users.filter((u) => matchUser(u, a.where)),
      update: async (a: any) => { const u = DB.users.find((x) => x.id === a.where.id); Object.assign(u, a.data); return u; },
    },
    tenantRole: { findFirst: async (a: any) => DB.roles.find((r) => r.id === a.where.id && r.tenantId === a.where.tenantId) ?? null },
    userRoleAssignment: {
      findFirst: async (a: any) => withRole([...DB.assignments].filter((x) => matchAssignment(x, a.where)).sort((x, y) => y.assignedAt - x.assignedAt)[0]),
      deleteMany: async (a: any) => { const before = DB.assignments.length; DB.assignments = DB.assignments.filter((x) => !matchAssignment(x, a.where)); return { count: before - DB.assignments.length }; },
      create: async (a: any) => { const r = { ...a.data, assignedAt: ++DB.clock }; DB.assignments.push(r); return r; },
      upsert: async (a: any) => {
        const k = a.where.userId_roleId;
        const found = DB.assignments.find((x) => x.userId === k.userId && x.roleId === k.roleId);
        if (found) return found;
        const r = { ...a.create, assignedAt: ++DB.clock }; DB.assignments.push(r); return r;
      },
    },
  };
  // A transaction that rolls back when the callback throws.
  client.$transaction = async (fn: any) => {
    const snap = JSON.stringify({ users: DB.users, assignments: DB.assignments });
    try { return await fn(client); } catch (e) { const s = JSON.parse(snap); DB.users = s.users; DB.assignments = s.assignments; throw e; }
  };
  return {
    ...actual,
    prisma: client,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: DB.actor, role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    assertTenantId: (req: any) => req.tenantId,
    writeAudit: async (a: any) => { DB.audits.push(a); },
    invalidatePermissionsCache: () => {},
  };
});

import router from "../routes/permissions";

const app = express();
app.use(express.json());
app.use("/api/permissions", router);

const ROLES = [
  { id: "r_owner", tenantId: "T", builtinKey: "owner" }, { id: "r_admin", tenantId: "T", builtinKey: "admin" },
  { id: "r_agent", tenantId: "T", builtinKey: "agent" }, { id: "r_other_admin", tenantId: "OTHER", builtinKey: "admin" },
];
const user = (id: string, role = "AGENT", o: any = {}) => ({ id, tenantId: "T", role, isActive: true, ...o });
const isAdmin = (id: string) => {
  const u = DB.users.find((x) => x.id === id)!;
  const latest = [...DB.assignments].filter((a) => a.userId === id && DB.roles.find((r) => r.id === a.roleId)?.tenantId === "T").sort((a, b) => b.assignedAt - a.assignedAt)[0];
  const key = latest ? DB.roles.find((r) => r.id === latest.roleId)?.builtinKey : null;
  return u.role === "ADMIN" || key === "owner" || key === "admin";
};
const setRole = (userId: string, roleId: string) => request(app).put(`/api/permissions/users/${userId}/role`).send({ roleId });

beforeEach(() => {
  DB.roles = ROLES; DB.audits = []; DB.locks = []; DB.actor = "a1"; DB.clock = 10;
  DB.users = [user("a1", "ADMIN"), user("a2", "AGENT"), user("x1", "ADMIN", { tenantId: "OTHER" })];
  DB.assignments = [{ userId: "a1", roleId: "r_admin", assignedAt: 1 }, { userId: "a2", roleId: "r_agent", assignedAt: 2 }];
});

describe("★ the last admin", () => {
  it("cannot be demoted by another route either: PUT, POST (the latest assignment wins), DELETE", async () => {
    DB.actor = "sysop";
    for (const r of [
      await setRole("a1", "r_agent"),
      await request(app).post("/api/permissions/users/a1/roles/r_agent"),
    ]) {
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("LAST_ADMIN");
    }
    // The legacy enum alone keeps a1 an admin after removing the assignment, so DELETE needs an enum-less admin.
    DB.users[0].role = "AGENT";
    const del = await request(app).delete("/api/permissions/users/a1/roles/r_admin");
    expect(del.status).toBe(409);
    expect(del.body.code).toBe("LAST_ADMIN");
    // Nothing was written by any of them.
    expect(DB.assignments).toEqual([{ userId: "a1", roleId: "r_admin", assignedAt: 1 }, { userId: "a2", roleId: "r_agent", assignedAt: 2 }]);
    // Every change ran under the workspace's lock.
    expect(DB.locks.length).toBe(3);
    expect(new Set(DB.locks)).toEqual(new Set(["roles:T"]));
  });

  it("an inactive admin, or the platform's SYSTEM_ADMIN, is not the workspace's admin", async () => {
    DB.actor = "sysop";
    DB.users.push(user("gone", "ADMIN", { isActive: false }), user("plat", "SYSTEM_ADMIN"));
    // Even holding the workspace's admin role.
    DB.assignments.push({ userId: "plat", roleId: "r_admin", assignedAt: 3 });
    const r = await setRole("a1", "r_agent");
    expect(r.body.code).toBe("LAST_ADMIN");
  });

  it("can be demoted once another admin exists", async () => {
    DB.actor = "sysop";
    expect((await setRole("a2", "r_admin")).status).toBe(200);
    expect((await setRole("a1", "r_agent")).status).toBe(200);
    expect(isAdmin("a1")).toBe(false);
    expect(isAdmin("a2")).toBe(true);
  });
});

describe("★ the caller's own admin", () => {
  it("cannot be removed by the caller, even with another admin present", async () => {
    await setRole("a2", "r_admin");
    const r = await setRole("a1", "r_agent");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("SELF_LOCKOUT");
    expect(isAdmin("a1")).toBe(true);
    const post = await request(app).post("/api/permissions/users/a1/roles/r_agent");
    expect(post.body.code).toBe("SELF_LOCKOUT");
  });

  it("another admin can do it", async () => {
    await setRole("a2", "r_admin");
    DB.actor = "a2";
    expect((await setRole("a1", "r_agent")).status).toBe(200);
  });
});

describe("★ one truth: User.role follows the assigned built-in", () => {
  it("a legacy ADMIN changed to Agent is no longer an admin (the enum follows)", async () => {
    DB.users.push(user("legacy", "ADMIN"));
    DB.actor = "a1";
    const r = await setRole("legacy", "r_agent");
    expect(r.status).toBe(200);
    expect(DB.users.find((u) => u.id === "legacy")!.role).toBe("AGENT");
    expect(isAdmin("legacy")).toBe(false);
  });

  it("promoting sets the enum too; removing the only admin assignment drops it", async () => {
    await setRole("a2", "r_admin");
    expect(DB.users.find((u) => u.id === "a2")!.role).toBe("ADMIN");
    const r = await request(app).delete("/api/permissions/users/a2/roles/r_admin");
    expect(r.status).toBe(204);
    expect(DB.users.find((u) => u.id === "a2")!.role).toBe("AGENT");
    expect(isAdmin("a2")).toBe(false);
  });

  it("a SYSTEM_ADMIN's enum is never touched", async () => {
    DB.users.push(user("plat", "SYSTEM_ADMIN"));
    await setRole("plat", "r_agent");
    expect(DB.users.find((u) => u.id === "plat")!.role).toBe("SYSTEM_ADMIN");
  });
});

describe("another workspace", () => {
  it("its user is 404 and nothing is written; its role cannot be assigned here", async () => {
    expect((await setRole("x1", "r_agent")).status).toBe(404);
    expect((await setRole("a2", "r_other_admin")).status).toBe(404);
    expect(DB.users.find((u) => u.id === "x1")!.role).toBe("ADMIN");
    expect(DB.assignments).toHaveLength(2);
  });
});
