/**
 * A green connection must never again conceal a tool-less assistant.
 *
 * During the incident every signal the product had said yes:
 *
 *   connection status   CONNECTED
 *   capability probe    green
 *   granted scopes      all present
 *   assistant           42 read tools, zero write, zero action
 *
 * Each check asked about the CONNECTION; none asked what the assistant could
 * do. The reads even answered every diagnostic convincingly - you can look up
 * any order right up until you try to cancel one.
 *
 * The distinction these tests care most about is UNAVAILABLE versus DISABLED.
 * They look identical from the assistant's side and mean opposite things to
 * whoever is fixing it: one is a fault, the other is a decision.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock: any = vi.hoisted(() => ({
  integrationCatalog: { findUnique: undefined as any },
  tenantIntegration: { findUnique: undefined as any },
  catalogTool: { findMany: undefined as any },
  tenantTool: { findMany: undefined as any },
}));
vi.mock("@chatcenter/shared", () => ({
  prisma: prismaMock,
  decryptCredentials: (blob: string) => {
    if (blob === "corrupt") throw new Error("bad key");
    return { accessToken: "shpat_secret" };
  },
}));

import { assessIntegrationHealth } from "../services/integration-health.service";

const CATALOG_TOOLS = [
  ...Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, slug: `read_${i}`, category: "READ" })),
  ...Array.from({ length: 2 }, (_, i) => ({ id: `w${i}`, slug: `write_${i}`, category: "WRITE" })),
  { id: "a0", slug: "process_refund", category: "ACTION" },
  { id: "a1", slug: "cancel_order", category: "ACTION" },
];

function tenantTools(ids: string[], opts: { disabled?: string[]; hitl?: string[] } = {}) {
  return ids.map((catalogToolId) => ({
    id: `tt_${catalogToolId}`,
    catalogToolId,
    isEnabled: !(opts.disabled ?? []).includes(catalogToolId),
    configOverrides: (opts.hitl ?? []).includes(catalogToolId) ? { hitlPolicy: { mode: "always" } } : {},
  }));
}

function setup(over: {
  connection?: any;
  tools?: any[];
} = {}) {
  prismaMock.integrationCatalog.findUnique = vi.fn(async () => ({ id: "cat_shopify", slug: "shopify" }));
  prismaMock.tenantIntegration.findUnique = vi.fn(async () =>
    over.connection === null ? null : { id: "ti1", status: "CONNECTED", credentials: "blob", config: {}, connectedAt: new Date(), disconnectedAt: null, ...over.connection },
  );
  prismaMock.catalogTool.findMany = vi.fn(async () => CATALOG_TOOLS);
  prismaMock.tenantTool.findMany = vi.fn(async () => over.tools ?? tenantTools(CATALOG_TOOLS.map((t) => t.id)));
}

beforeEach(() => setup());

describe("the state that was invisible", () => {
  it("THE incident: reads present, writes and actions missing", async () => {
    setup({ tools: tenantTools(["r0", "r1", "r2"]) });
    const h = await assessIntegrationHealth("t1", "shopify");
    expect(h.status).toBe("CONNECTED_BUT_UNPROVISIONED");
    expect(h.tools.total.provisioned).toBe(3);
    expect(h.tools.total.missing).toBe(4);
    expect(h.tools.byCategory.WRITE.missing).toBe(2);
    expect(h.tools.byCategory.ACTION.missing).toBe(2);
    expect(h.summary).toContain("WRITE 2");
    expect(h.remediation).toContain("reprovision_missing_tools");
  });

  it("connected with NO tools at all is named, not merely unhealthy", async () => {
    setup({ tools: [] });
    const h = await assessIntegrationHealth("t1", "shopify");
    expect(h.status).toBe("CONNECTED_BUT_UNPROVISIONED");
    expect(h.summary).toContain("A green connection is not evidence");
  });

  it("a fully provisioned, fully enabled integration is HEALTHY", async () => {
    const h = await assessIntegrationHealth("t1", "shopify");
    expect(h.status).toBe("HEALTHY");
    expect(h.tools.total.missing).toBe(0);
    expect(h.tools.total.enabledByPolicy).toBe(7);
  });
});

describe("a decision is not a fault", () => {
  it("a tool the tenant turned off is PARTIALLY_AVAILABLE, and named", async () => {
    setup({ tools: tenantTools(CATALOG_TOOLS.map((t) => t.id), { disabled: ["a0"] }) });
    const h = await assessIntegrationHealth("t1", "shopify");
    expect(h.status).toBe("PARTIALLY_AVAILABLE");
    expect(h.disabledTools).toContain("process_refund");
    expect(h.tools.total.explicitlyDisabled).toBe(1);
    expect(h.summary).toContain("a decision, not a fault");
  });

  it("disabled and missing are different numbers", async () => {
    setup({ tools: tenantTools(["r0", "r1", "r2", "w0", "w1", "a0"], { disabled: ["a0"] }) });
    const h = await assessIntegrationHealth("t1", "shopify");
    expect(h.tools.total.explicitlyDisabled).toBe(1); // operator turned it off
    expect(h.tools.total.missing).toBe(1);            // never provisioned
  });

  it("everything disabled is POLICY_MISSING, not a connection problem", async () => {
    setup({ tools: tenantTools(CATALOG_TOOLS.map((t) => t.id), { disabled: CATALOG_TOOLS.map((t) => t.id) }) });
    const h = await assessIntegrationHealth("t1", "shopify");
    expect(h.status).toBe("POLICY_MISSING");
    expect(h.remediation).toContain("inspect_disabled_tools");
  });

  it("reports which tools carry an explicit HITL policy", async () => {
    setup({ tools: tenantTools(CATALOG_TOOLS.map((t) => t.id), { hitl: ["a1"] }) });
    const h = await assessIntegrationHealth("t1", "shopify");
    expect(h.hitlTools).toContain("cancel_order");
  });
});

describe("connection and credential layers", () => {
  it("a disconnected integration reports the policy it is holding for reconnect", async () => {
    setup({ connection: { status: "DISCONNECTED", credentials: {}, disconnectedAt: new Date() },
            tools: tenantTools(CATALOG_TOOLS.map((t) => t.id), { disabled: ["a0"] }) });
    const h = await assessIntegrationHealth("t1", "shopify");
    expect(h.status).toBe("DISCONNECTED");
    expect(h.summary).toContain("preserved and will be restored on reconnect");
    expect(h.summary).toContain("1 the tenant turned off");
  });

  it("CONNECTED with no credentials is REAUTH_REQUIRED", async () => {
    setup({ connection: { credentials: {} } });
    const h = await assessIntegrationHealth("t1", "shopify");
    expect(h.status).toBe("REAUTH_REQUIRED");
  });

  it("credentials that will not decrypt are CREDENTIAL_ERROR", async () => {
    setup({ connection: { credentials: "corrupt" } });
    const h = await assessIntegrationHealth("t1", "shopify");
    expect(h.status).toBe("CREDENTIAL_ERROR");
    expect(h.credentials).toEqual({ present: true, decryptable: false });
  });

  it("missing scopes do not read as missing policy", async () => {
    setup({ connection: { config: { missingScopes: ["write_orders"] } } });
    const h = await assessIntegrationHealth("t1", "shopify");
    expect(h.status).toBe("MISSING_SCOPES");
    expect(h.summary).toContain("policy is intact");
  });

  it("an unconnected integration says so plainly", async () => {
    setup({ connection: null });
    const h = await assessIntegrationHealth("t1", "shopify");
    expect(h.status).toBe("NOT_CONNECTED");
  });
});

describe("health output is safe to look at", () => {
  it("never returns credential material, only whether it decrypts", async () => {
    const h = await assessIntegrationHealth("t1", "shopify");
    const serialised = JSON.stringify(h);
    expect(serialised).not.toContain("shpat_");
    expect(serialised).not.toContain("accessToken");
    expect(h.credentials).toEqual({ present: true, decryptable: true });
  });

  it("is read-only - a diagnostic must not repair what it is describing", async () => {
    setup({ tools: tenantTools(["r0"]) });
    await assessIntegrationHealth("t1", "shopify");
    // Nothing on the mock can write; the assertion is that none was needed.
    expect(prismaMock.tenantTool.findMany).toHaveBeenCalled();
    expect((prismaMock.tenantTool as any).createMany).toBeUndefined();
    expect((prismaMock.tenantTool as any).update).toBeUndefined();
  });

  it("scopes only this tenant's connection", async () => {
    await assessIntegrationHealth("t9", "shopify");
    expect(prismaMock.tenantTool.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t9" });
  });
});
