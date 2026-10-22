/**
 * Who on the team is available right now.
 *
 *   GET   /api/agents/presence            - the whole tenant's roster
 *   POST  /api/agents/presence/heartbeat  - "I am still here"
 *   PATCH /api/agents/presence/me         - "I am busy" / "away until 11:00"
 *
 * The AgentPresence model has existed since the Live Call CoPilot phase, but
 * the voice service was its only writer and nothing read it - so asking the
 * platform who was online would have reported an empty office even with the
 * whole team working. The heartbeat is what makes it true for chat agents; the
 * reads below are what makes it visible.
 *
 * Two endpoints rather than one, because they answer different questions. A
 * heartbeat says "this tab is open" and must be safe to fire every minute
 * forever; a declaration says "I am stepping out until 11:00" and must survive
 * the heartbeats that follow it. Folding the declaration into the heartbeat
 * would mean every tick silently reasserted a status the agent set once, and an
 * away window would be erased by the next beat unless the client remembered to
 * resend it - a client-side responsibility for a server-side fact.
 */
import { Router, type Request, type Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  heartbeat as bumpHeartbeat,
  declarePresence,
  effectivePresence,
  type AgentPresenceStatus,
} from "@chatcenter/shared";

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

/** What an agent is allowed to declare about themselves. */
const DECLARABLE: AgentPresenceStatus[] = ["ONLINE", "BUSY", "AWAY", "OFFLINE"];

/**
 * The roster.
 *
 * Open to every tenant member, not just ADMIN: knowing whether a colleague is
 * available is what an agent needs before handing a conversation over, and
 * routing decisions are made by people who are not administrators.
 *
 * Driven from the USER list rather than the presence table, so an agent who has
 * never sent a heartbeat still appears - as OFFLINE, which is true. Listing
 * only rows that exist would quietly hide the whole team on day one and make an
 * empty panel indistinguishable from an empty office.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId as string;
    const members = await prisma.user.findMany({
      where: { tenantId, isActive: true },
      select: {
        id: true,
        // The PRIMARY (earliest) department, the same one the principal
        // carries. An agent may belong to several; the panel shows one label
        // and a list of three would not fit the row it is rendered in.
        departmentMembers: {
          select: { department: { select: { name: true } } },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "asc" },
    });
    if (members.length === 0) {
      res.json({ data: [] });
      return;
    }

    const rows = await prisma.agentPresence.findMany({
      where: { tenantId, agentId: { in: members.map((m) => m.id) } },
      select: { agentId: true, status: true, lastSeenAt: true, awayUntil: true },
    });
    const byAgent = new Map(rows.map((r) => [r.agentId, r]));

    const now = new Date();
    const data = members.map((m) => {
      const row = byAgent.get(m.id);
      const presence = row
        ? effectivePresence(row, now)
        : // Never seen. OFFLINE with no lastSeenAt is the honest answer - not
          // a fabricated timestamp that would read as "seen just now".
          { status: "OFFLINE" as const, awayUntil: null };
      return {
        agentId: m.id,
        status: presence.status,
        lastSeenAt: row ? row.lastSeenAt.toISOString() : null,
        awayUntil: presence.awayUntil,
        departmentName: m.departmentMembers[0]?.department?.name ?? null,
      };
    });
    res.json({ data });
  } catch (err) {
    console.error("Agent presence list error:", err);
    res.status(500).json({ error: "Failed to get agent presence" });
  }
});

/**
 * "I am still here."
 *
 * Bumps lastSeenAt and nothing else - notably NOT the status, so a heartbeat
 * arriving while an agent is AWAY or BUSY does not quietly put them back
 * online. The shared helper hydrates a first-ever row as ONLINE, which is the
 * only case where a heartbeat decides a status.
 */
router.post("/heartbeat", async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.userId as string | undefined;
    if (!userId || (req.user as any)?.isInternal) {
      res.status(403).json({ error: "Presence is per-user" });
      return;
    }
    await bumpHeartbeat(userId, req.tenantId as string);
    res.json({ ok: true });
  } catch (err) {
    console.error("Agent heartbeat error:", err);
    res.status(500).json({ error: "Failed to record heartbeat" });
  }
});

/**
 * "I am busy" / "away until 11:00".
 *
 * Deliberately `/me` and never `/:agentId`: presence is a statement a person
 * makes about themselves. An admin setting a colleague to AWAY would put words
 * in their mouth, and every reader downstream would treat it as the agent's own
 * declaration.
 */
router.patch("/me", async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.userId as string | undefined;
    if (!userId || (req.user as any)?.isInternal) {
      res.status(403).json({ error: "Presence is per-user" });
      return;
    }

    const { status, awayUntil } = (req.body || {}) as { status?: unknown; awayUntil?: unknown };
    if (typeof status !== "string" || !DECLARABLE.includes(status as AgentPresenceStatus)) {
      res.status(400).json({
        error: "status must be one of ONLINE, BUSY, AWAY, OFFLINE",
        code: "invalid_status",
      });
      return;
    }

    let until: Date | null = null;
    if (awayUntil !== undefined && awayUntil !== null) {
      if (typeof awayUntil !== "string") {
        res.status(400).json({ error: "awayUntil must be an ISO-8601 instant" });
        return;
      }
      const parsed = new Date(awayUntil);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ error: "awayUntil must be an ISO-8601 instant" });
        return;
      }
      // A window that has already closed would be reported back as ONLINE on
      // the very next read, so accepting it silently would look like the
      // request was ignored. Say what is wrong instead.
      if (parsed.getTime() <= Date.now()) {
        res.status(400).json({ error: "awayUntil must be in the future", code: "away_until_past" });
        return;
      }
      until = parsed;
    }

    await declarePresence(userId, req.tenantId as string, status as AgentPresenceStatus, until);
    res.json({ data: { status, awayUntil: until ? until.toISOString() : null } });
  } catch (err) {
    console.error("Agent presence update error:", err);
    res.status(500).json({ error: "Failed to update presence" });
  }
});

export default router;
