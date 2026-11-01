/**
 * Support mode invites members only, judged on the RESOLVED role (2026-11-01).
 * v2 invites by a role row's id, which the keyword rule in support-deny.ts
 * cannot read; all three invite routes share inviteRoleRefusal, so it decides.
 */
import { describe, it, expect } from "vitest";
import { runWithRequestContext } from "@chatcenter/shared";
import { inviteRoleRefusal } from "../lib/grant-ceiling";

const ACTOR = { userId: "u_support", tenantId: "t_shop", role: "ADMIN", departmentRole: null } as any;
const inSupport = <T>(fn: () => Promise<T>) => runWithRequestContext({ supportSessionId: "ss_1", supportAdminUserId: "u_sys" }, fn);

describe("inviteRoleRefusal in support mode", () => {
  it("an Owner or Admin role, sent by its id, is refused with the ownership code", async () => {
    const r = await inSupport(() => inviteRoleRefusal(ACTOR, "t_shop", { tenantRoleId: null, coarse: "ADMIN" }));
    expect(r).toMatchObject({ status: 403, code: "support_denied:ownership" });
  });

  it("a member role passes the support check", async () => {
    expect(await inSupport(() => inviteRoleRefusal(ACTOR, "t_shop", { tenantRoleId: null, coarse: "AGENT" }))).toBeNull();
  });

  it("outside support mode an admin invite is not refused here", async () => {
    expect(await inviteRoleRefusal(ACTOR, "t_shop", { tenantRoleId: null, coarse: "ADMIN" })).toBeNull();
  });
});
