/**
 * Mapping existing tool policy into the three-state model.
 *
 * The old model was two independent booleans - `enabled` and `requiresApproval`
 * - which can express states the new model cannot, and vice versa. Collapsing
 * them carelessly is how a tenant discovers their refund tool started running
 * autonomously, so the rules here are deliberately conservative and every
 * decision is reported rather than applied silently:
 *
 *   - A DISABLED tool stays disabled. Always. Even when the recommended default
 *     for its risk group would be Autonomous, and even when it is a harmless
 *     read. Someone turned it off on purpose and a migration is not the place to
 *     second-guess that.
 *   - A tool that required approval NEVER becomes Autonomous. The reverse
 *     (Autonomous -> HITL) is allowed, because tightening is safe.
 *   - A tool whose stored state cannot legally exist in the new model (an
 *     always-allow on a financial action) is reported for review rather than
 *     quietly downgraded, because either answer changes behaviour.
 *
 * Pure so the report can be previewed before anything is written.
 */

import { mayBeAlwaysAllowed, recommendedState, riskGroupFor, type RiskGroup } from "./tool-availability";

export type ThreeState = "autonomous" | "hitl" | "disabled";

/** Why a tool landed where it did. Shown in the migration report. */
export type MigrationOutcome =
  | "migrated_autonomous"
  | "migrated_hitl"
  | "migrated_disabled"
  | "unchanged"
  /** Stored state is impossible in the new model. Needs a human decision. */
  | "conflict_needs_review"
  /** Policy exists for a tool nothing can execute any more. */
  | "unmapped_legacy"
  /** Cannot run regardless of policy, so migrating it would be meaningless. */
  | "unavailable_missing_scope";

export interface LegacyPolicy {
  toolName: string;
  /** Old booleans. Absent means "no explicit row" - the catalog default rules. */
  enabled?: boolean;
  requiresApproval?: boolean;
  /** True when the tool no longer exists in any catalog or adapter. */
  orphaned?: boolean;
  /** True when a required provider scope is known-missing. */
  scopeBlocked?: boolean;
  /** Product policy may permit always-allow on an otherwise locked group. */
  productPolicyPermitsAutoApprove?: boolean;
}

export interface MigrationDecision {
  toolName: string;
  riskGroup: RiskGroup;
  /** What it was, as best the old booleans express it. */
  from: ThreeState | "unset";
  /** What it becomes. Null when nothing should be written. */
  to: ThreeState | null;
  outcome: MigrationOutcome;
  reason: string;
}

/** Collapse the old booleans into the closest three-state value. */
function legacyState(p: LegacyPolicy): ThreeState | "unset" {
  if (p.enabled === undefined && p.requiresApproval === undefined) return "unset";
  if (p.enabled === false) return "disabled";
  return p.requiresApproval ? "hitl" : "autonomous";
}

export function decideMigration(p: LegacyPolicy): MigrationDecision {
  const riskGroup = riskGroupFor(p.toolName);
  const from = legacyState(p);
  const base = { toolName: p.toolName, riskGroup, from };

  // A tool nothing can execute any more. Its policy row is dead config; report
  // it rather than migrating a setting for a tool that cannot run.
  if (p.orphaned) {
    return {
      ...base, to: null, outcome: "unmapped_legacy",
      reason: "no catalog tool or adapter exposes this any more",
    };
  }

  // Cannot run whatever the policy says, so writing one would be theatre. The
  // stored value is left exactly as it is, so restoring the scope restores the
  // tenant's original intent.
  if (p.scopeBlocked) {
    return {
      ...base, to: null, outcome: "unavailable_missing_scope",
      reason: "a required provider scope is missing; policy left untouched",
    };
  }

  // Off stays off. The single most important rule here.
  if (from === "disabled") {
    return {
      ...base, to: "disabled", outcome: "migrated_disabled",
      reason: "was disabled; a migration must not enable anything",
    };
  }

  if (from === "hitl") {
    return {
      ...base, to: "hitl", outcome: "migrated_hitl",
      reason: "already required approval; carried over unchanged",
    };
  }

  if (from === "autonomous") {
    // Stored state says auto-run, but the new model forbids it for this group.
    // Both possible answers change behaviour, so a human decides.
    if (!mayBeAlwaysAllowed(riskGroup, p.productPolicyPermitsAutoApprove === true)) {
      return {
        ...base, to: null, outcome: "conflict_needs_review",
        reason: `stored policy auto-runs a ${riskGroup} action, which the new model does not permit`,
      };
    }
    return {
      ...base, to: "autonomous", outcome: "migrated_autonomous",
      reason: "auto-run is permitted for this risk group; carried over unchanged",
    };
  }

  // No explicit row. The recommended default applies, but only where it is
  // allowed - and it is never written for a group that cannot auto-run.
  const want = recommendedState(riskGroup) === "always_allow" ? "autonomous" : "hitl";
  if (want === "autonomous" && !mayBeAlwaysAllowed(riskGroup, p.productPolicyPermitsAutoApprove === true)) {
    return {
      ...base, to: "hitl", outcome: "migrated_hitl",
      reason: "no stored policy; defaulted to approval because auto-run is not permitted here",
    };
  }
  return {
    ...base,
    to: want,
    outcome: want === "autonomous" ? "migrated_autonomous" : "migrated_hitl",
    reason: "no stored policy; applied the recommended default for this risk group",
  };
}

export interface MigrationReport {
  total: number;
  counts: Record<MigrationOutcome, number>;
  /** Everything needing a human decision, surfaced first. */
  needsReview: MigrationDecision[];
  decisions: MigrationDecision[];
}

export function buildMigrationReport(policies: LegacyPolicy[]): MigrationReport {
  const decisions = policies.map(decideMigration);
  const counts = {
    migrated_autonomous: 0, migrated_hitl: 0, migrated_disabled: 0, unchanged: 0,
    conflict_needs_review: 0, unmapped_legacy: 0, unavailable_missing_scope: 0,
  } as Record<MigrationOutcome, number>;
  for (const d of decisions) counts[d.outcome] += 1;
  return {
    total: decisions.length,
    counts,
    needsReview: decisions.filter(
      (d) => d.outcome === "conflict_needs_review" || d.outcome === "unmapped_legacy",
    ),
    decisions,
  };
}

/**
 * The writes a migration should perform. Excludes everything with `to: null` -
 * conflicts, orphans and scope-blocked tools are reported, never written.
 * Idempotent by construction: re-running produces the same set, and applying it
 * twice is the same as applying it once.
 */
export function migrationWrites(report: MigrationReport): Array<{ toolName: string; state: ThreeState }> {
  return report.decisions
    .filter((d) => d.to !== null && d.to !== d.from)
    .map((d) => ({ toolName: d.toolName, state: d.to as ThreeState }));
}
