/**
 * Agent presence write helpers (Phase 1 - Live Call CoPilot).
 *
 * Wraps the AgentPresence model with simple upsert semantics. Services still
 * run their own selects, but the RULE for turning a stored row into a status a
 * human is shown lives here (`effectivePresence`) rather than in each caller:
 * the team panel, routing and the inbox must not disagree about who is
 * available, and three copies of a staleness threshold is how they would.
 *
 * Concurrency model: presence is per-agent (PK = agentId), so a single
 * agent's writes never race. Cross-agent contention is impossible.
 */
import { prisma } from "./prisma";

export type AgentPresenceStatus = "ONLINE" | "BUSY" | "AWAY" | "OFFLINE";

/**
 * Upsert presence row for an agent. Always writes status + lastSeenAt.
 * When `activeVoiceSessionId` is `undefined` the field is left untouched
 * (preserves the existing assignment); pass `null` to clear it.
 */
export async function setPresence(
  agentId: string,
  tenantId: string,
  status: AgentPresenceStatus,
  activeVoiceSessionId?: string | null,
): Promise<void> {
  const now = new Date();
  await prisma.agentPresence.upsert({
    where: { agentId },
    create: {
      agentId,
      tenantId,
      status,
      activeVoiceSessionId: activeVoiceSessionId ?? null,
      lastSeenAt: now,
    },
    update: {
      status,
      tenantId,
      lastSeenAt: now,
      ...(activeVoiceSessionId === undefined
        ? {}
        : { activeVoiceSessionId }),
    },
  });
}

/** Convenience: mark agent BUSY with their current live session. */
export async function markBusy(
  agentId: string,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  await setPresence(agentId, tenantId, "BUSY", sessionId);
}

/** Convenience: mark agent ONLINE and clear active session. */
export async function markOnline(
  agentId: string,
  tenantId: string,
): Promise<void> {
  await setPresence(agentId, tenantId, "ONLINE", null);
}

/**
 * Heartbeat: bump `lastSeenAt` without altering status / session. Caller
 * supplies tenantId so we can still hydrate the row on the very first ping
 * for an agent that has never been ONLINE.
 */
export async function heartbeat(
  agentId: string,
  tenantId: string,
): Promise<void> {
  const now = new Date();
  await prisma.agentPresence.upsert({
    where: { agentId },
    create: {
      agentId,
      tenantId,
      status: "ONLINE",
      lastSeenAt: now,
    },
    update: {
      lastSeenAt: now,
      tenantId,
    },
  });
}

/**
 * How long a row may go without a heartbeat before it reads as OFFLINE.
 *
 * Presence has no reaper, deliberately. A scheduled job that marks stale rows
 * OFFLINE is a job that can fail, and its failure mode is showing a customer's
 * team as available when nobody is there - the exact claim presence exists to
 * make honestly. Deriving it on read cannot fail to run.
 *
 * Two and a half minutes is a heartbeat interval of ~60s plus room for one
 * missed beat and a slow network, so a live agent does not flicker offline
 * between ticks.
 */
export const PRESENCE_STALE_AFTER_MS = 150 * 1000;

export interface StoredPresence {
  status: AgentPresenceStatus | string;
  lastSeenAt: Date;
  awayUntil?: Date | null;
}

export interface EffectivePresence {
  status: AgentPresenceStatus;
  awayUntil: string | null;
}

/**
 * The status to SHOW for a stored row, and the one thing every reader must
 * agree on.
 *
 * Order matters:
 *   1. A stale row is OFFLINE whatever it says. An agent who declared BUSY and
 *      then closed the laptop is not busy, and leaving them BUSY would hold a
 *      queue for someone who is gone.
 *   2. AWAY whose window has passed becomes ONLINE - they are still
 *      heartbeating, so they are back and simply did not say so. Left as-is,
 *      an agent who set "away until 11:00" would read AWAY at 15:00 while
 *      actively working.
 *   3. Otherwise the stored status stands.
 *
 * `awayUntil` is only ever returned alongside a status of AWAY, so a client
 * cannot render "away until 11:00" next to ONLINE.
 */
export function effectivePresence(row: StoredPresence, now: Date = new Date()): EffectivePresence {
  if (now.getTime() - row.lastSeenAt.getTime() > PRESENCE_STALE_AFTER_MS) {
    return { status: "OFFLINE", awayUntil: null };
  }
  if (row.status === "AWAY") {
    if (row.awayUntil && row.awayUntil.getTime() <= now.getTime()) {
      return { status: "ONLINE", awayUntil: null };
    }
    return { status: "AWAY", awayUntil: row.awayUntil ? row.awayUntil.toISOString() : null };
  }
  const known: AgentPresenceStatus[] = ["ONLINE", "BUSY", "OFFLINE"];
  const status = (known as string[]).includes(row.status)
    ? (row.status as AgentPresenceStatus)
    : "OFFLINE";
  return { status, awayUntil: null };
}

/**
 * Declare a status explicitly, which is the half a heartbeat cannot express.
 *
 * `awayUntil` is accepted only with AWAY and cleared otherwise, so a stale
 * window cannot survive a switch back to ONLINE and reappear the next time
 * somebody sets AWAY without one.
 */
export async function declarePresence(
  agentId: string,
  tenantId: string,
  status: AgentPresenceStatus,
  awayUntil?: Date | null,
): Promise<void> {
  const now = new Date();
  const until = status === "AWAY" ? (awayUntil ?? null) : null;
  await prisma.agentPresence.upsert({
    where: { agentId },
    create: { agentId, tenantId, status, awayUntil: until, lastSeenAt: now },
    update: { status, tenantId, awayUntil: until, lastSeenAt: now },
  });
}
