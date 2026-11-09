/**
 * Option B (2026-11-09): Authentik's gotcha_mfa_required marker follows
 * mfaRequirementFor across every active membership of the identity, and is
 * written only when it changes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ users: [] as any[], subject: "sub1" as string | null, writes: [] as any[], current: undefined as boolean | undefined, idpDown: false, observer: null as any }));

vi.mock("@chatcenter/shared", async () => {
  const mfa = await vi.importActual<any>("../../../../packages/shared/src/lib/mfa");
  return {
    mfaRequirementFor: mfa.mfaRequirementFor,
    prisma: {
      user: {
        findMany: vi.fn(async (a: any) => H.users.filter((u) => (a.where.identityId ? u.identityId === a.where.identityId && u.isActive === a.where.isActive : u.tenantId === a.where.tenantId))),
        findUnique: vi.fn(async (a: any) => H.users.find((u) => u.id === a.where.id) ?? null),
      },
      identity: { findUnique: vi.fn(async () => (H.subject ? { authentikSubject: H.subject } : null)) },
    },
    findIdentityBySubject: vi.fn(async () => { if (H.idpDown) throw new Error("503"); return { pk: 45 }; }),
    setMfaRequiredAttribute: vi.fn(async (pk: number, v: boolean) => { if (H.current === v) return false; H.writes.push([pk, v]); H.current = v; return true; }),
    observeMfaRequirement: vi.fn((fn: any) => { H.observer = fn; }),
  };
});

import { syncMfaRequiredFlag, mfaRequiredForIdentity, syncMfaRequiredFlagsForTenant, resetMfaFlagCache, startMfaRequiredFlagSync } from "../services/mfa-required-flag.service";

const off = { mfaRequiredForAdmins: false, mfaRequiredForAllUsers: false };
const u = (id: string, role: string, tenant = off, over: any = {}) => ({ id, identityId: "id1", tenantId: "t1", isActive: true, role, tenant, ...over });

beforeEach(() => { H.users = []; H.subject = "sub1"; H.writes = []; H.current = undefined; H.idpDown = false; resetMfaFlagCache(); });

describe("who is required", () => {
  it("SYSTEM_ADMIN always; ADMIN by its workspace; any one membership is enough; an inactive one does not count", async () => {
    H.users = [u("a", "AGENT")];
    expect(await mfaRequiredForIdentity("id1")).toBe(false);
    H.users = [u("a", "AGENT"), u("b", "ADMIN", { mfaRequiredForAdmins: true, mfaRequiredForAllUsers: false }, { tenantId: "t2" })];
    expect(await mfaRequiredForIdentity("id1")).toBe(true);
    H.users = [u("s", "SYSTEM_ADMIN", off, { isActive: false })];
    expect(await mfaRequiredForIdentity("id1")).toBe(false);
    H.users = [u("s", "SYSTEM_ADMIN")];
    expect(await mfaRequiredForIdentity("id1")).toBe(true);
  });
});

describe("the marker", () => {
  it("written when it differs, not again while unchanged; a policy change forces a re-sync", async () => {
    H.users = [u("s", "SYSTEM_ADMIN")];
    expect(await syncMfaRequiredFlag("id1")).toBe(true);
    expect(await syncMfaRequiredFlag("id1")).toBe(true);
    expect(H.writes).toEqual([[45, true]]);
    H.users = [u("a", "ADMIN", off)];
    await syncMfaRequiredFlagsForTenant("t1");
    expect(H.writes).toEqual([[45, true], [45, false]]);
  });
  it("no Authentik subject, or Authentik down: null, nothing thrown", async () => {
    H.users = [u("s", "SYSTEM_ADMIN")];
    H.subject = null;
    expect(await syncMfaRequiredFlag("id1")).toBeNull();
    H.subject = "sub1"; H.idpDown = true;
    expect(await syncMfaRequiredFlag("id1")).toBeNull();
    expect(H.writes).toEqual([]);
  });
  it("start-up wires the server gate's verdicts to the sync", async () => {
    H.users = [u("s", "SYSTEM_ADMIN")];
    startMfaRequiredFlagSync();
    H.observer("id1");
    await new Promise((r) => setTimeout(r, 10));
    expect(H.writes).toEqual([[45, true]]);
  });
});
