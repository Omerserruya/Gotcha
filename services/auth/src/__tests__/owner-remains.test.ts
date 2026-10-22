/**
 * The system-admin user route set User.role and isActive directly and never
 * ran the last-Owner guard (2026-10-11). ownerRemainsWithout answers it: would
 * the workspace still have an Owner without this person?
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ users: [] as any[], latest: {} as Record<string, string | null> }));
vi.mock("@chatcenter/shared", () => ({
  prisma: {
    user: { findMany: async (a: any) => H.users.filter((u) => u.tenantId === a.where.tenantId && u.isActive && u.role !== "SYSTEM_ADMIN" && u.id !== a.where.id.not) },
    userRoleAssignment: { findFirst: async (a: any) => (a.where.userId in H.latest ? { role: { builtinKey: H.latest[a.where.userId] } } : null) },
  },
}));
import { ownerRemainsWithout } from "../services/role-guard";

beforeEach(() => {
  H.users = [
    { id: "o1", tenantId: "T", role: "ADMIN", isActive: true },
    { id: "ag", tenantId: "T", role: "AGENT", isActive: true },
    { id: "sys", tenantId: "T", role: "SYSTEM_ADMIN", isActive: true },
  ];
  H.latest = { o1: "owner", ag: "agent" };
});

describe("ownerRemainsWithout", () => {
  it("the only Owner: no one would remain (the platform admin does not count)", async () => {
    expect(await ownerRemainsWithout("T", "o1")).toBe(false);
  });
  it("a second Owner, by assignment or by the legacy ADMIN enum: yes", async () => {
    H.users.push({ id: "o2", tenantId: "T", role: "AGENT", isActive: true }); H.latest.o2 = "owner";
    expect(await ownerRemainsWithout("T", "o1")).toBe(true);
    H.users.pop(); H.users.push({ id: "o3", tenantId: "T", role: "ADMIN", isActive: true });
    expect(await ownerRemainsWithout("T", "o1")).toBe(true);
  });
  it("an inactive Owner does not count", async () => {
    H.users.push({ id: "o2", tenantId: "T", role: "ADMIN", isActive: false });
    expect(await ownerRemainsWithout("T", "o1")).toBe(false);
  });
});
