/**
 * Join by email domain (2026-11-22).
 *
 * Pinned here: the domain is the admin's own and never a public one, one
 * domain has one organization (the claim is read under the lock, never
 * before it), "off" is only reported when the row is gone, and a person who
 * signs up at a held domain is admitted exactly the way an invitee is, once,
 * with one notice to the admins. The database is a small fake; no row is
 * written anywhere and no mail or notification leaves the test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  rows: new Map<string, any>(),          // tenantId -> stored joinByDomain value
  looseQuery: false,                     // the store ignores the JSON filter
  deleteSwallowed: false,                // the shared writer logged a failed delete
  onLock: null as null | (() => void),   // what another request commits before we hold the lock
  tenants: {} as Record<string, any>,
  seats: 3,
  limit: null as number | null,
  limitBreaks: false,
  role: { coarse: "AGENT", tenantRoleId: "role_agent", roleName: "Agent", fellBack: false } as any,
  inviteError: null as any,
  queueFails: false,
  calls: [] as string[],
  writes: [] as any[],
  audits: [] as any[],
  invites: [] as any[],
  assigned: [] as any[],
  queued: [] as any[],
  limitChecks: [] as any[],
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const tenantSetting = {
    findMany: async (q: any) => {
      H.calls.push("holders:" + JSON.stringify(q.where));
      const out: any[] = [];
      for (const [tenantId, value] of H.rows) {
        if (H.looseQuery || value?.domain === q.where.value.equals) out.push({ tenantId, value });
      }
      return out;
    },
    findUnique: async (q: any) => {
      const { tenantId, key } = q.where.tenantId_key;
      H.calls.push(`stored:${tenantId}:${key}`);
      return H.rows.has(tenantId) ? { value: H.rows.get(tenantId) } : null;
    },
  };
  return {
    ...actual,
    prisma: {
      tenantSetting,
      tenant: { findUnique: async (q: any) => { H.calls.push("tenant:" + q.where.id); return H.tenants[q.where.id] ?? null; } },
      user: { count: async (q: any) => { H.calls.push("seats:" + JSON.stringify(q.where)); return H.seats; } },
      $transaction: async (fn: any) =>
        fn({
          tenantSetting,
          $executeRaw: async (_sql: any, ...values: any[]) => { H.calls.push("lock:" + values[0]); H.onLock?.(); },
        }),
    },
    withCrossTenantAccess: (fn: any) => fn(),
    writeDurableSetting: async (tenantId: string, key: string, value: string | null, by?: string) => {
      H.calls.push("write");
      H.writes.push({ tenantId, key, value, by });
      if (value === null) { if (!H.deleteSwallowed) H.rows.delete(tenantId); return; }
      H.rows.set(tenantId, JSON.parse(value));
    },
    writeAudit: async (a: any) => { H.audits.push(a); },
    assertWithinLimit: async (tenantId: string, key: string, count: number) => {
      H.limitChecks.push([tenantId, key, count]);
      if (H.limitBreaks) throw new Error("entitlements unreadable");
      if (H.limit !== null && count + 1 > H.limit) {
        throw new actual.EntitlementDeniedError({ code: "PLAN_LIMIT_REACHED", feature: key });
      }
    },
    notificationsQueue: {
      add: async (...a: any[]) => { if (H.queueFails) throw new Error("redis down"); H.queued.push(a); },
    },
  };
});

vi.mock("../services/invitation.service", () => {
  class InviteRefused extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  }
  return {
    InviteRefused,
    inviteUser: async (...a: any[]) => {
      H.calls.push("invite");
      H.invites.push(a);
      if (H.inviteError === "USER_EXISTS" || H.inviteError === "EMAIL_TAKEN") throw new InviteRefused(H.inviteError, "refused");
      if (H.inviteError) throw H.inviteError;
      return { user: { id: "u_noa", email: a[1], name: a[2], role: "AGENT", tenantId: a[0] }, setupLink: "https://x/setup", existingIdentity: false };
    },
  };
});

vi.mock("../services/invite-role.service", () => ({
  resolveInviteRoleStrict: async (tenantId: string, role: string) => { H.calls.push(`role:${tenantId}:${role}`); return H.role; },
  ensureRoleAssignment: async (...a: any[]) => { H.assigned.push(a); },
}));

import { joinDomainView, setJoinDomain, organizationHolding, admitByDomain, MEMBER_JOINED_EVENT } from "../services/domain-join.service";
import { JOIN_BY_DOMAIN_KEY, AuditAction } from "@chatcenter/shared";

const NOW = new Date("2026-11-22T16:00:00.000Z");
const DANA = { userId: "u_dana", email: "dana@acme-flowers.co.il" };
const stored = (domain: string, by = "u_old", at = "2026-11-01T08:00:00.000Z") => ({ domain, enabledBy: by, enabledAt: at });

beforeEach(() => {
  H.rows = new Map(); H.looseQuery = false; H.deleteSwallowed = false; H.onLock = null;
  H.tenants = { t_acme: { id: "t_acme", status: "ACTIVE", isActive: true } };
  H.seats = 3; H.limit = null; H.limitBreaks = false;
  H.role = { coarse: "AGENT", tenantRoleId: "role_agent", roleName: "Agent", fellBack: false };
  H.inviteError = null; H.queueFails = false;
  H.calls = []; H.writes = []; H.audits = []; H.invites = []; H.assigned = []; H.queued = []; H.limitChecks = [];
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("what the settings screen reads", () => {
  it("nothing stored: the admin's own domain, off", async () => {
    expect(await joinDomainView("t_acme", "dana@acme-flowers.co.il")).toEqual({
      domain: "acme-flowers.co.il", joinByDomain: false, publicDomain: false, activeDomain: null,
    });
  });

  it("the domain is read from the address in lower case", async () => {
    expect((await joinDomainView("t_acme", "Dana@ACME-Flowers.CO.IL"))!.domain).toBe("acme-flowers.co.il");
  });

  it("on, with the admin's own domain", async () => {
    H.rows.set("t_acme", stored("acme-flowers.co.il"));
    expect(await joinDomainView("t_acme", DANA.email)).toEqual({
      domain: "acme-flowers.co.il", joinByDomain: true, publicDomain: false, activeDomain: "acme-flowers.co.il",
    });
  });

  it("on by another admin at another domain: not this admin's switch, and the screen is told which domain is on", async () => {
    H.rows.set("t_acme", stored("acme-flowers.com"));
    expect(await joinDomainView("t_acme", DANA.email)).toEqual({
      domain: "acme-flowers.co.il", joinByDomain: false, publicDomain: false, activeDomain: "acme-flowers.com",
    });
  });

  it.each([["dana@gmail.com", "gmail.com"], ["dana@walla.co.il", "walla.co.il"], ["dana@outlook.com", "outlook.com"]])(
    "%s: a public mail domain, marked and never on",
    async (email, domain) => {
      expect(await joinDomainView("t_acme", email)).toEqual({ domain, joinByDomain: false, publicDomain: true, activeDomain: null });
    },
  );

  it.each([
    ["a public domain written by hand", { domain: "gmail.com", enabledBy: "u1", enabledAt: "2026-11-01T08:00:00.000Z" }],
    ["no domain", { enabledBy: "u1" }],
    ["a list", ["acme-flowers.co.il"]],
    ["a bare word", "acme"],
  ])("a stored row that is %s reads as off", async (_name, value) => {
    H.rows.set("t_acme", value);
    expect(await joinDomainView("t_acme", DANA.email)).toMatchObject({ joinByDomain: false, activeDomain: null });
  });

  it.each([["dana"], ["dana@"], ["dana@localhost"], [""]])("%j has no domain to offer", async (email) => {
    expect(await joinDomainView("t_acme", email)).toBeNull();
  });

  it("is read from the organization's own row in the database", async () => {
    await joinDomainView("t_acme", DANA.email);
    expect(H.calls).toEqual([`stored:t_acme:${JOIN_BY_DOMAIN_KEY}`]);
  });
});

describe("switching it on", () => {
  it("stores the admin's own domain, who and when, under the lock on that domain", async () => {
    const r = await setJoinDomain("t_acme", DANA, true, NOW);
    expect(r).toEqual({ ok: true, view: { domain: "acme-flowers.co.il", joinByDomain: true, publicDomain: false, activeDomain: "acme-flowers.co.il" } });
    expect(H.rows.get("t_acme")).toEqual({ domain: "acme-flowers.co.il", enabledBy: "u_dana", enabledAt: "2026-11-22T16:00:00.000Z" });
    expect(H.writes).toEqual([{ tenantId: "t_acme", key: JOIN_BY_DOMAIN_KEY, value: JSON.stringify(H.rows.get("t_acme")), by: "u_dana" }]);
    // The lock first, the other organizations read after it, the write last.
    expect(H.calls.slice(1)).toEqual([
      "lock:joinByDomain:acme-flowers.co.il",
      `holders:${JSON.stringify({ key: JOIN_BY_DOMAIN_KEY, value: { path: ["domain"], equals: "acme-flowers.co.il" } })}`,
      "write",
    ]);
    expect(H.audits).toEqual([{
      tenantId: "t_acme", actorType: "user", actorId: "u_dana", action: AuditAction.JOIN_BY_DOMAIN_CHANGED,
      targetType: "tenant", targetId: "t_acme", metadata: { on: true, domain: "acme-flowers.co.il", previousDomain: null },
    }]);
  });

  it.each([["dana@gmail.com"], ["dana@googlemail.com"], ["dana@hotmail.co.il"], ["dana@icloud.com"], ["dana@yahoo.com"], ["dana@walla.co.il"]])(
    "%s: a public mail domain is refused and nothing is written",
    async (email) => {
      expect(await setJoinDomain("t_acme", { userId: "u_dana", email }, true, NOW)).toEqual({ ok: false, status: 409, error: "public_domain" });
      expect(H.writes).toEqual([]); expect(H.audits).toEqual([]);
      expect(H.calls.some((c) => c.startsWith("lock:"))).toBe(false);
    },
  );

  it("an address with no domain is refused", async () => {
    expect(await setJoinDomain("t_acme", { userId: "u_dana", email: "dana" }, true, NOW)).toEqual({ ok: false, status: 409, error: "no_domain" });
    expect(H.writes).toEqual([]);
  });

  it("a domain another organization holds is taken: nothing is written, and its row is left as it was", async () => {
    H.rows.set("t_other", stored("acme-flowers.co.il", "u_them"));
    expect(await setJoinDomain("t_acme", DANA, true, NOW)).toEqual({ ok: false, status: 409, error: "domain_taken" });
    expect(H.writes).toEqual([]); expect(H.audits).toEqual([]);
    expect(H.rows.get("t_other")).toEqual(stored("acme-flowers.co.il", "u_them"));
    expect(H.rows.has("t_acme")).toBe(false);
  });

  it("a suspended holder still holds it: the holder's status is not read at all", async () => {
    H.rows.set("t_other", stored("acme-flowers.co.il"));
    H.tenants.t_other = { id: "t_other", status: "SUSPENDED", isActive: false };
    expect(await setJoinDomain("t_acme", DANA, true, NOW)).toMatchObject({ ok: false, error: "domain_taken" });
    expect(H.calls.some((c) => c.startsWith("tenant:"))).toBe(false);
  });

  it("another organization that claims it a moment earlier wins: the claim is read after the lock", async () => {
    H.onLock = () => { H.rows.set("t_other", stored("acme-flowers.co.il", "u_them", "2026-11-22T15:59:59.000Z")); };
    expect(await setJoinDomain("t_acme", DANA, true, NOW)).toMatchObject({ ok: false, error: "domain_taken" });
    expect(H.writes).toEqual([]);
  });

  it("two saves by the same organization at once: the second is not told its own domain is taken", async () => {
    H.onLock = () => { H.rows.set("t_acme", stored("acme-flowers.co.il", "u_tal", "2026-11-22T15:59:59.000Z")); };
    expect(await setJoinDomain("t_acme", DANA, true, NOW)).toMatchObject({ ok: true, view: { joinByDomain: true } });
  });

  it("another organization's different domain does not block, even if the store returns it", async () => {
    H.looseQuery = true;
    H.rows.set("t_other", stored("acme-flowers.com"));
    expect(await setJoinDomain("t_acme", DANA, true, NOW)).toMatchObject({ ok: true });
    expect(H.rows.get("t_acme").domain).toBe("acme-flowers.co.il");
  });

  it("already on with this domain: nothing is rewritten and nothing is logged", async () => {
    H.rows.set("t_acme", stored("acme-flowers.co.il", "u_tal"));
    const r = await setJoinDomain("t_acme", DANA, true, NOW);
    expect(r).toMatchObject({ ok: true, view: { joinByDomain: true, activeDomain: "acme-flowers.co.il" } });
    expect(H.writes).toEqual([]); expect(H.audits).toEqual([]);
    expect(H.rows.get("t_acme")).toEqual(stored("acme-flowers.co.il", "u_tal"));
  });

  it("an organization has ONE domain: switching on replaces the one another admin set", async () => {
    H.rows.set("t_acme", stored("acme-flowers.com", "u_tal"));
    const r = await setJoinDomain("t_acme", DANA, true, NOW);
    expect(r).toMatchObject({ ok: true, view: { joinByDomain: true, activeDomain: "acme-flowers.co.il" } });
    expect(H.rows.get("t_acme")).toEqual({ domain: "acme-flowers.co.il", enabledBy: "u_dana", enabledAt: NOW.toISOString() });
    expect(H.audits[0].metadata).toEqual({ on: true, domain: "acme-flowers.co.il", previousDomain: "acme-flowers.com" });
  });
});

describe("switching it off", () => {
  it("removes the row and says so", async () => {
    H.rows.set("t_acme", stored("acme-flowers.co.il"));
    expect(await setJoinDomain("t_acme", DANA, false, NOW)).toEqual({
      ok: true, view: { domain: "acme-flowers.co.il", joinByDomain: false, publicDomain: false, activeDomain: null },
    });
    expect(H.rows.has("t_acme")).toBe(false);
    expect(H.writes).toEqual([{ tenantId: "t_acme", key: JOIN_BY_DOMAIN_KEY, value: null, by: "u_dana" }]);
    expect(H.audits.map((a) => [a.action, a.metadata])).toEqual([[AuditAction.JOIN_BY_DOMAIN_CHANGED, { on: false, domain: "acme-flowers.co.il" }]]);
  });

  it("any admin may switch it off, also one whose own domain is another or a public one", async () => {
    H.rows.set("t_acme", stored("acme-flowers.co.il"));
    expect(await setJoinDomain("t_acme", { userId: "u_tal", email: "tal@gmail.com" }, false, NOW)).toMatchObject({
      ok: true, view: { domain: "gmail.com", publicDomain: true, joinByDomain: false, activeDomain: null },
    });
    expect(H.rows.has("t_acme")).toBe(false);
    expect(H.audits[0].metadata).toEqual({ on: false, domain: "acme-flowers.co.il" });
  });

  it("already off: fine, and nothing is logged", async () => {
    expect(await setJoinDomain("t_acme", DANA, false, NOW)).toMatchObject({ ok: true, view: { joinByDomain: false } });
    expect(H.audits).toEqual([]);
  });

  it("a row that is still there is NOT reported as off", async () => {
    H.rows.set("t_acme", stored("acme-flowers.co.il"));
    H.deleteSwallowed = true;
    await expect(setJoinDomain("t_acme", DANA, false, NOW)).rejects.toThrow("the setting was not removed");
    expect(H.audits).toEqual([]);
  });
});

describe("which organization a new address joins", () => {
  it("nobody holds the domain: none", async () => {
    expect(await organizationHolding("noa@acme-flowers.co.il")).toBeNull();
  });

  it("the organization that holds it, open", async () => {
    H.rows.set("t_acme", stored("acme-flowers.co.il"));
    expect(await organizationHolding("noa@acme-flowers.co.il")).toEqual({ tenantId: "t_acme", domain: "acme-flowers.co.il", open: true });
  });

  it("the address is matched in any case", async () => {
    H.rows.set("t_acme", stored("acme-flowers.co.il"));
    expect(await organizationHolding("Noa@ACME-FLOWERS.CO.IL")).toMatchObject({ tenantId: "t_acme" });
  });

  it.each([
    ["noa@mail.acme-flowers.co.il", "a subdomain"],
    ["noa@acme-flowers.com", "the same name under another ending"],
    ["noa@notacme-flowers.co.il", "a longer name that ends the same"],
    ["noa@acme-flowers.co.il.evil.example", "the domain as a prefix"],
  ])("%s (%s) is not the held domain", async (email) => {
    H.rows.set("t_acme", stored("acme-flowers.co.il"));
    expect(await organizationHolding(email)).toBeNull();
  });

  it("only the exact domain's row counts, even if the store returns others", async () => {
    H.looseQuery = true;
    H.rows.set("t_other", stored("other-shop.co.il"));
    expect(await organizationHolding("noa@acme-flowers.co.il")).toBeNull();
  });

  it.each([["noa@gmail.com"], ["noa@walla.co.il"]])("%s: a public address is never looked up", async (email) => {
    H.rows.set("t_acme", { domain: email.split("@")[1], enabledBy: "u1", enabledAt: "2026-11-01T08:00:00.000Z" });
    expect(await organizationHolding(email)).toBeNull();
    expect(H.calls).toEqual([]);
  });

  it.each([
    ["ACTIVE", true, true],
    ["PENDING_ONBOARDING", true, true],
    ["PENDING_ADMIN_SETUP", true, true],
    ["PENDING_PAYMENT", true, true],
    ["SUSPENDED", true, false],
    ["ACTIVE", false, false],
  ])("a holder that is %s (active flag %s): open %s, and it still holds the domain", async (status, isActive, open) => {
    H.rows.set("t_acme", stored("acme-flowers.co.il"));
    H.tenants.t_acme = { id: "t_acme", status, isActive };
    expect(await organizationHolding("noa@acme-flowers.co.il")).toEqual({ tenantId: "t_acme", domain: "acme-flowers.co.il", open });
  });

  it("two rows for one domain (never written by this code): the older claim is the holder", async () => {
    H.rows.set("t_late", stored("acme-flowers.co.il", "u2", "2026-11-10T08:00:00.000Z"));
    H.rows.set("t_acme", stored("acme-flowers.co.il", "u1", "2026-11-01T08:00:00.000Z"));
    H.tenants.t_late = { id: "t_late", status: "ACTIVE", isActive: true };
    expect(await organizationHolding("noa@acme-flowers.co.il")).toMatchObject({ tenantId: "t_acme" });
  });

  it("a row whose organization is gone holds nothing", async () => {
    H.rows.set("t_gone", stored("acme-flowers.co.il"));
    expect(await organizationHolding("noa@acme-flowers.co.il")).toBeNull();
  });
});

describe("admitting the person", () => {
  const ORG = { tenantId: "t_acme", domain: "acme-flowers.co.il", open: true };
  const NOA = { email: "noa@acme-flowers.co.il", name: "Noa Levi" };
  const nothingHappened = () => {
    expect(H.invites).toEqual([]); expect(H.assigned).toEqual([]); expect(H.audits).toEqual([]); expect(H.queued).toEqual([]);
  };

  it("an agent, through the invitation's own steps, with one notice to the admins", async () => {
    expect(await admitByDomain(ORG, NOA)).toEqual({ kind: "joined", tenantId: "t_acme", userId: "u_noa" });
    expect(H.calls).toEqual([`seats:${JSON.stringify({ tenantId: "t_acme", isActive: true })}`, "role:t_acme:AGENT", "invite"]);
    expect(H.limitChecks).toEqual([["t_acme", "limit:users", 3]]);
    expect(H.invites).toEqual([["t_acme", "noa@acme-flowers.co.il", "Noa Levi", "AGENT"]]);
    expect(H.assigned).toEqual([["u_noa", "role_agent", null]]);
    expect(H.audits).toEqual([{
      tenantId: "t_acme", actorType: "system", actorId: null, action: AuditAction.MEMBER_JOINED_BY_DOMAIN,
      targetType: "user", targetId: "u_noa",
      metadata: { email: "noa@acme-flowers.co.il", domain: "acme-flowers.co.il", role: "AGENT", roleId: "role_agent" },
    }]);
    expect(H.queued).toHaveLength(1);
    const [name, event, opts] = H.queued[0];
    expect(name).toBe("system-event");
    expect(event).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      type: "member.joined_by_domain",
      tenantId: "t_acme",
      data: { userId: "u_noa", name: "Noa Levi", email: "noa@acme-flowers.co.il", domain: "acme-flowers.co.il" },
      metadata: { timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) },
    });
    expect(opts).toMatchObject({ attempts: 5 });
    expect(MEMBER_JOINED_EVENT).toBe("member.joined_by_domain");
  });

  it("an organization that is closed takes nobody, and nothing is even counted", async () => {
    expect(await admitByDomain({ ...ORG, open: false }, NOA)).toEqual({ kind: "not_joined", tenantId: "t_acme", reason: "organization_closed" });
    expect(H.calls).toEqual([]); nothingHappened();
  });

  it("a full organization is not grown: no membership, no email, no notice", async () => {
    H.seats = 5; H.limit = 5;
    expect(await admitByDomain(ORG, NOA)).toEqual({ kind: "not_joined", tenantId: "t_acme", reason: "seats_full" });
    expect(H.limitChecks).toEqual([["t_acme", "limit:users", 5]]);
    nothingHappened();
  });

  it("the last free seat is taken", async () => {
    H.seats = 4; H.limit = 5;
    expect(await admitByDomain(ORG, NOA)).toMatchObject({ kind: "joined" });
  });

  it("a limit that cannot be read admits nobody", async () => {
    H.limitBreaks = true;
    await expect(admitByDomain(ORG, NOA)).rejects.toThrow("entitlements unreadable");
    nothingHappened();
  });

  it.each([["USER_EXISTS", "already_member"], ["EMAIL_TAKEN", "email_taken"]])(
    "the invitation refuses with %s: %s, and nobody is told anything",
    async (code, reason) => {
      H.inviteError = code;
      expect(await admitByDomain(ORG, NOA)).toEqual({ kind: "not_joined", tenantId: "t_acme", reason });
      expect(H.assigned).toEqual([]); expect(H.audits).toEqual([]); expect(H.queued).toEqual([]);
    },
  );

  it("an invitation that breaks is a failure, not a quiet refusal", async () => {
    H.inviteError = new Error("authentik 503");
    await expect(admitByDomain(ORG, NOA)).rejects.toThrow("authentik 503");
    expect(H.audits).toEqual([]); expect(H.queued).toEqual([]);
  });

  it("no agent role to give: the membership stands with the coarse role only", async () => {
    H.role = { coarse: "AGENT", tenantRoleId: null, roleName: null, fellBack: false };
    expect(await admitByDomain(ORG, NOA)).toMatchObject({ kind: "joined" });
    expect(H.assigned).toEqual([["u_noa", null, null]]);
    expect(H.audits[0].metadata.roleId).toBeNull();
  });

  it("a queue that is down does not undo the join", async () => {
    H.queueFails = true;
    expect(await admitByDomain(ORG, NOA)).toEqual({ kind: "joined", tenantId: "t_acme", userId: "u_noa" });
    await new Promise((r) => setTimeout(r, 5));
    expect(H.audits).toHaveLength(1);
  });
});
