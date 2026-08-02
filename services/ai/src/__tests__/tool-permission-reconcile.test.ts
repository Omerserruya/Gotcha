import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * reconcileAgentToolPermissions - grants existing ACTIVE employees the READ
 * tools of a newly-connected integration, per role, additively and WRITE-safe.
 *
 * The DB is an in-memory fixture: a Shopify connection with a mix of READ and
 * WRITE catalog tools, and two ACTIVE employees (sales + support) plus one
 * DRAFT and one other-tenant employee that must never be touched.
 */

// ─── In-memory fixture ──────────────────────────────────────────────────────
const CATALOG_ID = "cat_shopify";
const TENANT = "tenant-A";
const OTHER_TENANT = "tenant-B";
const TI_ID = "ti_shopify_A";

// tenant tools: slug -> { id, category }
const TENANT_TOOLS = [
  { id: "tt_search_products", slug: "search_products", category: "READ" },
  { id: "tt_get_product", slug: "get_product", category: "READ" },
  { id: "tt_get_orders", slug: "get_orders", category: "READ" },
  { id: "tt_cancel_order", slug: "cancel_order", category: "ACTION" },
  { id: "tt_process_refund", slug: "process_refund", category: "WRITE" },
];

// Mutable permission store (rows of {aiAgentId, tenantToolId, tenantId, isAllowed})
let permStore: Array<{ aiAgentId: string; tenantToolId: string; tenantId: string; isAllowed: boolean }> = [];

const AGENTS = [
  { id: "agent_sales", tenantId: TENANT, role: "sales", status: "ACTIVE" },
  { id: "agent_support", tenantId: TENANT, role: "customer_support", status: "ACTIVE" },
  { id: "agent_draft", tenantId: TENANT, role: "sales", status: "DRAFT" },
  { id: "agent_other", tenantId: OTHER_TENANT, role: "sales", status: "ACTIVE" },
];

const prismaMock = {
  integrationCatalog: {
    findUnique: vi.fn(async ({ where }: any) =>
      where.slug === "shopify" ? { id: CATALOG_ID } : null,
    ),
  },
  tenantIntegration: {
    findUnique: vi.fn(async ({ where }: any) => {
      const { tenantId, integrationId } = where.tenantId_integrationId;
      if (tenantId === TENANT && integrationId === CATALOG_ID) {
        return { id: TI_ID, status: "CONNECTED" };
      }
      return null;
    }),
  },
  tenantTool: {
    findMany: vi.fn(async ({ where }: any) => {
      if (where.tenantId !== TENANT || where.tenantIntegrationId !== TI_ID) return [];
      return TENANT_TOOLS.filter((t) => where.isEnabled === undefined || where.isEnabled).map((t) => ({
        id: t.id,
        catalogTool: { slug: t.slug, category: t.category },
      }));
    }),
  },
  aIAgent: {
    findMany: vi.fn(async ({ where }: any) =>
      AGENTS.filter((a) => a.tenantId === where.tenantId && a.status === where.status).map((a) => ({
        id: a.id,
        role: a.role,
      })),
    ),
  },
  agentToolPermission: {
    findMany: vi.fn(async ({ where }: any) => {
      const ids: string[] = where.aiAgentId?.in ?? [];
      const ttIds: string[] = where.tenantToolId?.in ?? [];
      return permStore.filter(
        (p) =>
          p.tenantId === where.tenantId &&
          ids.includes(p.aiAgentId) &&
          ttIds.includes(p.tenantToolId),
      );
    }),
    createMany: vi.fn(async ({ data }: any) => {
      let count = 0;
      for (const row of data) {
        const dup = permStore.some(
          (p) => p.aiAgentId === row.aiAgentId && p.tenantToolId === row.tenantToolId,
        );
        if (dup) continue;
        permStore.push(row);
        count++;
      }
      return { count };
    }),
  },
};

vi.mock("@chatcenter/shared", () => ({ prisma: prismaMock }));

const load = () => import("../services/tool-permission-reconcile.service");

beforeEach(() => {
  permStore = [];
  vi.clearAllMocks();
});

