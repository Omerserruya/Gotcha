/**
 * A per-person permission can end (12e: 7 days / 30 days / a picked date).
 *
 * Pinned through the REAL resolver (hasFeature), not the helper alone: an
 * expired grant does not grant, an unexpired one does, no date is forever,
 * and the 30s cache cannot carry a grant past its end - the check runs per
 * call against the cached expiry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const DB = vi.hoisted(() => ({ grants: [] as any[], reads: 0 }));

vi.mock("../lib/prisma", () => ({
  prisma: {
    tenantFeature: { findMany: async () => [{ feature: "auto_buy", enabled: true }] },
    tenant: { findUnique: async () => null },
    userFeatureGrant: {
      findMany: async (a: any) => {
        if (!a.where?.userId) throw new Error("grant read without a user");
        DB.reads++;
        // Faithful to `select`: a resolver that forgets to select expiresAt
        // gets no expiry and treats every grant as forever - and fails here.
        return DB.grants
          .filter((g) => g.userId === a.where.userId)
          .map((g) => Object.fromEntries(Object.keys(a.select).map((k) => [k, g[k]])));
      },
    },
    userRoleAssignment: { findMany: async () => [] },
  },
}));

import { hasFeature, invalidatePermissionsCache, grantsInForce } from "../lib/permissions";

const AGENT = { userId: "u1", tenantId: "T", role: "AGENT" };
const grant = (expiresAt: Date | null, granted = true) => ({ userId: "u1", feature: "auto_buy", granted, expiresAt });

beforeEach(() => {
  invalidatePermissionsCache();
  DB.reads = 0;
  vi.useRealTimers();
});

describe("a per-person grant with an end date", () => {
  it("baseline: an AGENT has no auto_buy without a grant", async () => {
    DB.grants = [];
    expect(await hasFeature(AGENT, "auto_buy" as any)).toBe(false);
  });

  it("★ an EXPIRED grant does not grant", async () => {
    DB.grants = [grant(new Date(Date.now() - 1000))];
    expect(await hasFeature(AGENT, "auto_buy" as any)).toBe(false);
  });

  it("★ an unexpired grant grants", async () => {
    DB.grants = [grant(new Date(Date.now() + 7 * 86_400_000))];
    expect(await hasFeature(AGENT, "auto_buy" as any)).toBe(true);
  });

  it("★ no end date is forever", async () => {
    DB.grants = [grant(null)];
    expect(await hasFeature(AGENT, "auto_buy" as any)).toBe(true);
  });

  it("★ the cache cannot carry a grant past its end", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T10:00:00Z"));
    DB.grants = [grant(new Date("2026-10-06T10:00:10Z"))];
    expect(await hasFeature(AGENT, "auto_buy" as any)).toBe(true);

    vi.setSystemTime(new Date("2026-10-06T10:00:11Z")); // inside the 30s cache window
    expect(await hasFeature(AGENT, "auto_buy" as any)).toBe(false);
    expect(DB.reads).toBe(1); // answered from the cache, and still correct
  });

  it("an expired REVOKE restores what the role gives (both directions end)", () => {
    const rows = new Map([["auto_buy", { granted: false, expiresAt: 1000 }]]);
    expect(grantsInForce(rows, 999).get("auto_buy")).toBe(false);
    expect(grantsInForce(rows, 1000).has("auto_buy")).toBe(false);
  });
});
