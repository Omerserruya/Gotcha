import { describe, it, expect } from "vitest";
import {
  riskGroupFor,
  mayBeAlwaysAllowed,
  recommendedState,
  resolveToolAvailability,
  summarizeTools,
  groupByRisk,
  planBulkAction,
  bulkActionNeedsConfirmation,
  RISK_GROUPS,
  type ToolAvailability,
} from "../tool-availability";

describe("riskGroupFor", () => {
  it("puts reads in read_only even when they touch sensitive data", () => {
    // A lookup of a customer is still a lookup. Filing it under "sensitive"
    // would push harmless tools into a scary group and teach people to ignore
    // the grouping entirely.
    for (const t of ["get_contact", "search_products", "lookup_customer", "shopify.get_order"]) {
      expect(riskGroupFor(t), t).toBe("read_only");
    }
  });

  it("separates money from everything else", () => {
    for (const t of ["issue_refund", "process_refund", "apply_discount", "charge_card", "create_invoice"]) {
      expect(riskGroupFor(t), t).toBe("financial");
    }
  });

  it("groups deletes on their own", () => {
    for (const t of ["delete_contact", "remove_member", "purge_data", "revoke_token"]) {
      expect(riskGroupFor(t), t).toBe("delete");
    }
  });

  it("recognises administrative surface", () => {
    for (const t of ["update_user_role", "create_apikey", "update_settings"]) {
      expect(riskGroupFor(t), t).toBe("administrative");
    }
  });

  it("puts customer-data writes under sensitive_data", () => {
    expect(riskGroupFor("update_contact")).toBe("sensitive_data");
    expect(riskGroupFor("tag_contact")).toBe("sensitive_data");
  });

  it("falls back to create_update for an ordinary write", () => {
    expect(riskGroupFor("send_message")).toBe("create_update");
    expect(riskGroupFor("create_task")).toBe("create_update");
  });

  it("prefers financial over the other write groups", () => {
    // Matches both "customer" and "refund"; the operator needs to see it as money.
    expect(riskGroupFor("refund_customer_order")).toBe("financial");
  });

  it("never throws on junk", () => {
    for (const t of ["", "   ", "x", "..", "a.b.c"]) {
      expect(RISK_GROUPS).toContain(riskGroupFor(t));
    }
  });
});

describe("recommended defaults", () => {
  it("auto-approves reads and requires approval for everything else", () => {
    expect(recommendedState("read_only")).toBe("always_allow");
    for (const g of ["create_update", "delete", "financial", "sensitive_data", "administrative"] as const) {
      expect(recommendedState(g), g).toBe("require_approval");
    }
  });

  it("refuses always-allow for irreversible and money-moving groups by default", () => {
    for (const g of ["delete", "financial", "administrative"] as const) {
      expect(mayBeAlwaysAllowed(g), g).toBe(false);
      // A product decision can permit it, explicitly.
      expect(mayBeAlwaysAllowed(g, true), g).toBe(true);
    }
    expect(mayBeAlwaysAllowed("read_only")).toBe(true);
    expect(mayBeAlwaysAllowed("create_update")).toBe(true);
  });
});

describe("resolveToolAvailability - never call a platform block a user choice", () => {
  const base = { toolName: "shopify.create_order", enabled: true, requiresApproval: true };

  it("reports the admin's own setting when nothing blocks the tool", () => {
    expect(resolveToolAvailability({ ...base }).state).toBe("require_approval");
    expect(resolveToolAvailability({ ...base, requiresApproval: false }).state).toBe("always_allow");
    const off = resolveToolAvailability({ ...base, enabled: false });
    expect(off.state).toBe("disabled");
    expect(off.reason).toBe("ok");
    expect(off.overriddenByPlatform).toBe(false);
  });

  it("distinguishes a plan gap from a user toggle", () => {
    const r = resolveToolAvailability({ ...base, planEntitled: false });
    expect(r.state).toBe("unavailable");
    expect(r.reason).toBe("plan_not_entitled");
    expect(r.overriddenByPlatform).toBe(true);
  });

  it("distinguishes a disconnected integration", () => {
    const r = resolveToolAvailability({ ...base, integrationConnected: false });
    expect(r.reason).toBe("integration_disconnected");
  });

  it("distinguishes a missing provider scope, and names the missing ones", () => {
    const r = resolveToolAvailability({
      ...base,
      requiredScopes: ["write_orders", "read_orders"],
      grantedScopes: ["read_orders"],
    });
    expect(r.state).toBe("unavailable");
    expect(r.reason).toBe("missing_scope");
    expect(r.missingScopes).toEqual(["write_orders"]);
  });

  it("distinguishes a tool with no catalog entry, which dispatch denies", () => {
    expect(resolveToolAvailability({ ...base, hasCatalogEntry: false }).reason).toBe("no_catalog_entry");
  });

  it("reports the reason the admin can act on FIRST", () => {
    // All four blocks at once. An unentitled plan cannot be fixed by
    // connecting anything, so that is what the row must say - sending them to
    // reconnect an integration would waste their time.
    const r = resolveToolAvailability({
      ...base,
      planEntitled: false,
      integrationConnected: false,
      hasCatalogEntry: false,
      requiredScopes: ["write_orders"],
      grantedScopes: [],
    });
    expect(r.reason).toBe("plan_not_entitled");
  });

  it("does not invent a block when scopes are satisfied", () => {
    const r = resolveToolAvailability({
      ...base,
      requiredScopes: ["write_orders"],
      grantedScopes: ["write_orders", "read_orders"],
    });
    expect(r.state).toBe("require_approval");
    expect(r.missingScopes).toEqual([]);
  });

  it("treats absent platform facts as 'not blocking' rather than blocking", () => {
    // An internal tool has no integration and no scopes; it must not be
    // reported unavailable just because those fields are undefined.
    expect(resolveToolAvailability({ toolName: "get_contact", enabled: true, requiresApproval: false }).state)
      .toBe("always_allow");
  });

  it("always carries the risk group", () => {
    expect(resolveToolAvailability({ toolName: "issue_refund", enabled: true, requiresApproval: true }).riskGroup)
      .toBe("financial");
  });
});

