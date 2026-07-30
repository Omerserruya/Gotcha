/**
 * The three states must MEAN something at execution time.
 *
 * The requirement is blunt: if the UI says Autonomous the backend executes
 * autonomously, if it says HITL the backend creates an approval, if it says
 * Disabled the backend rejects. This drives the real gate
 * (`evaluateToolGate`) against real rows so the screen cannot be decorative.
 *
 * Uses a throwaway tenant + integration + catalog tool, cleaned up afterwards.
 */

// MUST come before anything that constructs the Prisma client.
import "./db-env";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, evaluateToolGate } from "@chatcenter/shared";

const RUN = `p3state-${Date.now()}`;
let tenantId = "";
let integrationId = "";
let tenantIntegrationId = "";
let catalogToolId = "";
let tenantToolId = "";
const TOOL_SLUG = `${RUN}_do_thing`;
const PROVIDER_SLUG = `${RUN}_provider`;
/**
 * The gate identifies an integration tool by NAME SHAPE - `integration_x`,
 * `integration.x`, or anything containing a dot - and adapter tools are
 * disambiguated by provider, because several providers expose the same slug
 * (get_order, refund_payment, ...). So the gate must be called with the same
 * `<provider>.<tool>` name the workspace and the bot surface use. Calling it
 * with a bare slug takes the STATIC branch instead and answers a different
 * question entirely.
 */
const GATE_NAME = `${PROVIDER_SLUG}.${TOOL_SLUG}`;

async function setOverride(mode: "always" | "never" | null, enabled = true) {
  await prisma.tenantTool.update({
    where: { id: tenantToolId },
    data: {
      isEnabled: enabled,
      configOverrides: mode ? { hitlPolicy: { mode } } : {},
    },
  });
}

describe("three-state tool policy is enforced, not decorative", () => {
  beforeAll(async () => {
    const t = await prisma.tenant.create({ data: { name: RUN, slug: RUN, status: "ACTIVE" } });
    tenantId = t.id;

    const integ = await prisma.integrationCatalog.create({
      data: {
        slug: PROVIDER_SLUG, name: "Test Provider",
        description: "policy enforcement fixture", category: "CUSTOM", authType: "API_KEY",
      },
    });
    integrationId = integ.id;

    const conn = await prisma.tenantIntegration.create({
      data: { tenantId, integrationId, status: "CONNECTED", credentials: {}, config: {} },
    });
    tenantIntegrationId = conn.id;

    const ct = await prisma.catalogTool.create({
      data: {
        integrationId, slug: TOOL_SLUG, name: "Do Thing",
        description: "mutating fixture tool",
        category: "WRITE", riskLevel: "HIGH",
        // Catalog SEED says approval. The tenant override must be able to
        // overrule it in both directions.
        hitlPolicy: { mode: "always" },
        endpoint: "POST /api/test/do-thing",
      },
    });
    catalogToolId = ct.id;

    const tt = await prisma.tenantTool.create({
      data: { tenantId, tenantIntegrationId, catalogToolId, isEnabled: true, configOverrides: {} },
    });
    tenantToolId = tt.id;
  });

  afterAll(async () => {
    await prisma.tenantTool.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenantIntegration.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.catalogTool.deleteMany({ where: { integrationId } }).catch(() => {});
    await prisma.integrationCatalog.delete({ where: { id: integrationId } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  });

  it("DISABLED rejects execution", async () => {
    await setOverride(null, false);
    const gate = await evaluateToolGate(tenantId, GATE_NAME);
    expect(gate.decision).toBe("DENY");
    expect(gate.reason).toMatch(/disabled at tenant level/i);
  });

  it("HITL requires approval", async () => {
    await setOverride("always", true);
    const gate = await evaluateToolGate(tenantId, GATE_NAME);
    expect(gate.decision).toBe("REQUIRE_APPROVAL");
  });

  it("AUTONOMOUS allows execution, overruling a stricter catalog default", async () => {
    // The catalog seed for this tool is mode:"always". An explicit tenant
    // override of "never" must win, or the UI's Autonomous choice is a lie.
    await setOverride("never", true);
    const gate = await evaluateToolGate(tenantId, GATE_NAME);
    expect(gate.decision).toBe("ALLOW");
  });

  it("with NO override, the catalog default applies", async () => {
    await setOverride(null, true);
    const gate = await evaluateToolGate(tenantId, GATE_NAME);
    // Seed is "always", so a tool nobody has configured still asks first.
    expect(gate.decision).toBe("REQUIRE_APPROVAL");
  });

  it("an UNPROVISIONED tool is denied - which is what the UI reports as disabled", async () => {
    // The workspace shows a tool with no TenantTool row as Disabled. The gate
    // must agree, otherwise "disabled" would be a screen-only claim.
    const gate = await evaluateToolGate(tenantId, `${PROVIDER_SLUG}.${RUN}_never_provisioned`);
    expect(gate.decision).toBe("DENY");
  });

  it("is tenant-scoped - another tenant's policy does not leak", async () => {
    await setOverride("never", true); // ALLOW for our tenant
    const other = await prisma.tenant.create({
      data: { name: `${RUN}-other`, slug: `${RUN}-other`, status: "ACTIVE" },
    });
    try {
      // Same tool slug, different tenant, no rows: must deny rather than
      // inherit our ALLOW.
      const gate = await evaluateToolGate(other.id, GATE_NAME);
      expect(gate.decision).toBe("DENY");
    } finally {
      await prisma.tenant.delete({ where: { id: other.id } }).catch(() => {});
    }
  });

  it("a disconnected integration denies even when policy says allow", async () => {
    await setOverride("never", true);
    await prisma.tenantIntegration.update({
      where: { id: tenantIntegrationId },
      data: { status: "DISCONNECTED" },
    });
    try {
      const gate = await evaluateToolGate(tenantId, GATE_NAME);
      // Whatever the reason string, it must not be ALLOW: the provider is gone.
      expect(gate.decision).not.toBe("ALLOW");
    } finally {
      await prisma.tenantIntegration.update({
        where: { id: tenantIntegrationId },
        data: { status: "CONNECTED" },
      });
    }
  });
});
