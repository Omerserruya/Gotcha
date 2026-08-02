import { describe, it, expect } from "vitest";
import { productDiscoveryApplies, productToolAvailable } from "../services/discovery-integration.service";

describe("discovery activation & tool availability (deterministic)", () => {
  it("applies for sales-type roles", () => {
    expect(productDiscoveryApplies({ role: "sales", availableToolNames: [] })).toBe(true);
    expect(productDiscoveryApplies({ role: "sdr", availableToolNames: [] })).toBe(true);
    expect(productDiscoveryApplies({ role: "customer_support", availableToolNames: [] })).toBe(false);
  });
  it("applies when the product tool is offered even to non-sales", () => {
    expect(productDiscoveryApplies({ role: "customer_support", availableToolNames: ["shopify.search_products"] })).toBe(true);
  });
  it("detects the product tool in the surface (execute vs blocked)", () => {
    expect(productToolAvailable(["shopify.search_products", "shopify.get_order"]).available).toBe(true);
    expect(productToolAvailable(["shopify.get_order"]).available).toBe(false);
    // blocked path still names the canonical tool for the honest message
    expect(productToolAvailable([]).tool).toBe("shopify.search_products");
  });
});
