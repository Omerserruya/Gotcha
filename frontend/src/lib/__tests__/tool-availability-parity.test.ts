/**
 * The tool-permission rules the UI applies must agree with the server's.
 *
 * `frontend/src/lib/tool-availability-client.ts` deliberately restates
 * `packages/shared/src/lib/tool-availability.ts`, because the frontend is not
 * an npm workspace and cannot import that package at runtime. Restating a rule
 * is only safe if drift is caught - and drift here is worse than usual: the
 * screen would tell an admin a tool is available while the backend refuses it,
 * which is precisely the decorative permission screen this work exists to
 * avoid.
 *
 * The shared import works here because tests run on the host, where the root
 * node_modules symlink exists - not inside the frontend container.
 */
import { describe, it, expect } from "vitest";
import * as server from "../../../../packages/shared/src/lib/tool-availability";
import * as client from "../tool-availability-client";

// A corpus wide enough that a changed regex or reordered branch shows up.
const TOOL_NAMES = [
  "get_contact", "list_workflows", "search_products", "check_availability",
  "shopify.get_order", "hubspot.search_contacts", "lookup_customer", "preview_broadcast",
  "send_message", "create_task", "schedule_meeting", "cancel_meeting",
  "issue_refund", "process_refund", "apply_discount", "charge_card", "create_invoice",
  "refund_customer_order", "delete_contact", "remove_member", "purge_data", "revoke_token",
  "update_user_role", "create_apikey", "update_settings", "update_contact", "tag_contact",
  "integration_create_lead", "close_conversation", "escalate_to_human",
  "get_or_create_contact", "find_or_create_deal", "shopify.create_order",
  "", "   ", "x", "a.b.c", "frobnicate", "submit_suggestions",
];

describe("risk grouping agrees", () => {
  it("classifies every tool the same on both sides", () => {
    for (const name of TOOL_NAMES) {
      expect(client.riskGroupFor(name), name).toBe(server.riskGroupFor(name));
    }
  });

  it("declares the same groups in the same display order", () => {
    expect([...client.RISK_GROUPS]).toEqual([...server.RISK_GROUPS]);
  });
});

describe("policy helpers agree", () => {
  it("recommends the same default per group", () => {
    for (const g of server.RISK_GROUPS) {
      expect(client.recommendedState(g), g).toBe(server.recommendedState(g));
    }
  });

  it("locks always-allow for the same groups", () => {
    for (const g of server.RISK_GROUPS) {
      expect(client.mayBeAlwaysAllowed(g), g).toBe(server.mayBeAlwaysAllowed(g));
      expect(client.mayBeAlwaysAllowed(g, true), g).toBe(server.mayBeAlwaysAllowed(g, true));
    }
  });

  it("needs confirmation for the same bulk actions", () => {
    for (const a of ["enable_all_read_only", "require_approval_for_all_writes", "disable_all", "restore_recommended"] as const) {
      expect(client.bulkActionNeedsConfirmation(a), a).toBe(server.bulkActionNeedsConfirmation(a));
    }
  });
});

describe("availability resolution agrees", () => {
  // Every meaningful combination of the platform facts, so a reordered branch
  // (which reason wins) cannot slip through.
  const FLAGS = [undefined, true, false] as const;
  it("resolves identically across the whole input space", () => {
    let checked = 0;
    for (const name of ["issue_refund", "get_contact", "shopify.create_order"]) {
      for (const enabled of [true, false]) {
        for (const requiresApproval of [true, false]) {
          for (const planEntitled of FLAGS) {
            for (const integrationConnected of FLAGS) {
              for (const hasCatalogEntry of FLAGS) {
                for (const scopes of [undefined, [], ["write_orders"], ["write_orders", "read_orders"]]) {
                  for (const granted of [undefined, [], ["read_orders"], ["write_orders", "read_orders"]]) {
                    const input = {
                      toolName: name, enabled, requiresApproval, planEntitled,
                      integrationConnected, hasCatalogEntry,
                      requiredScopes: scopes, grantedScopes: granted,
                    };
                    expect(client.resolveToolAvailability(input), JSON.stringify(input))
                      .toEqual(server.resolveToolAvailability(input));
                    checked += 1;
                  }
                }
              }
            }
          }
        }
      }
    }
    // Guard against the loops silently collapsing to nothing.
    expect(checked).toBeGreaterThan(1000);
  });
});

describe("counting and grouping agree", () => {
  const rows = TOOL_NAMES.slice(0, 12).map((n, i) =>
    server.resolveToolAvailability({
      toolName: n,
      enabled: i % 3 !== 0,
      requiresApproval: i % 2 === 0,
      planEntitled: i % 5 === 0 ? false : undefined,
    }),
  );

  it("summarizes identically", () => {
    expect(client.summarizeTools(rows)).toEqual(server.summarizeTools(rows));
  });

  it("groups identically", () => {
    expect(client.groupByRisk(rows).map(([g, l]) => [g, l.length]))
      .toEqual(server.groupByRisk(rows).map(([g, l]) => [g, l.length]));
  });

  it("plans bulk actions identically", () => {
    const planRows = rows.map((r, i) => ({ toolName: TOOL_NAMES[i]!, riskGroup: r.riskGroup, state: r.state }));
    for (const a of ["enable_all_read_only", "require_approval_for_all_writes", "disable_all", "restore_recommended"] as const) {
      expect(client.planBulkAction(a, planRows), a).toEqual(server.planBulkAction(a, planRows));
    }
  });
});
