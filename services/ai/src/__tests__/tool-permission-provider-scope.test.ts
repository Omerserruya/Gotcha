/**
 * Tool permissions are keyed by PROVIDER, not by bare slug.
 *
 * 20 catalogue slugs are shared between providers (create_payment_link on
 * stripe AND paypal, get_order on shopify/woocommerce/paypal, ...). The PUT
 * used to strip `paypal.create_payment_link` to `create_payment_link` and look
 * up `tenantTool.findFirst({ catalogTool: { slug } })` - whichever row came
 * first. A tenant with both providers could set approval on PayPal's payment
 * links and have it written onto Stripe's row.
 *
 * The fake below evaluates `where` the way Postgres would for the fields the
 * route uses, INCLUDING the old bare-slug relation filter, and returns rows in
 * insertion order - Stripe first. So the old code picks Stripe and these tests
 * fail on it; they are not passing because the fake is forgiving.
 *
 * The GET half: every catalogue action is listed with its state, including
 * behind an ERROR connection, and a shared http slug is disambiguated.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const db = vi.hoisted(() => {
  const integrations = [
    { id: "i_stripe", slug: "stripe" },
    { id: "i_paypal", slug: "paypal" },
    { id: "i_shop", slug: "shopify" },
  ];
  const fresh = () => ({
    catalogTools: [
      { id: "ct_stripe_link", integrationId: "i_stripe", slug: "create_payment_link" },
      { id: "ct_paypal_link", integrationId: "i_paypal", slug: "create_payment_link" },
      { id: "ct_shop_cancel", integrationId: "i_shop", slug: "cancel_order" },
    ],
    tenantIntegrations: [
      { id: "ti_stripe", tenantId: "t1", integrationId: "i_stripe", status: "CONNECTED" },
      { id: "ti_paypal", tenantId: "t1", integrationId: "i_paypal", status: "CONNECTED" },
    ] as any[],
    tenantTools: [
      { id: "tt_stripe", tenantId: "t1", catalogToolId: "ct_stripe_link", configOverrides: {} },
      { id: "tt_paypal", tenantId: "t1", catalogToolId: "ct_paypal_link", configOverrides: {} },
    ] as any[],
    writes: [] as any[],
  });
  return { integrations, s: fresh(), fresh };
});

function integ(id: string) { return db.integrations.find((i) => i.id === id)!; }

/** Postgres-faithful enough: every key in `where` must hold, nested relations included. */
function matches(row: any, where: any, kind: "catalogTool" | "tenantTool" | "tenantIntegration"): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === "integration" && kind === "catalogTool") {
      if ((v as any).slug !== undefined && integ(row.integrationId).slug !== (v as any).slug) return false;
      continue;
    }
    if (k === "catalogTool" && kind === "tenantTool") {
      const ct = db.s.catalogTools.find((c) => c.id === row.catalogToolId)!;
      if (!matches(ct, v, "catalogTool")) return false;
      continue;
    }
    if (v && typeof v === "object" && "in" in (v as any)) {
      if (!(v as any).in.includes(row[k])) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}
const withIntegration = (c: any) => ({ ...c, integration: { slug: integ(c.integrationId).slug } });

vi.mock("@chatcenter/shared", async () => {
  const ta = await vi.importActual<any>("../../../../packages/shared/src/lib/tool-availability");
  return {
    riskGroupFor: ta.riskGroupFor,
    mayBeAlwaysAllowed: ta.mayBeAlwaysAllowed,
    getDefaultHighRiskTools: () => [],
    AuditAction: {},
    prisma: {
      catalogTool: {
        findFirst: async (a: any) => {
          const r = db.s.catalogTools.find((c) => matches(c, a.where, "catalogTool"));
          return r ? withIntegration(r) : null;
        },
        findMany: async (a: any) => db.s.catalogTools.filter((c) => matches(c, a.where, "catalogTool")).map(withIntegration),
      },
      tenantIntegration: {
        findFirst: async (a: any) => db.s.tenantIntegrations.find((t) => matches(t, a.where, "tenantIntegration")) ?? null,
        findMany: async (a: any) => db.s.tenantIntegrations.filter((t) => matches(t, a.where, "tenantIntegration")),
      },
      tenantTool: {
        findFirst: async (a: any) => {
          if (!a.where?.tenantId) throw new Error("tenant guard: tenantTool.findFirst without tenantId");
          return db.s.tenantTools.find((t) => matches(t, a.where, "tenantTool")) ?? null;
        },
        update: async (a: any) => {
          const row = db.s.tenantTools.find((t) => t.id === a.where.id)!;
          Object.assign(row, a.data);
          db.s.writes.push(["update", a.where.id, a.data]);
          return row;
        },
        create: async (a: any) => {
          const row = { id: `tt_new_${a.data.catalogToolId}`, ...a.data };
          db.s.tenantTools.push(row);
          db.s.writes.push(["create", row.id, a.data]);
          return row;
        },
      },
      tenantToolPermission: { findMany: async () => [], upsert: async () => ({}) },
    },
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
    writeAudit: async () => undefined,
  };
});

const governable = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock("../services/tool-registry", () => ({
  TOOL_REGISTRY: [],
  getAvailableTools: async () => ({ systemTools: [], actionTools: [], integrationTools: [] }),
  getGovernableIntegrationTools: async (_t: string, opts: any) => {
    // The list must ask for disconnected connections too.
    if (!opts?.includeDisconnected) throw new Error("permissions list must include disconnected connections");
    return governable.rows;
  },
}));

