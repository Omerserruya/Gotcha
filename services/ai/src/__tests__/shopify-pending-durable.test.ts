/**
 * Shopify App Review 132211 (2026-11-22): an install authorized on Shopify before any GOTCHA sign-in is
 * kept as a durable row as well as in Redis (shopify-install-intent.service). A lost Redis record no
 * longer loses the store; the claim still spends it exactly once; a lapsed one is gone and deleted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  rows: [] as any[],
  redisDown: false,
  dbDown: false,
  seq: 0,
  /** Another claim deleted the row between this claim's read and its delete. */
  lostRace: false,
}));

vi.mock("@chatcenter/shared", async (orig) => {
  const actual: any = await orig();
  const match = (r: any, w: any): boolean => Object.entries(w ?? {}).every(([k, v]: [string, any]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("not" in v) return r[k] !== v.not;
      if ("lt" in v) return new Date(r[k]).getTime() < new Date(v.lt).getTime();
    }
    return (r[k] ?? null) === v;
  });
  const down = () => { if (H.dbDown) throw new Error("db down"); };
  return {
    ...actual,
    withCrossTenantAccess: (fn: any) => fn(),
    encryptCredentials: (c: any) => `enc(${JSON.stringify(c)})`,
    decryptCredentials: (b: string) => JSON.parse(b.slice(4, -1)),
    getRedis: () => {
      if (H.redisDown) throw new Error("redis down");
      return {
        set: async (k: string, v: string) => { H.kv.set(k, v); return "OK"; },
        get: async (k: string) => H.kv.get(k) ?? null,
        getdel: async (k: string) => { const v = H.kv.get(k) ?? null; H.kv.delete(k); return v; },
        del: async (k: string) => { H.kv.delete(k); return 1; },
      };
    },
    prisma: {
      shopifyChatInstallation: {
        create: async (a: any) => { down(); const r = { id: `r${++H.seq}`, installedAt: new Date(), ...a.data }; H.rows.push(r); return r; },
        findFirst: async (a: any) => { down(); return H.rows.find((r) => match(r, a.where)) ?? null; },
        deleteMany: async (a: any) => { down(); if (H.lostRace) return { count: 0 }; const gone = H.rows.filter((r) => match(r, a.where)); H.rows = H.rows.filter((r) => !gone.includes(r)); return { count: gone.length }; },
      },
    },
  };
});

import {
  createPendingConnection, peekPendingConnection, peekPendingAccessToken, consumePendingConnection,
  discardPendingConnection, sweepLapsedPending, PENDING_CLAIM_IDENTITY, PENDING_CONNECTION_TTL_SECONDS,
} from "../services/shopify-install-intent.service";

const park = () => createPendingConnection({ shopDomain: "random-randomizer.myshopify.com", credentials: { accessToken: "shpat_secret", shopDomain: "random-randomizer.myshopify.com" }, scope: "read_products", flow: "studio" });

beforeEach(() => { H.kv.clear(); H.rows = []; H.redisDown = false; H.dbDown = false; H.seq = 0; H.lostRace = false; });

