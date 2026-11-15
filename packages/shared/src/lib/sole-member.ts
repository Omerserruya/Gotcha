/**
 * A workspace with exactly one human member (Omer, 2026-11-15).
 *
 * Every automated handoff to a person (the AI escalating, the owner taking
 * over from the phone, an automation's "assign to a person" with no one
 * named, an approval that expired) goes to that one person: assigned to them,
 * not left in a queue as WAITING for a team that does not exist. With two or
 * more members nothing here applies, and today's queue does.
 *
 * ONE predicate, read by the handoff paths AND by /auth/me
 * (workspace.soleHuman), so the inbox views can never disagree with routing.
 *
 * Who counts: users of the workspace with kind "member" and isActive. Not the
 * hidden support-mode user (kind "support"), not a deactivated member, not an
 * invite still pending (an invite is no User until accepted). AI employees are
 * not Users at all. A SYSTEM_ADMIN who is a real member counts.
 */
import { prisma } from "./prisma";

type Db = {
  user: { findMany: (args: any) => Promise<Array<{ id: string }>> };
  conversation: { updateMany: (args: any) => Promise<{ count: number }> };
};

/** The workspace's one active human member, or null when there are none or several. */
export async function soleHumanMember(tenantId: string, db: Pick<Db, "user"> = prisma as any): Promise<string | null> {
  if (!tenantId) return null;
  const rows = await db.user.findMany({
    where: { tenantId, kind: "member", isActive: true },
    select: { id: true },
    take: 2,
  });
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * After a handoff to a person: assign the conversation to the workspace's
 * one member, when it has exactly one. Only a conversation nobody is assigned
 * to, never a test or sandbox one; WAITING becomes OPEN, as for any assignment
 * (transferToDepartment). No "assigned to you" notice: with one person it
 * would double every handoff's own alert. Never throws: the handoff stands.
 * Returns the member's id when it assigned, else null.
 */
export async function assignSoleMemberOnHandoff(
  tenantId: string,
  conversationId: string,
  db: Db = prisma as any,
): Promise<string | null> {
  try {
    const userId = await soleHumanMember(tenantId, db);
    if (!userId) return null;
    const r = await db.conversation.updateMany({
      where: {
        id: conversationId,
        tenantId,
        assignedAgentId: null,
        isTest: false,
        NOT: { customerExternalId: { startsWith: "sandbox:" } },
      },
      data: { assignedAgentId: userId },
    });
    if (!r.count) return null;
    // WAITING means "for someone to pick it up": it has someone now.
    await db.conversation.updateMany({
      where: { id: conversationId, tenantId, status: "WAITING" },
      data: { status: "OPEN" },
    });
    console.log(`[handoff] sole member assigned conv=${conversationId} user=${userId}`);
    return userId;
  } catch (err: any) {
    console.warn(`[handoff] sole-member assign failed conv=${conversationId}: ${err?.message}`);
    return null;
  }
}
