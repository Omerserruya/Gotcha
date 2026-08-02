import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@chatcenter/shared";

/**
 * The tool audit log must outlive the things it describes.
 *
 * Disconnecting an integration deletes the tenant's `tenant_tools` rows
 * (routes/integrations.ts does this explicitly, and the TenantIntegration
 * cascade would anyway). Under the old `ON DELETE CASCADE` that took
 * `tool_executions` with it: a merchant clicking "Disconnect" erased every
 * record of what the AI had done through that integration, and reconnecting
 * did not bring it back. CLAUDE.md requires every AI action to stay traceable;
 * an audit trail a normal UI action can delete is not one.
 *
 * Exercised against the real database rather than a mock, because the thing
 * under test IS a database constraint - a mocked prisma would happily "pass"
 * with the old CASCADE still in place.
 */

const DB = !!process.env.DATABASE_URL;
const d = DB ? describe : describe.skip;

const ids = {
  tenant: `t_audit_${Date.now()}`,
  catalog: "",
  catalogTool: "",
  tenantIntegration: "",
  tenantTool: "",
};

d("a disconnect must not erase what the AI did", () => {
  beforeAll(async () => {
    await prisma.tenant.create({
      data: { id: ids.tenant, name: ids.tenant, slug: ids.tenant, status: "ACTIVE" as any },
    });
    const cat = await prisma.integrationCatalog.create({
      data: {
        slug: `audit_fixture_${Date.now()}`, name: "Audit Fixture",
        description: "audit retention fixture",
        category: "CUSTOM" as any, authType: "API_KEY" as any, isPublished: false,
      },
    });
    ids.catalog = cat.id;
    const ct = await prisma.catalogTool.create({
      data: {
        integrationId: cat.id, slug: "do_thing", name: "Do Thing",
        description: "audit fixture tool",
        endpoint: "POST /api/test/do-thing",
      },
    });
    ids.catalogTool = ct.id;
    const ti = await prisma.tenantIntegration.create({
      data: { tenantId: ids.tenant, integrationId: cat.id, status: "CONNECTED" as any },
    });
    ids.tenantIntegration = ti.id;
    const tt = await prisma.tenantTool.create({
      data: {
        tenantId: ids.tenant, tenantIntegrationId: ti.id,
        catalogToolId: ct.id, isEnabled: true,
      },
    });
    ids.tenantTool = tt.id;
  });

  afterAll(async () => {
    await prisma.toolExecution.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
    await prisma.tenantTool.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
    await prisma.tenantIntegration.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
    await prisma.catalogTool.deleteMany({ where: { integrationId: ids.catalog } }).catch(() => {});
    await prisma.integrationCatalog.delete({ where: { id: ids.catalog } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  });

  it("keeps the execution record when the tenant tool is deleted", async () => {
    const exec = await prisma.toolExecution.create({
      data: {
        tenantId: ids.tenant, conversationId: "conv_audit_1",
        tenantToolId: ids.tenantTool, toolName: "Do Thing",
        input: { a: 1 }, output: { ok: true }, success: true, triggeredBy: "ai",
      },
    });

    // Exactly what "Disconnect" does.
    await prisma.tenantTool.deleteMany({ where: { tenantId: ids.tenant } });

    const after = await prisma.toolExecution.findUnique({ where: { id: exec.id } });
    expect(after, "the audit record must survive a disconnect").not.toBeNull();
    expect(after!.tenantToolId, "the broken link is nulled, not the row deleted").toBeNull();
  });

  it("the surviving record can still say WHAT ran", async () => {
    // A row that outlives its tool but cannot name it is not much of an audit
    // record. This is why toolName is denormalised rather than joined.
    const rows = await prisma.toolExecution.findMany({ where: { tenantId: ids.tenant } });
    expect(rows).toHaveLength(1);
    expect(rows[0].toolName).toBe("Do Thing");
    expect(rows[0].tenantId).toBe(ids.tenant);
    expect(rows[0].conversationId).toBe("conv_audit_1");
    expect(rows[0].success).toBe(true);
  });
});

d("the platform catalog cannot reach into tenant data", () => {
  const t2 = { tenant: `t_restrict_${Date.now()}`, catalog: "", catalogTool: "", ti: "", tt: "" };

  beforeAll(async () => {
    await prisma.tenant.create({ data: { id: t2.tenant, name: t2.tenant, slug: t2.tenant, status: "ACTIVE" as any } });
    const cat = await prisma.integrationCatalog.create({
      data: {
        slug: `restrict_fixture_${Date.now()}`, name: "Restrict Fixture",
        description: "cascade restrict fixture",
        category: "CUSTOM" as any, authType: "API_KEY" as any, isPublished: false,
      },
    });
    t2.catalog = cat.id;
    const ct = await prisma.catalogTool.create({
      data: { integrationId: cat.id, slug: "thing", name: "Thing", description: "restrict fixture tool", endpoint: "POST /x" },
    });
    t2.catalogTool = ct.id;
    const ti = await prisma.tenantIntegration.create({
      data: { tenantId: t2.tenant, integrationId: cat.id, status: "CONNECTED" as any },
    });
    t2.ti = ti.id;
    const tt = await prisma.tenantTool.create({
      data: { tenantId: t2.tenant, tenantIntegrationId: ti.id, catalogToolId: ct.id, isEnabled: true },
    });
    t2.tt = tt.id;
  });

  afterAll(async () => {
    await prisma.tenantTool.deleteMany({ where: { tenantId: t2.tenant } }).catch(() => {});
    await prisma.tenantIntegration.deleteMany({ where: { tenantId: t2.tenant } }).catch(() => {});
    await prisma.catalogTool.deleteMany({ where: { integrationId: t2.catalog } }).catch(() => {});
    await prisma.integrationCatalog.delete({ where: { id: t2.catalog } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: t2.tenant } }).catch(() => {});
  });

  it("refuses to delete a catalog entry a tenant is connected to", async () => {
    // Before: this deleted the tenant's connection AND their stored
    // credentials, silently, as a side effect of tidying the catalog.
    await expect(
      prisma.integrationCatalog.delete({ where: { id: t2.catalog } }),
    ).rejects.toThrow();

    const still = await prisma.tenantIntegration.findUnique({ where: { id: t2.ti } });
    expect(still, "the tenant's connection must still be there").not.toBeNull();
  });

  it("refuses to delete a catalog tool a tenant has activated", async () => {
    await expect(
      prisma.catalogTool.delete({ where: { id: t2.catalogTool } }),
    ).rejects.toThrow();

    const still = await prisma.tenantTool.findUnique({ where: { id: t2.tt } });
    expect(still).not.toBeNull();
  });

  it("still lets a TENANT disconnect - that cascade is theirs to trigger", async () => {
    // The fix must not make the product rigid. Deleting a tenant's OWN
    // integration should still retire their activations: that side of the
    // boundary is theirs, and Restrict there would strand them.
    const before = await prisma.tenantTool.findMany({ where: { tenantId: t2.tenant, tenantIntegrationId: t2.ti } });
    expect(before.length, "fixture should have an activation to retire").toBeGreaterThan(0);

    await prisma.tenantIntegration.delete({ where: { id: t2.ti } });

    const after = await prisma.tenantTool.findMany({ where: { tenantId: t2.tenant, tenantIntegrationId: t2.ti } });
    expect(after, "the tenant's own delete still cascades").toHaveLength(0);
  });
});
