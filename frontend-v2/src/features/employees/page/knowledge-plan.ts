import { z } from 'zod';

import { knowledgeSourceSchema } from '@/api/contracts/knowledge';

/**
 * Which knowledge an employee reads - the runtime's rule, read in
 * `services/ai/src/services/knowledge.service.ts` (`readableKnowledgeBaseIds`):
 * an ACTIVE knowledge base is read when it is attached to the employee
 * (`AIAgentKnowledge`), or its scope already reaches it - `all`, `agent` for
 * this employee, `department` for its department.
 *
 * Attaching is `PATCH /api/ai-agents/:id { knowledgeBaseIds }`, which
 * replaces the whole list (`ai-agents.ts`). A source whose scope reaches the
 * employee anyway has no switch: detaching it would change nothing.
 */

/** The list route's knowledge base, with the two scope keys it already sends. */
export const employeeKnowledgeSourceSchema = knowledgeSourceSchema.extend({
  scopeAgentId: z.string().nullable().catch(null).default(null),
  scopeDepartmentId: z.string().nullable().catch(null).default(null),
});
export type EmployeeKnowledgeSource = z.infer<typeof employeeKnowledgeSourceSchema>;
export const employeeKnowledgeListSchema = z.array(employeeKnowledgeSourceSchema);

export type KnowledgeReach = 'off' | 'everyone' | 'own' | 'department' | 'connected' | 'not';

/** `id: null`: a hire, which has no id yet - only `all` reaches it by scope. */
type Who = { readonly id: string | null; readonly departmentId: string | null };

/** The scope reaches this employee without an attachment. */
export function reachedByScope(source: EmployeeKnowledgeSource, employee: Who): boolean {
  const scope = source.scope || 'all';
  if (scope === 'all') return true;
  if (scope === 'agent') return employee.id !== null && source.scopeAgentId === employee.id;
  if (scope === 'department') {
    return employee.departmentId !== null && source.scopeDepartmentId === employee.departmentId;
  }
  return false;
}

/** Why it reads this source, or why not - in the runtime's order. */
export function reachOf(
  source: EmployeeKnowledgeSource,
  employee: Who,
  attached: ReadonlySet<string>,
): KnowledgeReach {
  if (!source.isActive) return 'off';
  const scope = source.scope || 'all';
  if (scope === 'all') return 'everyone';
  if (reachedByScope(source, employee)) return scope === 'agent' ? 'own' : 'department';
  return attached.has(source.id) ? 'connected' : 'not';
}

/** The PATCH body: the whole list, sorted, every attachment kept that has no switch. */
export function knowledgePatch(attached: Iterable<string>): { knowledgeBaseIds: string[] } {
  return { knowledgeBaseIds: [...new Set(attached)].sort() };
}
