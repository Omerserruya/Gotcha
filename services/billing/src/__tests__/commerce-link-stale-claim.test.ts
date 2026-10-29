/**
 * A store another workspace left behind can be claimed (2026-10-29).
 *
 * After a disconnect, linkCommerceConnection refused EVERY other workspace,
 * whatever the row's status, so the store could never be connected anywhere
 * again - the Shopify review store included. Pinned:
 *   - a DISCONNECTED / uninstalled row with nothing billing on it moves, in one
 *     transaction: tenant, BILLING_PENDING, uninstalledAt cleared, the old
 *     workspace's subscriptions detached (kept, as its history), an audit row
 *     in BOTH workspaces;
 *   - a live row, or a stale-looking one with a subscription still alive
 *     (PENDING, ACTIVE, FROZEN...), still refuses and nothing is written;
 *   - the same workspace reinstalling reopens its own row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  conns: [] as any[],
  subs: [] as any[],
  audit: [] as any[],
  txCount: 0,
}));

vi.mock("@chatcenter/shared", async () => {
  const conn = {
    findUnique: async (a: any) => {
      const k = a.where.platform_externalShopId;
      return H.conns.find((c) => c.platform === k.platform && c.externalShopId === k.externalShopId) ?? null;
    },
    update: async (a: any) => {
      const row = H.conns.find((c) => c.id === a.where.id);
      Object.assign(row, a.data);
      return { ...row };
    },
    create: async (a: any) => {
      const row = { id: `cc_${H.conns.length + 1}`, ...a.data };
      H.conns.push(row);
      return row;
    },
  };
  const subs = {
    count: async (a: any) =>
      H.subs.filter((s) => s.commerceConnectionId === a.where.commerceConnectionId && !a.where.status.notIn.includes(s.status)).length,
    updateMany: async (a: any) => {
      const hit = H.subs.filter((s) => s.commerceConnectionId === a.where.commerceConnectionId);
      hit.forEach((s) => Object.assign(s, a.data));
      return { count: hit.length };
    },
  };
  const auditLog = { create: async (a: any) => { H.audit.push(a.data); return a.data; } };
  const prisma: any = { commerceConnection: conn, providerSubscription: subs, auditLog };
  prisma.$transaction = async (fn: any) => { H.txCount++; return fn(prisma); };
  return { prisma, setTenantEntitlement: vi.fn() };
});

import { linkCommerceConnection, CrossTenantShopClaimError } from "../services/provider-subscription.service";

const OLD = "t_gotcha";
const NEW = "t_urban";
const row = (o: Record<string, unknown> = {}) => ({
  id: "cc_1", tenantId: OLD, platform: "SHOPIFY", externalShopId: "76124356774", shopDomain: "shining-face.myshopify.com",
  status: "DISCONNECTED", uninstalledAt: null, installedAt: new Date("2026-09-03"), acquisitionSource: "admin",
  shopifyChatInstallationId: "inst_old", lastVerifiedAt: null, ...o,
});
const link = (tenantId = NEW) =>
  linkCommerceConnection({ tenantId, platform: "SHOPIFY" as any, externalShopId: "76124356774", shopDomain: "shining-face.myshopify.com", acquisitionSource: "app_store" });

beforeEach(() => {
  H.conns = []; H.subs = []; H.audit = []; H.txCount = 0;
});

describe("a stale row in another workspace moves", () => {
  it.each([
    ["DISCONNECTED by a local disconnect", {}],
    ["uninstalled (uninstalledAt set)", { status: "BILLING_PENDING", uninstalledAt: new Date("2026-10-20") }],
  ])("%s", async (_n, o) => {
    H.conns = [row(o)];
    H.subs = [
      { id: "ps_1", tenantId: OLD, commerceConnectionId: "cc_1", status: "CANCELLED" },
      { id: "ps_2", tenantId: OLD, commerceConnectionId: "cc_1", status: "EXPIRED" },
    ];
    const r = await link();
    expect(r).toMatchObject({ id: "cc_1", tenantId: NEW, status: "BILLING_PENDING", uninstalledAt: null, acquisitionSource: "app_store", shopifyChatInstallationId: null });
    expect(H.txCount).toBe(1);
    // The old workspace keeps its history, detached from the store.
    expect(H.subs).toEqual([
      { id: "ps_1", tenantId: OLD, commerceConnectionId: null, status: "CANCELLED" },
      { id: "ps_2", tenantId: OLD, commerceConnectionId: null, status: "EXPIRED" },
    ]);
    expect(H.audit.map((a) => [a.tenantId, a.action, a.targetId])).toEqual([
      [OLD, "billing.commerce_connection.moved", "cc_1"],
      [NEW, "billing.commerce_connection.moved", "cc_1"],
    ]);
    expect(H.audit[0].metadata).toMatchObject({ fromTenantId: OLD, toTenantId: NEW, externalShopId: "76124356774", detachedSubscriptions: 2 });
  });
});

describe("a live row still refuses, and nothing is written", () => {
  it.each([
    ["CONNECTED", { status: "CONNECTED" }, []],
    ["BILLING_PENDING (installed, awaiting a plan)", { status: "BILLING_PENDING" }, []],
    ["DISCONNECTED with a PENDING subscription", {}, ["PENDING"]],
    ["DISCONNECTED with an ACTIVE subscription", {}, ["ACTIVE"]],
    ["DISCONNECTED with a FROZEN subscription", {}, ["FROZEN"]],
    ["uninstalled with a TRIALING subscription", { uninstalledAt: new Date() }, ["TRIALING"]],
  ])("%s", async (_n, o, statuses) => {
    H.conns = [row(o)];
    H.subs = (statuses as string[]).map((status, i) => ({ id: `ps_${i}`, tenantId: OLD, commerceConnectionId: "cc_1", status }));
    const before = JSON.stringify([H.conns, H.subs]);
    await expect(link()).rejects.toBeInstanceOf(CrossTenantShopClaimError);
    expect(JSON.stringify([H.conns, H.subs])).toBe(before);
    expect(H.audit).toEqual([]);
    expect(H.txCount).toBe(0);
  });
});

describe("the same workspace reinstalling", () => {
  it("reopens its own uninstalled row: BILLING_PENDING, uninstalledAt cleared, no move", async () => {
    H.conns = [row({ tenantId: NEW, uninstalledAt: new Date("2026-10-20") })];
    H.subs = [{ id: "ps_1", tenantId: NEW, commerceConnectionId: "cc_1", status: "CANCELLED" }];
    const r = await link();
    expect(r).toMatchObject({ id: "cc_1", tenantId: NEW, status: "BILLING_PENDING", uninstalledAt: null });
    // Its own subscription stays attached: the post-install sync re-reads it from Shopify.
    expect(H.subs[0].commerceConnectionId).toBe("cc_1");
    expect(H.audit).toEqual([]);
    expect(H.txCount).toBe(0);
  });

  it("a store nobody held is created as BILLING_PENDING", async () => {
    const r = await link();
    expect(r).toMatchObject({ tenantId: NEW, status: "BILLING_PENDING", externalShopId: "76124356774" });
  });
});
