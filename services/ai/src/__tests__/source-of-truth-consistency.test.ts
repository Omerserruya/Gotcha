import { describe, it, expect, vi } from "vitest";

/**
 * Two code paths ask "does this tenant have a system of record", and they must
 * not be able to disagree.
 *
 *   getSourceOfTruth()           → null when `adapter instanceof NoOpCRMAdapter`
 *   post-conversation-crm        → skips when `adapter.capabilities.is_stub`
 *
 * Today they agree, but only by coincidence of the resolver: every vendor
 * carrying `is_stub: true` happens to instantiate NoOpCRMAdapter. Implementing
 * a real Monday or Pipedrive adapter breaks that coincidence in the most
 * damaging direction - `getSourceOfTruth` would hand back a provider that
 * advertises capabilities the vendor cannot honour, and the CRM writeback path
 * would keep skipping the same tenant. One half of the product would believe
 * the merchant has a system of record while the other half does not.
 *
 * The audit's prescription was to route post-conversation-crm through
 * getSourceOfTruth. That would have been backwards: the facade is the LOOSER
 * of the two checks, so adopting it would start "succeeding" against stub
 * adapters that write nothing. This test pins the invariant instead.
 */

vi.mock("@chatcenter/shared", () => ({
  prisma: {},
  decrypt: (v: string) => v,
  safeFetch: async () => ({ ok: false }),
}));

import {
  HubSpotCRMAdapter, SalesforceCRMAdapter, ZohoCRMAdapter,
  ShopifyCRMAdapter, FireberryCRMAdapter, AirtableCRMAdapter, NoOpCRMAdapter,
} from "../services/connectors/crm-adapter.impl";
import { DEFAULT_CAPABILITIES } from "../services/connectors/crm-adapter.types";
import type { CrmVendor } from "../services/connectors/crm-adapter.types";

/** Mirrors `instantiate()` in crm-adapter-resolver.ts. */
function instantiate(vendor: CrmVendor | null, tenantId = "t1") {
  switch (vendor) {
    case "hubspot": return new HubSpotCRMAdapter(tenantId);
    case "salesforce": return new SalesforceCRMAdapter(tenantId);
    case "zoho": return new ZohoCRMAdapter(tenantId);
    case "shopify": return new ShopifyCRMAdapter(tenantId);
    case "fireberry": return new FireberryCRMAdapter(tenantId);
    case "airtable": return new AirtableCRMAdapter(tenantId);
    default: return new NoOpCRMAdapter(tenantId);
  }
}

const VENDORS = Object.keys(DEFAULT_CAPABILITIES) as CrmVendor[];

describe("the two ways of asking 'is there a system of record'", () => {
  it("covers every vendor the catalog defines", () => {
    expect(VENDORS.length).toBeGreaterThan(5);
  });

  it("agree, vendor for vendor", () => {
    for (const vendor of VENDORS) {
      const adapter = instantiate(vendor);
      // What getSourceOfTruth() decides.
      const facadeSaysNone = adapter instanceof NoOpCRMAdapter;
      // What the post-conversation CRM path decides.
      const writebackSaysNone = adapter.capabilities.is_stub === true;
      expect(
        facadeSaysNone,
        `${vendor}: getSourceOfTruth would ${facadeSaysNone ? "refuse" : "return a provider"} ` +
          `but the CRM writeback path would ${writebackSaysNone ? "skip" : "write"}. ` +
          `Implementing a real adapter for a vendor still marked is_stub, or marking a ` +
          `real adapter as a stub, splits the product's answer in two.`,
      ).toBe(writebackSaysNone);
    }
  });

  it("treats a stub as NOT a system of record, in both directions", () => {
    // The direction that matters. A stub must never be advertised as a place
    // the merchant's data is safely written.
    for (const vendor of VENDORS) {
      if (!DEFAULT_CAPABILITIES[vendor].is_stub) continue;
      const adapter = instantiate(vendor);
      expect(adapter, `${vendor} is a stub and must not resolve to a writing adapter`)
        .toBeInstanceOf(NoOpCRMAdapter);
    }
  });

  it("a real adapter is never marked a stub", () => {
    for (const vendor of VENDORS) {
      const adapter = instantiate(vendor);
      if (adapter instanceof NoOpCRMAdapter) continue;
      expect(adapter.capabilities.is_stub ?? false, `${vendor} has a real adapter marked is_stub`)
        .toBe(false);
    }
  });
});

describe("the NoOp adapter never pretends", () => {
  it("reports failure rather than a silent success on every write", async () => {
    const noop = new NoOpCRMAdapter("t1");
    const writes = [
      noop.findCustomer({ email: "a@b.c" }),
      noop.getCustomerContext({ contact_id: "1", kind: "contact" as any }),
    ];
    for (const w of writes) {
      const r: any = await w;
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("no_crm_configured");
    }
  });
});

describe("a stub vendor must never displace a working one", () => {
  it("is not resolvable as a tenant's CRM at all", async () => {
    // The bug: step 2 of resolveFromDb matched on SLUG, and the slug list was
    // every key of SLUG_TO_VENDOR - including four vendors with no adapter.
    // `monday` is a PROJECT_MANAGEMENT integration; a Shopify merchant who
    // connected it for project work had it resolved as their CRM, ahead of the
    // Shopify fallback, and customer identity silently stopped working.
    const mod = await import("../services/connectors/crm-adapter-resolver");
    const resolvable: string[] = (mod as any).__resolvableCrmSlugs?.() ?? [];
    expect(resolvable.length, "expose __resolvableCrmSlugs for this assertion").toBeGreaterThan(0);
    for (const slug of ["monday", "pipedrive", "custom_api", "custom_db"]) {
      expect(resolvable, `${slug} has no adapter and must not be resolvable`).not.toContain(slug);
    }
  });

  it("still resolves every vendor that DOES have an adapter", async () => {
    // The fix must not be over-broad: removing a working CRM from resolution
    // would break identity for the tenants who actually use it.
    const mod = await import("../services/connectors/crm-adapter-resolver");
    const resolvable: string[] = (mod as any).__resolvableCrmSlugs();
    for (const slug of ["hubspot", "salesforce", "zoho_crm", "fireberry", "airtable"]) {
      expect(resolvable, `${slug} has a real adapter and must stay resolvable`).toContain(slug);
    }
  });
});
