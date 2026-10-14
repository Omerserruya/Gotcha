/**
 * The business section of every tool (B3, Omer 2026-10-14): the employee page
 * groups tools by integration and, inside it, by Orders / Coupons / Customers.
 * Every catalogue action must land in a real section, never "other".
 */
import { describe, it, expect } from "vitest";
import { CATALOG_TOOL_HE } from "../lib/catalog-tools-he";
import { toolDomain, toolDomainLabel, TOOL_DOMAINS } from "../lib/tool-domains";

describe("toolDomain", () => {
  it("★ every catalogue action has a section", () => {
    const keys = Object.keys(CATALOG_TOOL_HE);
    expect(keys.length).toBeGreaterThan(160);
    const other = keys.filter((k) => {
      const [integration, slug] = k.split(":");
      return toolDomain(`${integration}.${slug}`, integration!) === "other";
    });
    expect(other).toEqual([]);
  });

  it("★ the sections an owner expects", () => {
    const d = (name: string) => toolDomain(name, name.split(".")[0]!);
    expect(d("woocommerce.get_order")).toBe("orders");
    expect(d("woocommerce.add_order_note")).toBe("orders");
    expect(d("woocommerce.create_coupon")).toBe("coupons");
    expect(d("shopify.issue_compensation_coupon")).toBe("coupons");
    expect(d("woocommerce.create_refund")).toBe("payments");
    expect(d("woocommerce.get_shipment_tracking")).toBe("shipping");
    expect(d("shopify.exchange_order_item")).toBe("returns");
    expect(d("returngo.get_transactions")).toBe("returns");
    expect(d("woocommerce.list_product_variations")).toBe("products");
    expect(d("woocommerce.search_customers")).toBe("customers");
    expect(d("hubspot.create_deal")).toBe("leads");
    expect(d("google_calendar.list_events")).toBe("calendar");
    expect(d("airtable.get_record")).toBe("records");
  });

  it("a bare integration.<slug> name is read by its slug", () => {
    expect(toolDomain("integration.get_order", "woocommerce")).toBe("orders");
  });

  it("built-ins by name, else by registry category, else other", () => {
    expect(toolDomain("send_message", null)).toBe("messaging");
    expect(toolDomain("escalate_to_human", null)).toBe("handover");
    expect(toolDomain("schedule_meeting", null)).toBe("calendar");
    expect(toolDomain("some_new_tool", null, "crm")).toBe("leads");
    expect(toolDomain("some_new_tool", null, null)).toBe("other");
  });

  it("every section has a Hebrew and an English label", () => {
    for (const d of TOOL_DOMAINS) {
      expect(toolDomainLabel(d, "he")).toBeTruthy();
      expect(toolDomainLabel(d, "en")).toBeTruthy();
    }
  });
});
