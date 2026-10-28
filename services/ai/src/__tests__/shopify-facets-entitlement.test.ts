/**
 * The catalogue facets are the Connector's catalog sync, billed by Shopify
 * (split billing 2026-10-28): without shopify_catalog_sync there are no facets,
 * cached or fresh, and Shopify is never asked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); } }));

const H = vi.hoisted(() => ({ entitled: false, reads: 0, scans: 0, asked: [] as string[] }));
const FRESH = { scanned: 3, productTypes: ["Coat"], options: [], at: new Date().toISOString() };

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    isShopifyAuthorized: vi.fn(async (_t: string, cap: string) => { H.asked.push(cap); return H.entitled; }),
    prisma: {
      tenantIntegration: {
        findFirst: async () => { H.reads++; return { id: "ti1", config: { catalogFacets: FRESH } }; },
        update: async () => ({}),
      },
    },
  };
});
vi.mock("../services/connectors/integration-framework", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  executeAdapterTool: vi.fn(async () => { H.scans++; return { ok: true, result: [] }; }),
}));

import { getCatalogFacets } from "../services/shopify-facets.service";

beforeEach(() => { H.entitled = false; H.reads = 0; H.scans = 0; H.asked = []; });

describe("facets need the Connector's catalog sync", () => {
  it("not entitled: null, no cached facets read, Shopify never asked", async () => {
    expect(await getCatalogFacets("t1")).toBeNull();
    expect(H.asked).toEqual(["shopify_catalog_sync"]);
    expect([H.reads, H.scans]).toEqual([0, 0]);
  });
  it("entitled: the store is described as before", async () => {
    H.entitled = true;
    const facets = await getCatalogFacets("t1");
    expect(H.reads).toBe(1);
    expect(facets).not.toBeNull();
  });
});
