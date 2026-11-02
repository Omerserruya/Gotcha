/**
 * A Bearer principal names its login (2026-11-02): Authentik's access token
 * carries `sid` (the login session, stable across refreshes), and
 * resolvePrincipal returns it as sessionId = "oidc:<sid>". Support mode binds
 * to it. A token without sid has no sessionId.
 */
import { describe, it, expect, vi } from "vitest";

const T = vi.hoisted(() => ({ sid: "abc123" as string | undefined }));
vi.mock("../lib/jwt", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  verifyAccessToken: async () => ({ subject: "sub-1", ...(T.sid ? { sid: T.sid } : {}) }),
}));
vi.mock("../lib/prisma", () => ({
  prisma: {
    identity: {
      findUnique: async () => ({ id: "id1", lastTenantId: "t1", memberships: [{ id: "u1", tenantId: "t1", role: "ADMIN", email: "a@x", isActive: true, lastActiveAt: new Date(), departmentMembers: [] }] }),
      update: async () => ({}),
    },
    user: { update: async () => ({}) },
  },
  withCrossTenantAccess: (fn: any) => fn(),
}));

import { resolvePrincipal } from "../lib/principal";

describe("resolvePrincipal and the login", () => {
  it("a token with sid: sessionId is oidc:<sid>", async () => {
    T.sid = "abc123";
    expect(await resolvePrincipal("t")).toMatchObject({ userId: "u1", sessionId: "oidc:abc123" });
  });
  it("a token without sid: no sessionId", async () => {
    T.sid = undefined;
    expect(await resolvePrincipal("t")).not.toHaveProperty("sessionId");
  });
});
