/**
 * Every route addressed by a conversation id answers only for a conversation
 * the viewer may see - the SAME rule as the inbox list and the socket room
 * (`canViewConversation` / `visibilityClause`).
 *
 * The list applied it and `GET /api/conversations/:id` did not, so a
 * department-restricted agent holding a link (or a guessed id) received
 * another department's conversation with every message. Opening a
 * conversation by link made it reachable from the product itself.
 *
 * Installed with `router.param`, so it runs for EVERY route in the router
 * that names the parameter - including ones added later - rather than relying
 * on each handler to remember.
 *
 * Not visible → 404, the same answer as "does not exist", so a caller cannot
 * probe which ids are real. ADMIN (and a viewer with no department) is
 * unrestricted, exactly as in the list.
 */
import type { Request, Response, NextFunction } from "express";
import { canViewConversation, visibilityClause } from "./conversation-visibility";

export async function requireVisibleConversation(req: Request, res: Response, next: NextFunction, id: string): Promise<void> {
  try {
    const user = (req as any).user ?? {};
    const tenantId = (req as any).tenantId as string | undefined;
    if (!tenantId || !user.userId) { res.status(404).json({ error: "Conversation not found" }); return; }
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
