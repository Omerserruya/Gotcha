import { describe, it, expect } from "vitest";
import {
  decideMigration,
  buildMigrationReport,
  migrationWrites,
  type LegacyPolicy,
} from "../tool-policy-migration";

describe("a migration must never loosen anything", () => {
  it("keeps a disabled tool disabled, even a harmless read", () => {
    // The single most important rule. Someone turned it off deliberately.
    const d = decideMigration({ toolName: "get_contact", enabled: false });
    expect(d.to).toBe("disabled");
    expect(d.outcome).toBe("migrated_disabled");
  });

  it("keeps a disabled tool disabled even when its recommended default is autonomous", () => {
    const d = decideMigration({ toolName: "shopify.get_order", enabled: false, requiresApproval: false });
    expect(d.to).toBe("disabled");
  });

  it("never turns an approval-gated tool into an autonomous one", () => {
    for (const tool of ["send_message", "shopify.cancel_order", "update_contact"]) {
      const d = decideMigration({ toolName: tool, enabled: true, requiresApproval: true });
      expect(d.to, tool).toBe("hitl");
      expect(d.outcome, tool).toBe("migrated_hitl");
    }
  });

  it("reports rather than silently downgrades an impossible stored state", () => {
    // An always-allow on a refund cannot exist in the new model. Downgrading it
    // silently and leaving it alone are BOTH behaviour changes, so a human picks.
    const d = decideMigration({ toolName: "issue_refund", enabled: true, requiresApproval: false });
    expect(d.outcome).toBe("conflict_needs_review");
    expect(d.to).toBeNull();
    expect(d.reason).toMatch(/financial/);
  });

  it("honours an explicit product decision to permit auto-run", () => {
    const d = decideMigration({
      toolName: "issue_refund", enabled: true, requiresApproval: false,
      productPolicyPermitsAutoApprove: true,
    });
    expect(d.to).toBe("autonomous");
    expect(d.outcome).toBe("migrated_autonomous");
  });

  it("carries a legitimate autonomous read straight over", () => {
    const d = decideMigration({ toolName: "get_contact", enabled: true, requiresApproval: false });
    expect(d.to).toBe("autonomous");
  });
});

describe("tools that cannot run are reported, not migrated", () => {
  it("leaves a scope-blocked tool's stored policy untouched", () => {
    // Restoring the scope must restore the tenant's original intent, so the
    // migration must not overwrite it in the meantime.
    const d = decideMigration({ toolName: "shopify.cancel_order", enabled: true, requiresApproval: true, scopeBlocked: true });
    expect(d.outcome).toBe("unavailable_missing_scope");
    expect(d.to).toBeNull();
  });

  it("reports an orphaned policy for a tool nothing exposes any more", () => {
    const d = decideMigration({ toolName: "legacy.removed_tool", enabled: true, orphaned: true });
    expect(d.outcome).toBe("unmapped_legacy");
    expect(d.to).toBeNull();
  });

  it("puts orphan and scope checks ahead of the state mapping", () => {
    // Even a disabled tool that no longer exists is an orphan, not a migration.
    expect(decideMigration({ toolName: "x.gone", enabled: false, orphaned: true }).outcome)
      .toBe("unmapped_legacy");
  });
});

describe("tools with no stored policy get the recommended default, safely", () => {
  it("defaults a read to autonomous", () => {
    const d = decideMigration({ toolName: "shopify.get_order" });
    expect(d.from).toBe("unset");
    expect(d.to).toBe("autonomous");
  });

  it("defaults a write to approval", () => {
    expect(decideMigration({ toolName: "shopify.update_customer" }).to).toBe("hitl");
  });

  it("never defaults a financial or delete tool to autonomous", () => {
    for (const tool of ["issue_refund", "shopify.cancel_order", "delete_contact", "update_user_role"]) {
      expect(decideMigration({ toolName: tool }).to, tool).toBe("hitl");
    }
  });
});

describe("the report", () => {
  const policies: LegacyPolicy[] = [
    { toolName: "get_contact", enabled: true, requiresApproval: false },      // autonomous, fine
    { toolName: "send_message", enabled: true, requiresApproval: true },      // hitl
    { toolName: "create_task", enabled: false },                             // disabled
    { toolName: "issue_refund", enabled: true, requiresApproval: false },     // conflict
    { toolName: "legacy.gone", enabled: true, orphaned: true },               // orphan
    { toolName: "shopify.cancel_order", enabled: true, requiresApproval: true, scopeBlocked: true },
    { toolName: "shopify.get_orders" },                                      // unset -> autonomous
  ];
  const report = buildMigrationReport(policies);

  it("counts every outcome and totals correctly", () => {
    expect(report.total).toBe(7);
    expect(report.counts.migrated_autonomous).toBe(2);
    expect(report.counts.migrated_hitl).toBe(1);
    expect(report.counts.migrated_disabled).toBe(1);
    expect(report.counts.conflict_needs_review).toBe(1);
    expect(report.counts.unmapped_legacy).toBe(1);
    expect(report.counts.unavailable_missing_scope).toBe(1);
    const summed = Object.values(report.counts).reduce((a, b) => a + b, 0);
    expect(summed).toBe(report.total);
  });

  it("surfaces everything needing a human decision", () => {
    expect(report.needsReview.map((d) => d.toolName).sort()).toEqual(["issue_refund", "legacy.gone"]);
  });

  it("explains every decision", () => {
    for (const d of report.decisions) expect(d.reason.length).toBeGreaterThan(10);
  });
});

describe("writes are minimal and idempotent", () => {
  const policies: LegacyPolicy[] = [
    { toolName: "get_contact", enabled: true, requiresApproval: false },  // already autonomous
    { toolName: "shopify.update_customer" },                             // unset -> hitl
    { toolName: "issue_refund", enabled: true, requiresApproval: false }, // conflict, no write
  ];

  it("writes only genuine changes", () => {
    const writes = migrationWrites(buildMigrationReport(policies));
    // get_contact is already where it should be; the conflict is not written.
    expect(writes).toEqual([{ toolName: "shopify.update_customer", state: "hitl" }]);
  });

  it("never writes a conflict, orphan or scope-blocked tool", () => {
    const writes = migrationWrites(buildMigrationReport([
      { toolName: "issue_refund", enabled: true, requiresApproval: false },
      { toolName: "x.gone", enabled: true, orphaned: true },
      { toolName: "shopify.cancel_order", enabled: true, scopeBlocked: true },
    ]));
    expect(writes).toEqual([]);
  });

  it("is idempotent - applying then re-running produces no further writes", () => {
    const first = migrationWrites(buildMigrationReport(policies));
    // Simulate having applied them.
    const applied: LegacyPolicy[] = policies.map((p) => {
      const w = first.find((x) => x.toolName === p.toolName);
      if (!w) return p;
      return {
        toolName: p.toolName,
        enabled: w.state !== "disabled",
        requiresApproval: w.state === "hitl",
      };
    });
    expect(migrationWrites(buildMigrationReport(applied))).toEqual([]);
  });

  it("handles an empty tenant", () => {
    const r = buildMigrationReport([]);
    expect(r.total).toBe(0);
    expect(migrationWrites(r)).toEqual([]);
  });
});
