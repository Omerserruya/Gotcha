import { describe, it, expect } from "vitest";
import { memberDepartmentNames } from "../member-departments";

describe("memberDepartmentNames", () => {
  it("lists EVERY department for a multi-department member", () => {
    expect(
      memberDepartmentNames({
        departmentName: "Sales",
        departments: [
          { departmentId: "d1", departmentName: "Sales" },
          { departmentId: "d2", departmentName: "Support" },
        ],
      }),
    ).toEqual(["Sales", "Support"]);
  });

  it("falls back to the legacy singular field when no list is present", () => {
    expect(memberDepartmentNames({ departmentName: "Sales" })).toEqual(["Sales"]);
  });

  it("returns empty when the member has no department", () => {
    expect(memberDepartmentNames({ departmentName: null })).toEqual([]);
    expect(memberDepartmentNames({})).toEqual([]);
  });

  it("drops null names inside the list", () => {
    expect(
      memberDepartmentNames({ departments: [{ departmentId: "d1", departmentName: null }, { departmentId: "d2", departmentName: "Ops" }] }),
    ).toEqual(["Ops"]);
  });

  it("prefers the list over the singular field (never truncates to one)", () => {
    const names = memberDepartmentNames({
      departmentName: "Sales",
      departments: [
        { departmentId: "d1", departmentName: "Sales" },
        { departmentId: "d2", departmentName: "Support" },
        { departmentId: "d3", departmentName: "Ops" },
      ],
    });
    expect(names).toHaveLength(3);
  });
});