describe("reconcileAgentToolPermissions", () => {
  it("grants a sales employee search_products/get_product after reconcile", async () => {
    const { reconcileAgentToolPermissions } = await load();
    const r = await reconcileAgentToolPermissions({ tenantId: TENANT, integrationSlug: "shopify" });

    const salesAdds = r.added.filter((a) => a.agent === "agent_sales").map((a) => a.slug);
    expect(salesAdds).toContain("search_products");
    expect(salesAdds).toContain("get_product");
    expect(salesAdds).toContain("get_orders");

    // Persisted as isAllowed=true rows for the sales agent.
    const salesRows = permStore.filter((p) => p.aiAgentId === "agent_sales");
    expect(salesRows.every((p) => p.isAllowed === true)).toBe(true);
    expect(salesRows.length).toBe(salesAdds.length);
  });

  it("preserves an existing permission (no duplicate, no flip)", async () => {
    // Pre-seed the sales agent's search_products grant.
    permStore.push({
      aiAgentId: "agent_sales",
      tenantToolId: "tt_search_products",
      tenantId: TENANT,
      isAllowed: true,
    });
    const { reconcileAgentToolPermissions } = await load();
    const r = await reconcileAgentToolPermissions({ tenantId: TENANT, integrationSlug: "shopify" });

    // Not re-added.
    expect(r.added.find((a) => a.agent === "agent_sales" && a.slug === "search_products")).toBeUndefined();
    expect(r.preservedExisting).toBeGreaterThanOrEqual(1);

    // Exactly one search_products row for the sales agent (no duplicate).
    const rows = permStore.filter(
      (p) => p.aiAgentId === "agent_sales" && p.tenantToolId === "tt_search_products",
    );
    expect(rows.length).toBe(1);
  });

  it("NEVER auto-adds WRITE/ACTION tools (cancel_order/process_refund)", async () => {
    const { reconcileAgentToolPermissions } = await load();
    const r = await reconcileAgentToolPermissions({ tenantId: TENANT, integrationSlug: "shopify" });

    expect(r.added.map((a) => a.slug)).not.toContain("cancel_order");
    expect(r.added.map((a) => a.slug)).not.toContain("process_refund");
    expect(r.skippedWriteTools).toEqual(expect.arrayContaining(["cancel_order", "process_refund"]));

    // No write-tool rows persisted for anyone.
    const writeToolIds = ["tt_cancel_order", "tt_process_refund"];
    expect(permStore.some((p) => writeToolIds.includes(p.tenantToolId))).toBe(false);
  });

  it("customer_support does NOT get product tools (support policy: orders only)", async () => {
    const { reconcileAgentToolPermissions } = await load();
    const r = await reconcileAgentToolPermissions({ tenantId: TENANT, integrationSlug: "shopify" });

    const supportAdds = r.added.filter((a) => a.agent === "agent_support").map((a) => a.slug);
    // Support gets order READ tools...
    expect(supportAdds).toContain("get_orders");
    // ...but NOT the product-catalog tools reserved for sales.
    expect(supportAdds).not.toContain("search_products");
    expect(supportAdds).not.toContain("get_product");
  });

  it("tenant isolation: only the target tenant's ACTIVE employees are touched", async () => {
    const { reconcileAgentToolPermissions } = await load();
    const r = await reconcileAgentToolPermissions({ tenantId: TENANT, integrationSlug: "shopify" });

    // Other-tenant + DRAFT employees never appear.
    expect(r.added.some((a) => a.agent === "agent_other")).toBe(false);
    expect(r.added.some((a) => a.agent === "agent_draft")).toBe(false);
    expect(permStore.some((p) => p.aiAgentId === "agent_other")).toBe(false);
    expect(permStore.some((p) => p.aiAgentId === "agent_draft")).toBe(false);
  });

  it("idempotent: a second reconcile adds nothing", async () => {
    const { reconcileAgentToolPermissions } = await load();
    await reconcileAgentToolPermissions({ tenantId: TENANT, integrationSlug: "shopify" });
    const before = permStore.length;
    const r2 = await reconcileAgentToolPermissions({ tenantId: TENANT, integrationSlug: "shopify" });
    expect(r2.added.length).toBe(0);
    expect(permStore.length).toBe(before);
    expect(r2.preservedExisting).toBeGreaterThan(0);
  });

  it("no-op when the integration is not CONNECTED", async () => {
    prismaMock.tenantIntegration.findUnique.mockResolvedValueOnce({ id: TI_ID, status: "PENDING" });
    const { reconcileAgentToolPermissions } = await load();
    const r = await reconcileAgentToolPermissions({ tenantId: TENANT, integrationSlug: "shopify" });
    expect(r.added).toEqual([]);
    expect(permStore.length).toBe(0);
  });
});