describe("the durable pending install", () => {
  it("is a parked row: no workspace, the token encrypted, the handle only as a hash", async () => {
    const handle = await park();
    expect(H.rows).toHaveLength(1);
    const row = H.rows[0];
    expect(row).toMatchObject({ shopDomain: "random-randomizer.myshopify.com", status: "PENDING", appIdentity: PENDING_CLAIM_IDENTITY, verifiedDomains: [] });
    expect(row.tenantId ?? null).toBeNull();
    expect(row.tokenScopes).toMatch(/^pending:[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(handle);
    // The token itself is only inside the encrypted blob.
    expect(Object.keys(JSON.parse(row.accessToken)).sort()).toEqual(["createdAt", "credentialsBlob", "flow", "scope", "shopDomain"]);
    expect(JSON.parse(row.accessToken).credentialsBlob).toMatch(/^enc\(/);
  });

  it("★ Redis lost it (flush, eviction): the store is still found, its token still readable, and claimed once", async () => {
    const handle = await park();
    H.kv.clear();
    expect(await peekPendingConnection(handle)).toMatchObject({ shopDomain: "random-randomizer.myshopify.com" });
    expect(await peekPendingAccessToken(handle)).toBe("shpat_secret");
    const first = await consumePendingConnection(handle);
    expect(first).toMatchObject({ shopDomain: "random-randomizer.myshopify.com", credentials: { accessToken: "shpat_secret" }, scope: "read_products", flow: "studio" });
    expect(await consumePendingConnection(handle)).toBeNull();
    expect(H.rows).toHaveLength(0);
  });

  it("★ two claims race on the row alone: only the one whose delete took it gets the store", async () => {
    const handle = await park();
    H.kv.clear();
    H.lostRace = true;
    expect(await consumePendingConnection(handle)).toBeNull();
    H.lostRace = false;
    expect(await consumePendingConnection(handle)).toMatchObject({ shopDomain: "random-randomizer.myshopify.com" });
  });

  it("Redis has it: the claim spends both copies", async () => {
    const handle = await park();
    expect(await consumePendingConnection(handle)).toMatchObject({ shopDomain: "random-randomizer.myshopify.com" });
    expect(H.kv.size).toBe(0);
    expect(H.rows).toHaveLength(0);
    expect(await consumePendingConnection(handle)).toBeNull();
  });

  it("Redis down at the claim: the row decides, once", async () => {
    const handle = await park();
    H.redisDown = true;
    expect(await consumePendingConnection(handle)).toMatchObject({ credentials: { accessToken: "shpat_secret" } });
    expect(await consumePendingConnection(handle)).toBeNull();
  });

  it("both stores down: fail closed", async () => {
    const handle = await park();
    H.redisDown = true; H.dbDown = true;
    expect(await consumePendingConnection(handle)).toBeNull();
  });

  it("Redis down when parked: the row alone holds it", async () => {
    H.redisDown = true;
    const handle = await park();
    H.redisDown = false;
    expect(await peekPendingConnection(handle)).toMatchObject({ shopDomain: "random-randomizer.myshopify.com" });
  });

  it("lapsed (past the window): gone for peek and claim, and swept with its token", async () => {
    const handle = await park();
    H.kv.clear();
    H.rows[0].installedAt = new Date(Date.now() - PENDING_CONNECTION_TTL_SECONDS * 1000 - 1000);
    expect(await peekPendingConnection(handle)).toBeNull();
    expect(await peekPendingAccessToken(handle)).toBeNull();
    await park();
    expect(H.rows).toHaveLength(1);
    expect(await sweepLapsedPending()).toBe(0);
  });

  it("the sweep removes only lapsed parked rows, never a real installation", async () => {
    H.rows = [
      { id: "old", appIdentity: PENDING_CLAIM_IDENTITY, installedAt: new Date(Date.now() - 3 * 24 * 3600_000) },
      { id: "new", appIdentity: PENDING_CLAIM_IDENTITY, installedAt: new Date() },
      { id: "real", appIdentity: "gotcha-core", installedAt: new Date(Date.now() - 300 * 24 * 3600_000) },
    ];
    expect(await sweepLapsedPending()).toBe(1);
    expect(H.rows.map((r) => r.id)).toEqual(["new", "real"]);
  });

  it("a wrong or foreign handle finds nothing; discard spends it without a claim", async () => {
    const handle = await park();
    expect(await peekPendingConnection("f".repeat(64))).toBeNull();
    expect(await peekPendingConnection("not-a-handle")).toBeNull();
    await discardPendingConnection(handle);
    expect(await peekPendingConnection(handle)).toBeNull();
    expect(H.rows).toHaveLength(0);
  });
});