const A = (toolName: string, state: ToolAvailability["state"]): ToolAvailability => ({
  state, reason: state === "unavailable" ? "missing_scope" : "ok",
  missingScopes: [], riskGroup: riskGroupFor(toolName), overriddenByPlatform: state === "unavailable",
});

describe("summarizeTools - the headline must be true", () => {
  it("counts only what can actually run as enabled", () => {
    const c = summarizeTools([
      A("get_contact", "always_allow"),
      A("issue_refund", "require_approval"),
      A("send_message", "disabled"),
      A("shopify.create_order", "unavailable"),
    ]);
    expect(c).toEqual({ total: 4, enabled: 2, alwaysAllow: 1, requireApproval: 1, disabled: 1, unavailable: 1 });
  });

  it("never counts an unavailable tool as enabled", () => {
    // Even though its stored preference says enabled, it cannot run.
    const c = summarizeTools([A("x_create", "unavailable"), A("y_create", "unavailable")]);
    expect(c.enabled).toBe(0);
    expect(c.unavailable).toBe(2);
  });

  it("handles an empty list", () => {
    expect(summarizeTools([]).total).toBe(0);
  });
});

describe("groupByRisk", () => {
  it("returns groups in the declared display order and skips empty ones", () => {
    const rows = [
      { riskGroup: "financial" as const },
      { riskGroup: "read_only" as const },
      { riskGroup: "financial" as const },
    ];
    expect(groupByRisk(rows).map(([g, list]) => [g, list.length])).toEqual([
      ["read_only", 1],
      ["financial", 2],
    ]);
  });
});

describe("bulk actions", () => {
  const rows = [
    { toolName: "get_contact", riskGroup: riskGroupFor("get_contact"), state: "disabled" as const },
    { toolName: "send_message", riskGroup: riskGroupFor("send_message"), state: "always_allow" as const },
    { toolName: "issue_refund", riskGroup: riskGroupFor("issue_refund"), state: "always_allow" as const },
    { toolName: "shopify.create_order", riskGroup: riskGroupFor("shopify.create_order"), state: "unavailable" as const },
  ];

  it("enable-all-read-only touches only reads that are not already on", () => {
    expect(planBulkAction("enable_all_read_only", rows)).toEqual([
      { toolName: "get_contact", enabled: true, requiresApproval: false },
    ]);
  });

  it("require-approval-for-writes flips the auto-approved writes", () => {
    const plan = planBulkAction("require_approval_for_all_writes", rows);
    expect(plan.map((p) => p.toolName).sort()).toEqual(["issue_refund", "send_message"]);
    expect(plan.every((p) => p.requiresApproval)).toBe(true);
  });

  it("never includes an unavailable tool - its state is not the admin's to set", () => {
    for (const action of ["enable_all_read_only", "require_approval_for_all_writes", "disable_all", "restore_recommended"] as const) {
      expect(planBulkAction(action, rows).map((p) => p.toolName), action)
        .not.toContain("shopify.create_order");
    }
  });

  it("restore-recommended only reports genuine changes", () => {
    const plan = planBulkAction("restore_recommended", rows);
    // send_message and issue_refund are auto-allowed but should require
    // approval; get_contact is off but should be auto-allowed.
    expect(plan.map((p) => p.toolName).sort()).toEqual(["get_contact", "issue_refund", "send_message"]);
  });

  it("is a no-op when everything already matches the recommendation", () => {
    const good = [
      { toolName: "get_contact", riskGroup: riskGroupFor("get_contact"), state: "always_allow" as const },
      { toolName: "issue_refund", riskGroup: riskGroupFor("issue_refund"), state: "require_approval" as const },
    ];
    expect(planBulkAction("restore_recommended", good)).toEqual([]);
  });

  it("confirms every risky bulk change but not the additive one", () => {
    expect(bulkActionNeedsConfirmation("enable_all_read_only")).toBe(false);
    for (const a of ["require_approval_for_all_writes", "disable_all", "restore_recommended"] as const) {
      expect(bulkActionNeedsConfirmation(a), a).toBe(true);
    }
  });
});
