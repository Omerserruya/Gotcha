/**
 * WHO MAY SEE A CONVERSATION - the rule itself, pure (no imports).
 *
 * The one definition every service applies: the inbox list, the Socket.IO room
 * join, every by-id route in the conversation service, and the AI service's
 * conversation routes. Kept import-free so a service can deep-import it
 * (`@chatcenter/shared/src/lib/conversation-visibility-rule`) without pulling
 * the barrel - which is what lets the conversation service keep its own
 * prisma-bound wrapper while sharing the rule. See conversation-visibility.ts.
 *
 * KNOWN HOLE, deliberately preserved: the filter only applies when the user
 * HAS a department. A non-ADMIN with `departmentId` unset falls through to
 * "see everything in the tenant". Reported as its own item; when it is fixed,
 * this is the one place to fix it.
 */
export interface Viewer {
  userId: string;
  role?: string;
  departmentId?: string;
}

/**
 * The visibility clause for a viewer, or `null` when the viewer is unrestricted
 * (an ADMIN, or - see hole 1 - a non-admin with no department).
 *
 * `null` means "add nothing to the where clause". It does NOT mean "match
 * nothing"; a caller that treats it as a filter value would invert the rule.
 */
export function visibilityClause(viewer: Viewer): Record<string, unknown>[] | null {
  const { role, userId, departmentId } = viewer;
  if (!role || role === "ADMIN" || !departmentId) return null;
  return [
    { departmentId, assignedAgentId: null },
    { departmentId: null, assignedAgentId: null },
    { assignedAgentId: userId },
  ];
}
