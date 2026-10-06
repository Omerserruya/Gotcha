/**
 * Who may see a conversation, bound to this service's prisma.
 *
 * The RULE (`visibilityClause`) is the shared one - packages/shared/src/lib/
 * conversation-visibility-rule.ts - so the inbox list, the socket room join,
 * every by-id route here and the AI service's conversation routes all answer
 * the same question. Known hole (a non-admin with no department sees the whole
 * tenant) is documented there.
 */
import { prisma } from "@chatcenter/shared";

// The rule itself is shared (one definition for every service, including the
// AI service's conversation routes). Deep-imported from its import-free file so
// this service's tests, which mock the @chatcenter/shared barrel, still run the
// real rule. canViewConversation below binds it to this service's prisma.
import { visibilityClause, type Viewer } from "@chatcenter/shared/src/lib/conversation-visibility-rule";
export { visibilityClause, type Viewer };

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
