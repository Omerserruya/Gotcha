/**
 * Who may see a conversation. ONE definition, used by the list query and by
 * the Socket.IO room join.
 *
 * The rule already existed, inline in `conversationService.list`. It is lifted
 * here unchanged so the realtime path cannot answer a different question from
 * the REST path - a socket that is easier to get data out of than a request is
 * the whole problem this module exists to prevent.
 *
 * KNOWN HOLES, deliberately preserved rather than quietly fixed:
 *
 *   1. The filter only applies when the user HAS a department. A non-ADMIN with
 *      `departmentId` unset falls through to "see everything in the tenant".
 *   2. `GET /api/conversations/:id` applies no per-user scoping at all.
 *
 * Both predate this module and both are real. Tightening either one inside a
 * realtime change would move an access rule in a diff where no reviewer would
 * be looking for it; they are reported as their own items instead. When they
 * are fixed, this is the one place to fix them.
 */
import { prisma } from "@chatcenter/shared";

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

/**
 * May this viewer see this one conversation?
 *
 * Asked once when a socket joins a conversation room, never per event. Voice
 * transcripts arrive as partials several times a second; authorizing each one
 * would put a database round trip on every syllable.
 *
 * The consequence is that entitlement is evaluated at join time and not
 * re-evaluated afterwards, so a reassignment mid-call does not eject a socket
 * already in the room. That is the same staleness the REST path has between two
 * requests, and narrowing it means an eviction channel, which is a bigger
 * change than this one.
 */
export async function canViewConversation(
  tenantId: string,
  conversationId: string,
  viewer: Viewer,
): Promise<boolean> {
  const clause = visibilityClause(viewer);
  const row = await prisma.conversation.findFirst({
    // tenantId FIRST and always: the clause below narrows within a tenant, it
    // never establishes one.
    where: {
      id: conversationId,
      tenantId,
      ...(clause ? { OR: clause } : {}),
    },
    select: { id: true },
  });
  return row != null;
}
