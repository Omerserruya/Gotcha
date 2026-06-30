import { describe, it, expect } from "vitest";
import {
  capabilityOfTool,
  groupToolsIntoCapabilities,
  renderCapabilities,
  classifyToolEffect,
  routeCopilotTool,
} from "../services/capabilities";

describe("capabilities - classifyToolEffect (Copilot decision engine)", () => {
  it("classifies safe read tools as 'read' (auto-runnable)", () => {
    for (const t of [
      "check_availability",
      "get_contact",
      "resolve_identity",
      "hubspot.search_contacts",
      "hubspot.get_contact",
      "integration.zoho_crm.search_lead",
      "list_recent_messages",
      "salesforce.describe_fields",
      "get_customer_orders",
    ]) {
      expect(classifyToolEffect(t)).toBe("read");
    }
  });

  it("classifies customer-facing / mutating tools as 'action' (recommend-only)", () => {
    for (const t of [
      "schedule_meeting",
      "reschedule_meeting",
      "cancel_meeting",
      "integration_create_lead",
      "integration_create_deal",
      "update_contact",
      "hubspot.update_contact",
      "issue_refund",
      "send_message",
      "create_task",
      "close_conversation",
      "escalate_to_human",
      "wix.create_contact",
    ]) {
      expect(classifyToolEffect(t)).toBe("action");
    }
  });

  it("is safe-biased: unknown / ambiguous names resolve to 'action'", () => {
    expect(classifyToolEffect("frobnicate_widget")).toBe("action");
    expect(classifyToolEffect("custom.do_the_thing")).toBe("action");
    expect(classifyToolEffect("")).toBe("read"); // empty/terminator is inert
  });

  it("an action verb anywhere wins over a read verb (get_or_create → action)", () => {
    expect(classifyToolEffect("get_or_create_contact")).toBe("action");
  });
});

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

describe("capabilities - routeCopilotTool (execution eligibility, single source of truth)", () => {
  it("submit_suggestions is a non-executing terminator", () => {
    const r = routeCopilotTool("submit_suggestions");
    expect(r).toEqual({ effect: "read", execute: false, executionMode: "none" });
  });

  it("READ tools auto-run in the background", () => {
    for (const t of ["check_availability", "hubspot.search_contacts", "get_contact", "list_recent_messages"]) {
      const r = routeCopilotTool(t);
      expect(r.effect).toBe("read");
      expect(r.execute).toBe(true);
      expect(r.executionMode).toBe("background");
    }
  });

  it("ACTION tools are recommend-only, never executed", () => {
    for (const t of ["schedule_meeting", "integration_create_lead", "issue_refund", "update_contact", "send_message"]) {
      const r = routeCopilotTool(t);
      expect(r.effect).toBe("action");
      expect(r.execute).toBe(false);
      expect(r.executionMode).toBe("recommended");
    }
  });

  it("is consistent with classifyToolEffect for every tool (no drift)", () => {
    for (const t of [
      "check_availability", "schedule_meeting", "reschedule_meeting", "cancel_meeting",
      "integration_create_lead", "create_task", "create_ticket", "update_contact",
      "hubspot.search_contacts", "integration_shopify.get_order", "unknown.mystery_tool",
    ]) {
      const r = routeCopilotTool(t);
      expect(r.effect).toBe(classifyToolEffect(t));
      // execute IFF read; reads run in background, actions are recommended.
      expect(r.execute).toBe(r.effect === "read");
      expect(r.executionMode).toBe(r.effect === "read" ? "background" : "recommended");
    }
  });

  it("ambiguous/unknown tools are recommend-only (safe-biased)", () => {
    const r = routeCopilotTool("frobnicate_widget");
    expect(r.effect).toBe("action");
    expect(r.executionMode).toBe("recommended");
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