vi.mock("../services/connectors/integration-framework", () => ({
  capabilityStateFromConfig: () => ({ grantedScopes: [] }),
  missingScopesFromConfig: () => [],
  toolBlockedByMissingScopes: () => false,
}));

import toolPermissionRoutes from "../routes/tool-permissions";

const app = express();
app.use(express.json());
app.use("/api/tool-permissions", toolPermissionRoutes);
const put = (tool: string, body: any) => request(app).put(`/api/tool-permissions/${tool}`).send(body);

beforeEach(() => { db.s = db.fresh(); governable.rows = []; });

describe("PUT - a rule lands on the provider it names", () => {
  it("★ paypal.create_payment_link writes PayPal's row, never Stripe's", async () => {
    const res = await put("paypal.create_payment_link", { requiresApproval: true });
    expect(res.status).toBe(200);
    expect(db.s.writes.map((w) => w[1])).toEqual(["tt_paypal"]);
    expect(db.s.tenantTools.find((t) => t.id === "tt_stripe")!.configOverrides).toEqual({});
  });

  it("stripe.create_payment_link writes Stripe's row", async () => {
    await put("stripe.create_payment_link", { requiresApproval: true });
    expect(db.s.writes.map((w) => w[1])).toEqual(["tt_stripe"]);
  });

  it("★ a bare integration.<slug> shared by two connected providers is refused, not guessed", async () => {
    const res = await put("integration.create_payment_link", { requiresApproval: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ambiguous_tool");
    expect(res.body.candidates.sort()).toEqual(["paypal.create_payment_link", "stripe.create_payment_link"]);
    expect(db.s.writes).toEqual([]);
  });

  it("a bare integration.<slug> resolves when only one of the tenant's providers has it", async () => {
    db.s.tenantIntegrations = db.s.tenantIntegrations.filter((t) => t.id !== "ti_stripe");
    const res = await put("integration.create_payment_link", { requiresApproval: true });
    expect(res.status).toBe(200);
    expect(db.s.writes.map((w) => w[1])).toEqual(["tt_paypal"]);
  });

  it("provisions against the named provider's connection", async () => {
    db.s.tenantTools = db.s.tenantTools.filter((t) => t.id !== "tt_paypal");
    const res = await put("paypal.create_payment_link", { enabled: true, requiresApproval: true });
    expect(res.status).toBe(200);
    const created = db.s.writes.find((w) => w[0] === "create")!;
    expect(created[2]).toMatchObject({ catalogToolId: "ct_paypal_link", tenantIntegrationId: "ti_paypal" });
  });

  it("an unknown provider prefix is a 404, not a slug match on another provider", async () => {
    const res = await put("woocommerce.create_payment_link", { requiresApproval: true });
    expect(res.status).toBe(404);
    expect(db.s.writes).toEqual([]);
  });
});

describe("GET - every catalogue action, with its state", () => {
  const g = (o: any) => ({
    integrationSlug: "shopify", integrationStatus: "CONNECTED", catalogToolId: "ct",
    slug: "x", displayName: "X", description: "", catalogCategory: null, riskLevel: "LOW",
    catalogHitlMode: "never", requiredScopes: [], execution: "adapter", provisioned: true,
    tenantToolId: "tt", overrideHitlMode: null, isEnabled: true, updatedAt: null, ...o,
  });

  it("★ lists tools behind an ERROR connection, and names unprovisioned ones", async () => {
    governable.rows = [
      g({ name: "shopify.cancel_order", slug: "cancel_order", integrationStatus: "ERROR", catalogHitlMode: "always" }),
      g({ name: "shopify.process_refund", slug: "process_refund", integrationStatus: "ERROR", provisioned: false, isEnabled: false, tenantToolId: null }),
      g({ name: "shopify.add_tag", slug: "add_tag", isEnabled: false }),
    ];
    const res = await request(app).get("/api/tool-permissions");
    const by = Object.fromEntries(res.body.data.map((r: any) => [r.toolName, r]));
    expect(by["shopify.cancel_order"]).toMatchObject({ state: "enabled", integrationStatus: "ERROR", requiresApproval: true, enabled: true });
    expect(by["shopify.process_refund"]).toMatchObject({ state: "not_provisioned", enabled: false });
    expect(by["shopify.add_tag"]).toMatchObject({ state: "disabled", enabled: false });
  });

  it("★ two providers sharing an http slug get distinct names and keep their own policy", async () => {
    governable.rows = [
      g({ name: "integration.create_payment_link", integrationSlug: "stripe", slug: "create_payment_link", execution: "http", overrideHitlMode: "always" }),
      g({ name: "integration.create_payment_link", integrationSlug: "paypal", slug: "create_payment_link", execution: "http", overrideHitlMode: null }),
    ];
    const res = await request(app).get("/api/tool-permissions");
    const by = Object.fromEntries(res.body.data.map((r: any) => [r.toolName, r]));
    expect(Object.keys(by).sort()).toEqual(["paypal.create_payment_link", "stripe.create_payment_link"]);
    expect(by["stripe.create_payment_link"].requiresApproval).toBe(true);
    expect(by["paypal.create_payment_link"].requiresApproval).toBe(false);
  });

  it("an unshared http slug keeps its integration.<slug> name", async () => {
    governable.rows = [g({ name: "integration.create_payment_link", integrationSlug: "stripe", slug: "create_payment_link", execution: "http" })];
    const res = await request(app).get("/api/tool-permissions");
    expect(res.body.data.map((r: any) => r.toolName)).toEqual(["integration.create_payment_link"]);
  });
});
