import { describe, it, expect } from "vitest";
import {
  capabilityOfTool,
  groupToolsIntoCapabilities,
  renderCapabilities,
} from "../services/capabilities";

describe("capabilities - capabilityOfTool", () => {
  it("maps booking built-ins to CALENDAR", () => {
    for (const t of ["check_availability", "schedule_meeting", "reschedule_meeting", "cancel_meeting"]) {
      expect(capabilityOfTool(t)).toBe("CALENDAR");
    }
  });

  it("maps CRM/handoff built-ins to their domains", () => {
    expect(capabilityOfTool("integration_create_lead")).toBe("CRM");
    expect(capabilityOfTool("link_customer_identifier")).toBe("CRM");
    expect(capabilityOfTool("create_task")).toBe("PROJECT_MANAGEMENT");
    expect(capabilityOfTool("escalate_to_human")).toBe("CONVERSATION");
    expect(capabilityOfTool("close_conversation")).toBe("CONVERSATION");
  });

  it("prefers an explicit integration-category hint over everything", () => {
    // An integration tool the orchestrator tagged as CRM.
    expect(capabilityOfTool("integration.hubspot.get_contact", { "integration.hubspot.get_contact": "CRM" })).toBe("CRM");
    // Hints win even for a name that also has a built-in mapping (defensive).
    expect(capabilityOfTool("create_ticket", { create_ticket: "HELPDESK" })).toBe("HELPDESK");
  });

  it("falls back to CUSTOM for dotted/integration tools with no hint, OTHER otherwise", () => {
    expect(capabilityOfTool("google_calendar.list_events")).toBe("CUSTOM");
    expect(capabilityOfTool("custom.my_tool")).toBe("CUSTOM");
    expect(capabilityOfTool("custom_db.lookup")).toBe("CUSTOM");
    expect(capabilityOfTool("some_unknown_builtin")).toBe("OTHER");
  });
});

describe("capabilities - groupToolsIntoCapabilities", () => {
  it("groups a mixed surface and shares a group between a built-in and an integration tool of the same domain", () => {
    const groups = groupToolsIntoCapabilities(
      [
        "check_availability",
        "schedule_meeting",
        "integration_create_lead",
        "integration.hubspot.get_contact", // CRM via hint
        "escalate_to_human",
      ],
      { "integration.hubspot.get_contact": "CRM" },
    );
    const byCap = Object.fromEntries(groups.map((g) => [g.capability, g.tools.map((t) => t.name)]));
    expect(byCap.CALENDAR).toEqual(["check_availability", "schedule_meeting"]);
    // Built-in CRM tool and the hinted integration CRM tool land together.
    expect(byCap.CRM).toContain("integration_create_lead");
    expect(byCap.CRM).toContain("integration.hubspot.get_contact");
    expect(byCap.CONVERSATION).toEqual(["escalate_to_human"]);
  });

  it("is deterministic: CALENDAR before CRM before CONVERSATION", () => {
    const groups = groupToolsIntoCapabilities(["escalate_to_human", "integration_create_lead", "check_availability"]);
    expect(groups.map((g) => g.capability)).toEqual(["CALENDAR", "CRM", "CONVERSATION"]);
  });

  it("is role-agnostic: a support/ecommerce surface groups with no sales assumptions", () => {
    const groups = groupToolsIntoCapabilities(
      ["create_ticket", "issue_refund", "integration.shopify.lookup_order", "escalate_to_human"],
      { "integration.shopify.lookup_order": "ECOMMERCE" },
    );
    const caps = groups.map((g) => g.capability);
    expect(caps).toContain("HELPDESK");
    expect(caps).toContain("PAYMENTS");
    expect(caps).toContain("ECOMMERCE");
    expect(caps).toContain("CONVERSATION");
    // No CALENDAR/CRM forced in.
    expect(caps).not.toContain("CALENDAR");
  });

  it("dedupes repeated tools and ignores submit_suggestions", () => {
    const groups = groupToolsIntoCapabilities(["check_availability", "check_availability", "submit_suggestions"]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tools).toHaveLength(1);
  });

  it("empty surface → no groups", () => {
    expect(groupToolsIntoCapabilities([])).toEqual([]);
  });
});

describe("capabilities - renderCapabilities", () => {
  it("renders Capability → purpose → tools, not a flat list", () => {
    const out = renderCapabilities(
      groupToolsIntoCapabilities(["check_availability", "schedule_meeting", "escalate_to_human"]),
    )!;
    expect(out).toContain("Scheduling & meetings");
    expect(out).toContain("Conversation control");
    expect(out).toContain("`check_availability`");
    expect(out).toContain("`schedule_meeting`");
    expect(out).toMatch(/think in capabilities/i);
  });

  it("null for an empty surface", () => {
    expect(renderCapabilities([])).toBeNull();
  });
});
