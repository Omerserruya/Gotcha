"use client";

/**
 * What is actually wrong with this employee, on its card.
 *
 * The roster used to show a readiness percentage and nothing about WHY, so an
 * employee sitting at 40% looked broken with no next step, and one with no
 * knowledge attached looked identical to one fully taught. Every item here is
 * derived from state the API already returns - nothing is inferred or guessed -
 * and each one names the fix rather than just the fault.
 *
 * Deliberately quiet when there is nothing to say: a healthy employee shows a
 * single "ready" line instead of an empty warning box.
 */

import clsx from "clsx";

export interface EmployeeLike {
  status?: string | null;
  knowledgeSources?: Array<{ id: string }> | null;
  toolCount?: number | null;
  readinessReport?: { score?: number | null } | null;
  lastTestedAt?: string | null;
  departmentName?: string | null;
  goal?: string | null;
}

export interface EmployeeIssue {
  key: string;
  severity: "blocker" | "warning";
  label: string;
}

/**
 * Blocker = the employee cannot do its job as configured. Warning = it will
 * work but something is unverified. Only a blocker should stop activation.
 */
export function employeeIssues(agent: EmployeeLike, he: boolean): EmployeeIssue[] {
  const L = (en: string, hebrew: string) => (he ? hebrew : en);
  const issues: EmployeeIssue[] = [];
  const status = String(agent.status || "").toUpperCase();

  if (!agent.goal || !String(agent.goal).trim()) {
    issues.push({
      key: "no_goal",
      severity: "blocker",
      label: L("No job defined yet", "לא הוגדר תפקיד"),
    });
  }

  if (!agent.knowledgeSources || agent.knowledgeSources.length === 0) {
    issues.push({
      key: "no_knowledge",
      severity: "blocker",
      // Without knowledge the employee can only answer from its persona, which
      // in practice means guessing about the business.
      label: L("No knowledge attached, it can only guess", "לא חובר ידע, הוא יכול רק לנחש"),
    });
  }

  if (!agent.toolCount) {
    issues.push({
      key: "no_tools",
      severity: "warning",
      label: L("No tools enabled, it can talk but not act", "לא הופעלו כלים, הוא יכול לדבר אך לא לפעול"),
    });
  }

  if (!agent.lastTestedAt) {
    issues.push({
      key: "never_tested",
      severity: status === "ACTIVE" ? "blocker" : "warning",
      label: L("Never tested", "לא נבדק מעולם"),
    });
  }

  const score = agent.readinessReport?.score;
  if (score == null) {
    issues.push({
      key: "no_readiness",
      severity: "warning",
      label: L("Readiness not measured", "מוכנות לא נמדדה"),
    });
  } else if (Number(score) < 60) {
    issues.push({
      key: "low_readiness",
      severity: "warning",
      label: L(`Readiness is low (${score}%)`, `מוכנות נמוכה (${score}%)`),
    });
  }

  return issues;
}

/** True when nothing blocks activation. Used to gate the activate action. */
export function canActivate(agent: EmployeeLike, he = false): boolean {
  return employeeIssues(agent, he).every((i) => i.severity !== "blocker");
}

export function EmployeeReadinessStrip({ agent, he }: { agent: EmployeeLike; he: boolean }) {
  const L = (en: string, hebrew: string) => (he ? hebrew : en);
  const issues = employeeIssues(agent, he);

  if (issues.length === 0) {
    return (
      <p className="flex items-center gap-1 text-[11px] font-medium text-emerald-600" data-testid="employee-ready">
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
        {L("Ready, knowledge and tools in place, tested", "מוכן, יש ידע וכלים, נבדק")}
      </p>
    );
  }

  return (
    <ul className="space-y-0.5" data-testid="employee-issues">
      {issues.slice(0, 3).map((i) => (
        <li
          key={i.key}
          className={clsx(
            "flex items-start gap-1 text-[11px]",
            i.severity === "blocker" ? "text-rose-600" : "text-amber-600",
          )}
        >
          <span className="mt-[3px] shrink-0 leading-none">{i.severity === "blocker" ? "●" : "○"}</span>
          <span className="min-w-0">{i.label}</span>
        </li>
      ))}
      {issues.length > 3 && (
        <li className="text-[11px] text-gray-400">
          {he ? `ועוד ${issues.length - 3}` : `and ${issues.length - 3} more`}
        </li>
      )}
    </ul>
  );
}

export default EmployeeReadinessStrip;
