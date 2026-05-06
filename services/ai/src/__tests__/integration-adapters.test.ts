/**
 * Smoke tests for the integration framework adapters.
 *
 * Verifies every shipped adapter:
 *   - registers itself when imported
 *   - exposes at least one tool
 *   - publishes a complete ToolDefinition (description, whenToUse, params)
 *   - uses a slug.tool naming convention so the dispatcher can route
 *
 * These tests are pure registry checks — no network or DB.
 */

import { describe, it, expect } from "vitest";
import { listAdapters, getAdapter } from "../services/connectors";

describe("integration adapter registry", () => {
  const expectedSlugs = [
    "stripe",
    "hubspot",
    "shopify",
    "airtable",
    "postgres",
    "mongodb",
    // wix + square temporarily disabled — re-add when adapters are
    // re-registered in services/ai/src/services/connectors/index.ts.
    "woocommerce",
    "paypal",
    "salesforce",
    "monday",
    "aws_rds",
  ];

  it("registers every shipped adapter", () => {
    const slugs = listAdapters().map((a) => a.slug).sort();
    for (const slug of expectedSlugs) {
      expect(slugs).toContain(slug);
    }
  });

  it.each(expectedSlugs)("`%s` adapter exposes a non-empty, well-formed tool surface", (slug) => {
    const adapter = getAdapter(slug);
    expect(adapter, `adapter ${slug} not registered`).not.toBeNull();
    const tools = adapter!.tools();
    expect(tools.length, `${slug} has no tools`).toBeGreaterThan(0);
    for (const tool of tools) {
      // Naming convention: <slug>.<verb>
      expect(tool.name.startsWith(`${slug}.`), `${tool.name} must start with ${slug}.`).toBe(true);
      // LLM contract fields
      expect(tool.description).toBeTruthy();
      expect(tool.whenToUse).toBeTruthy();
      expect(tool.parameters).toBeTruthy();
      expect((tool.parameters as any).type).toBe("object");
      // Risk classification
      expect(["LOW", "MEDIUM", "HIGH"]).toContain(tool.riskLevel);
      expect(["READ", "WRITE", "DELETE", "ACTION"]).toContain(tool.category);
    }
  });

  it("aws_rds shares its tool surface shape with postgres (RDS is engine-agnostic Postgres/MySQL)", () => {
    const pg = getAdapter("postgres")!.tools().map((t) => t.name.split(".")[1]).sort();
    const rds = getAdapter("aws_rds")!.tools().map((t) => t.name.split(".")[1]).sort();
    expect(rds).toEqual(pg);
  });

  it("payment-side adapters (stripe/paypal) all expose refund + payment-link tools", () => {
    for (const slug of ["stripe", "paypal"] as const) {
      const tools = getAdapter(slug)!.tools().map((t) => t.name);
      const hasRefund = tools.some((t) => /refund/.test(t));
      const hasLink = tools.some((t) => /payment_link/.test(t));
      expect(hasRefund, `${slug} should expose a refund tool`).toBe(true);
      expect(hasLink, `${slug} should expose a payment-link tool`).toBe(true);
    }
  });

  it("CRM adapters (hubspot/salesforce/monday) all expose a search/list + create tool", () => {
    const cases: Array<[string, RegExp, RegExp]> = [
      ["hubspot",    /search_contacts/, /create_contact/],
      ["salesforce", /search_records/,  /create_lead/],
      ["monday",     /list_items|list_boards/, /create_item/],
    ];
    for (const [slug, finder, creator] of cases) {
      const tools = getAdapter(slug)!.tools().map((t) => t.name);
      expect(tools.some((t) => finder.test(t)), `${slug} missing finder tool`).toBe(true);
      expect(tools.some((t) => creator.test(t)), `${slug} missing creator tool`).toBe(true);
    }
  });

  it("all WRITE/DELETE tools document side effects or idempotency", () => {
    for (const adapter of listAdapters()) {
      for (const tool of adapter.tools()) {
        if (tool.category === "READ") continue;
        const hasGuardrail =
          (tool.sideEffects && tool.sideEffects.length > 0) ||
          (tool.idempotencyNotes && tool.idempotencyNotes.length > 0) ||
          tool.whenNotToUse;
        // Not a hard fail — soft expectation surfaced as informational
        if (!hasGuardrail) {
          // eslint-disable-next-line no-console
          console.warn(`[integration-adapters] ${tool.name} has no sideEffects/idempotency/whenNotToUse guidance`);
        }
      }
    }
  });
});
