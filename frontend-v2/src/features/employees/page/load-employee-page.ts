import 'server-only';

import type { Employee } from '@/api/contracts/employees';
import { readEmployeeSkills } from '@/features/skills/skill-actions';

import { loadEmployees } from '../load-employees';

export interface EmployeePageRead {
  /** `null`: the roster could not be read, or this id is not in it (`missing`). */
  readonly employee: Employee | null;
  /** The roster was read and this employee is not in it. */
  readonly missing: boolean;
  /** How many skills it carries, for the tab; `null` when unread. */
  readonly skillsCount: number | null;
}

/**
 * What every tab of an employee's page reads first: the employee (from the
 * list route - there is no lighter read that carries the counts the head
 * draws) and its skill count for the Skills tab's label.
 */
export async function loadEmployeePage(
  id: string,
  { withSkills = true }: { readonly withSkills?: boolean } = {},
): Promise<EmployeePageRead> {
  const [employees, skills] = await Promise.all([
    loadEmployees(),
    withSkills ? readEmployeeSkills(id) : Promise.resolve(null),
  ]);
  const employee = employees?.find((e) => e.id === id) ?? null;
  return {
    employee,
    missing: employees !== null && employee === null,
    skillsCount: skills ? skills.skills.length : null,
  };
}
