import { describe, it, expect } from "vitest";
import { toolDisplayName, humanizeToolName, looksLikeRawToolId } from "../tool-display-names";

describe("a permission row never shows a machine identifier", () => {
  it("turns a raw internal id into a real name", () => {
    expect(toolDisplayName("get_conversation")).toBe("Get conversation");
    expect(toolDisplayName("list_recent_messages")).toBe("List recent messages");
    expect(toolDisplayName("get_contact")).toBe("Get contact");
  });

  it("localizes GOTCHA's own tools", () => {
    expect(toolDisplayName("get_conversation", null, "he")).toBe("שליפת שיחה");
    expect(toolDisplayName("escalate_to_human", null, "he")).toBe("העברה לנציג אנושי");
  });

  it("strips the provider prefix from a namespaced tool", () => {
    expect(humanizeToolName("shopify.get_order")).toBe("Get order");
    expect(humanizeToolName("shopify.process_refund")).toBe("Process refund");
  });

  it("keeps a provider's own human name", () => {
    expect(toolDisplayName("shopify.get_order", "List Orders")).toBe("List Orders");
  });

  it("rescues a catalog row whose name was left as a slug", () => {
    // Having *a* value is not the same as having a name. A seeded row should
    // not put get_order in front of a reader just because the column is set.
    expect(toolDisplayName("shopify.get_order", "get_order")).toBe("Get order");
  });

  it("uses sentence case, not Title Case", () => {
    // A column of Title Case labels reads as headings and competes with the
    // group heading above it.
    expect(humanizeToolName("search_customers_by_email")).toBe("Search customers by email");
  });

  it("does not mangle acronyms", () => {
    expect(humanizeToolName("update_crm")).toBe("Update CRM");
    expect(humanizeToolName("call_api")).toBe("Call API");
  });

  it("recognises what still looks like an id", () => {
    expect(looksLikeRawToolId("get_order")).toBe(true);
    expect(looksLikeRawToolId("shopify.get_order")).toBe(true);
    expect(looksLikeRawToolId("List Orders")).toBe(false);
  });

  it("never returns an empty label", () => {
    expect(toolDisplayName("x").length).toBeGreaterThan(0);
  });
});
