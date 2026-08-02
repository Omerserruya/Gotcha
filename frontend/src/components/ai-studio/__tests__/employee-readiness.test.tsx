import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  employeeIssues,
  canActivate,
  EmployeeReadinessStrip,
  type EmployeeLike,
} from "../EmployeeReadinessStrip";

const healthy: EmployeeLike = {
  status: "ACTIVE",
  goal: "Answer customer questions about orders and returns.",
  knowledgeSources: [{ id: "kb1" }],
  toolCount: 3,
  readinessReport: { score: 82 },
  lastTestedAt: "2026-07-29T10:00:00.000Z",
  departmentName: "Support",
};

describe("employeeIssues - derived from real state, never guessed", () => {
  it("says nothing about a healthy employee", () => {
    expect(employeeIssues(healthy, false)).toEqual([]);
  });

  it("treats a missing job as a blocker", () => {
    const issues = employeeIssues({ ...healthy, goal: "  " }, false);
    expect(issues.map((i) => i.key)).toContain("no_goal");
    expect(issues.find((i) => i.key === "no_goal")!.severity).toBe("blocker");
  });

  it("treats no knowledge as a blocker, because the employee can only guess", () => {
    const issues = employeeIssues({ ...healthy, knowledgeSources: [] }, false);
    const i = issues.find((x) => x.key === "no_knowledge")!;
    expect(i.severity).toBe("blocker");
    expect(i.label).toMatch(/guess/i);
  });

  it("treats no tools as a warning, not a blocker - talking is still useful", () => {
    const issues = employeeIssues({ ...healthy, toolCount: 0 }, false);
    expect(issues.find((x) => x.key === "no_tools")!.severity).toBe("warning");
  });

  it("never-tested blocks an ACTIVE employee but only warns on a draft", () => {
    expect(employeeIssues({ ...healthy, lastTestedAt: null }, false)
      .find((x) => x.key === "never_tested")!.severity).toBe("blocker");
    expect(employeeIssues({ ...healthy, status: "DRAFT", lastTestedAt: null }, false)
      .find((x) => x.key === "never_tested")!.severity).toBe("warning");
  });

  it("distinguishes unmeasured readiness from measured-and-low", () => {
    expect(employeeIssues({ ...healthy, readinessReport: null }, false)
      .map((i) => i.key)).toContain("no_readiness");
    const low = employeeIssues({ ...healthy, readinessReport: { score: 35 } }, false);
    expect(low.map((i) => i.key)).toContain("low_readiness");
    expect(low.find((i) => i.key === "low_readiness")!.label).toContain("35");
  });

  it("does not flag a good-but-imperfect score", () => {
    expect(employeeIssues({ ...healthy, readinessReport: { score: 61 } }, false)
      .map((i) => i.key)).not.toContain("low_readiness");
  });

  it("localizes every issue label", () => {
    const he = employeeIssues({ status: "ACTIVE" }, true);
    expect(he.length).toBeGreaterThan(0);
    for (const i of he) expect(i.label).toMatch(/[֐-׿]/);
  });
});

describe("canActivate - only a blocker stops activation", () => {
  it("allows a healthy employee", () => {
    expect(canActivate(healthy)).toBe(true);
  });

  it("allows one that merely has warnings", () => {
    expect(canActivate({ ...healthy, toolCount: 0, readinessReport: null })).toBe(true);
  });

  it("refuses one with no knowledge or no job", () => {
    expect(canActivate({ ...healthy, knowledgeSources: [] })).toBe(false);
    expect(canActivate({ ...healthy, goal: "" })).toBe(false);
  });

  it("refuses an untested employee that claims to be ACTIVE", () => {
    expect(canActivate({ ...healthy, lastTestedAt: null })).toBe(false);
  });
});

describe("EmployeeReadinessStrip", () => {
  it("shows a single positive line when there is nothing wrong", () => {
    render(<EmployeeReadinessStrip agent={healthy} he={false} />);
    expect(screen.getByTestId("employee-ready")).toBeTruthy();
  });

  it("lists what is wrong, worst first, capped so the card stays readable", () => {
    render(<EmployeeReadinessStrip agent={{ status: "ACTIVE" }} he={false} />);
    const list = screen.getByTestId("employee-issues");
    expect(list).toBeTruthy();
    // Five problems exist on a blank employee; only three are listed plus a
    // "and N more" line, so the card cannot grow unbounded.
    expect(list.querySelectorAll("li").length).toBeLessThanOrEqual(4);
    expect(list.textContent).toMatch(/more/i);
  });

  it("renders Hebrew for a Hebrew tenant", () => {
    render(<EmployeeReadinessStrip agent={{ status: "ACTIVE" }} he={true} />);
    expect(screen.getByTestId("employee-issues").textContent).toMatch(/[֐-׿]/);
  });
});
