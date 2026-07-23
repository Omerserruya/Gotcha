// Which department names to show for a workspace member. A member can belong
// to SEVERAL departments (People & Teams multi-membership); the list model
// (`departments`) wins, with a fallback to the legacy singular `departmentName`
// for older payloads. Kept pure so the People table's rendering is unit-tested.

export interface DeptMembership {
  departmentId: string;
  departmentRole?: string | null;
  departmentName?: string | null;
}

export interface MemberLike {
  departmentName?: string | null;
  departments?: DeptMembership[];
}

export function memberDepartmentNames(m: MemberLike): string[] {
  if (m.departments?.length) {
    return m.departments.map((d) => d.departmentName).filter((n): n is string => !!n);
  }
  return m.departmentName ? [m.departmentName] : [];
}
