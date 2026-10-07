/**
 * A store is a source of truth (Omer: WooCommerce by URL). Someone who
 * connected WooCommerce in 00g was forced to "skip", and the activation gate
 * counted them as having no system, because the core list held only CRMs and
 * Shopify. Wix reads orders and products too, but cannot be connected yet
 * (no catalog row / app configuration), so it is a core system without a
 * "Connect" recommendation.
 */
import { describe, it, expect, vi } from "vitest";

const DB = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      tenantIntegration: {
        findMany: async (a: any) => DB.rows.filter((r) => r.tenantId === a.where.tenantId && r.status === a.where.status && a.where.integration.slug.in.includes(r.integration.slug)),
      },
    },
  };
});

import { CORE_SYSTEM_SLUGS, connectedCoreSystem } from "../services/onboarding-state.service";
import { buildDesiredRecommendations } from "../services/recommendations.service";

const row = (slug: string, o: any = {}) => ({ tenantId: "T", status: "CONNECTED", integration: { slug }, config: {}, createdAt: new Date(), ...o });

describe("core systems", () => {
  it("★ a connected WooCommerce or Wix store is the source of truth", async () => {
    DB.rows = [row("woocommerce")];
    expect(await connectedCoreSystem("T")).toBe("woocommerce");
    DB.rows = [row("wix")];
    expect(await connectedCoreSystem("T")).toBe("wix");
    DB.rows = [row("woocommerce", { status: "ERROR" })];
    expect(await connectedCoreSystem("T")).toBeNull();
  });

  it("the one list carries both stores beside the CRMs and Shopify", () => {
    expect(CORE_SYSTEM_SLUGS).toEqual(expect.arrayContaining(["woocommerce", "wix", "shopify", "hubspot"]));
  });

  it("WooCommerce gets a Connect recommendation; Wix only an acknowledgement (no dead button)", () => {
    const recs = buildDesiredRecommendations({ recommendation: { employeeRole: "customer_support", systems: [{ slug: "woocommerce", alreadyDetected: true }, { slug: "wix", alreadyDetected: true }] } });
    expect(recs.find((r: any) => r.dedupeKey === "connect:woocommerce")).toMatchObject({ kind: "connect_system" });
    expect(recs.some((r: any) => r.dedupeKey === "connect:wix")).toBe(false);
    expect(recs.find((r: any) => String(r.dedupeKey).includes("wix"))).toMatchObject({ kind: "tool_detected" });
  });
});
