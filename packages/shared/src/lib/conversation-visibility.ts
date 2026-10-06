/**
 * Who may see a conversation. ONE definition, for every service: the inbox
 * list, the Socket.IO room join, every route addressed by a conversation id in
 * the conversation service, and the AI service's conversation routes.
 *
 * Moved here from services/conversation (2026-10-06) because the AI service
 * had the same by-id routes with no check at all, and a second copy of an
 * access rule is how two services end up answering different questions.
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
 *   2. (CLOSED 2026-10-06, 2d55dc69) `GET /api/conversations/:id` applied no
 *      per-user scoping. Every by-id route now goes through
 *      `requireVisibleConversation` below.
 *
 * Hole 1 predates this module and is real. It is reported as its own item
 * rather than tightened here, where no reviewer of a move would look for an
 * access change. When it is fixed, this is the one place to fix it.
 */
import { prisma } from "./prisma";

import { visibilityClause, type Viewer } from "./conversation-visibility-rule";
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

/**
 * `router.param` handler: the route answers only for a conversation this
 * viewer may see. 404 otherwise - the same answer as a missing id, so a caller
 * cannot probe which ids exist. Runs before every handler that names the
 * parameter, including routes added later.
 */
export async function requireVisibleConversation(req: any, res: any, next: (err?: unknown) => void, id: string): Promise<void> {
  try {
    const tenantId = req.tenantId as string | undefined;
    if (!tenantId) { res.status(404).json({ error: "Conversation not found" }); return; }
    // FAIL CLOSED without a user. `router.param` runs BEFORE a route's own
    // middleware, so in a router that authenticates per route there is no
    // user yet - and a missing role reads as "unrestricted" to the rule. Use
    // `visibleConversationFrom` (below) after `authenticate` in such routers.
    if (!req.user?.userId) { res.status(404).json({ error: "Conversation not found" }); return; }
    const user = req.user;
    // An unrestricted viewer (admin, or no department) has nothing to check:
    // the handler behaves exactly as before, without an extra query per call.
    if (!visibilityClause({ userId: user.userId, role: user.role, departmentId: user.departmentId })) { next(); return; }
    const ok = await canViewConversation(tenantId, String(id), {
      userId: user.userId,
      role: user.role,
      departmentId: user.departmentId,
    });
    if (!ok) { res.status(404).json({ error: "Conversation not found" }); return; }
    next();
  } catch (err) {
    next(err);
  }
}

/** The viewer of a request, in the shape the rule takes. */
export function viewerOf(req: any): Viewer {
  const u = req?.user ?? {};
  return { userId: u.userId, role: u.role, departmentId: u.departmentId };
}

/**
 * The same guard as plain middleware, reading the id from `req.params[name]`
 * (or `req.query[name]` / `req.body[name]` when the id travels there). For
 * routers that authenticate per route, place it AFTER `authenticate`.
 */
export function visibleConversationFrom(name: string, where: "params" | "query" | "body" = "params") {
  return (req: any, res: any, next: (err?: unknown) => void): void => {
    const id = req?.[where]?.[name];
    if (typeof id !== "string" || !id) { next(); return; }
    void requireVisibleConversation(req, res, next, id);
  };
}
