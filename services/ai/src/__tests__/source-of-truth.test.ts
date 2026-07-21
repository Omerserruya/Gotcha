/**
 * Source-of-Truth facade (connectors/source-of-truth.ts).
 *
 * The contract under test: capabilities are derived TRUTHFULLY from the
 * underlying CRMAdapter (capability flags AND method presence), unsupported
 * operations throw UnsupportedCapabilityError instead of simulating success,
 * and the real Shopify adapter advertises exactly what core Shopify can do
 * (no tasks, no merge - notes/fields/context yes).
 */
import { describe, it, expect } from "vitest";
import { deriveCapabilities, UnsupportedCapabilityError } from "../services/connectors/source-of-truth";
import { ShopifyCRMAdapter, FireberryCRMAdapter, HubSpotCRMAdapter } from "../services/connectors/crm-adapter.impl";
import { DEFAULT_CAPABILITIES } from "../services/connectors/crm-adapter.types";
import type { CRMAdapter } from "../services/connectors/crm-adapter.types";

const t = "tenant-1";

describe("deriveCapabilities", () => {
  it("Shopify: context + writes yes; tasks and merges are NOT advertised", () => {
    const caps = deriveCapabilities(new ShopifyCRMAdapter(t) as unknown as CRMAdapter);
    expect(caps).toEqual(expect.arrayContaining([
      "identify_customer",
      "customer_context",
      "related_business_context",
      "write_conversation_summary",
      "write_interaction",
      "update_customer_fields",
    ]));
    // Core Shopify has no task objects and no customer merge - a provider
    // claiming these would be simulating CRM features that don't exist.
    expect(caps).not.toContain("create_task");
    expect(caps).not.toContain("merge_contacts");
  });

  it("Fireberry: notes + field updates, no tasks (polling-only CRM profile)", () => {
    const caps = deriveCapabilities(new FireberryCRMAdapter(t) as unknown as CRMAdapter);
    expect(caps).toContain("write_conversation_summary");
    expect(caps).toContain("update_customer_fields");
    expect(caps).not.toContain("create_task");
  });

  it("capability flags gate method presence (task method without task_supported → no create_task)", () => {
    const fake = {
      vendor: "hubspot",
      tenantId: t,
      capabilities: { ...DEFAULT_CAPABILITIES.hubspot, task_supported: false, merge_supported: false },
      findCustomer: async () => ({ ok: true, matches: [] }),
      getCustomerContext: async () => ({ ok: true }),
      createLead: async () => ({ ok: true, kind: "contact" }),
      createNote: async () => ({ ok: true }),
      appendInteraction: async () => ({ ok: true }),
      createTask: async () => ({ ok: true }),
      mergeContacts: async () => ({ ok: true }),
    } as unknown as CRMAdapter;
    const caps = deriveCapabilities(fake);
    expect(caps).not.toContain("create_task");
    expect(caps).not.toContain("merge_contacts");
  });

  it("HubSpot advertises broader surface than Shopify where genuinely supported", () => {
    const caps = deriveCapabilities(new HubSpotCRMAdapter(t) as unknown as CRMAdapter);
    expect(caps).toContain("identify_customer");
    expect(caps).toContain("write_conversation_summary");
  });
});

describe("UnsupportedCapabilityError", () => {
  it("names the vendor and capability (actionable, not a vague denial)", () => {
    const err = new UnsupportedCapabilityError("shopify", "create_task");
    expect(err.message).toContain("shopify");
    expect(err.message).toContain("create_task");
    expect(err.capability).toBe("create_task");
  });
});
