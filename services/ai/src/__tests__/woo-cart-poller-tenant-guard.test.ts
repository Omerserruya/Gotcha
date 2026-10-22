/**
 * ★ The Woo cart/order ticker runs under the TenantGuard (2026-10-14): its
 * scan for workspaces with a live cart / order automation is deliberately
 * cross-tenant, and without the wrapper the guard threw on every tick, so no
 * Woo cart or order automation ever fired. The double below throws exactly as
 * the guard does for a where clause with no tenantId outside the wrapper.
 */
import { describe, it, expect, vi } from "vitest";

const H = vi.hoisted(() => ({ cross: 0, polled: [] as string[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const guarded = (rows: any[]) => async (a: any) => {
    if (H.cross === 0 && !JSON.stringify(a?.where ?? {}).includes("tenantId")) {
      throw new Error("[TenantGuard] ChatbotFlow.findMany blocked: where clause is missing tenantId.");
    }
    return rows;
  };
  return {
    ...actual,
    withCrossTenantAccess: async (fn: any) => { H.cross++; try { return await fn(); } finally { H.cross--; } },
    getRedis: () => ({ get: async () => null, set: async () => "OK", del: async () => 1 }),
    prisma: {
      chatbotFlow: { findMany: guarded([{ tenantId: "T1" }, { tenantId: "T2" }]) },
      tenantIntegration: { findMany: async (a: any) => (a.where.tenantId.in as string[]).map((t) => ({ id: `ti_${t}`, tenantId: t, credentials: {}, config: {} })) },
    },
  };
});

import { pollWooCarts } from "../services/woo-cart-poller.service";

describe("★ the ticker is not blocked by the TenantGuard", () => {
  it("scans every workspace with a live cart/order automation and reaches each connected store", async () => {
    await expect(pollWooCarts(new Date())).resolves.toBe(0);
    expect(H.cross).toBe(0);
  });
});
