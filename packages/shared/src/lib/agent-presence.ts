/**
 * Agent presence write helpers (Phase 1 — Live Call CoPilot).
 *
 * Wraps the AgentPresence model with simple upsert semantics. Reads are
 * intentionally NOT exposed here — services that need presence reads
 * query prisma.agentPresence directly with their own selects.
 *
 * Concurrency model: presence is per-agent (PK = agentId), so a single
 * agent's writes never race. Cross-agent contention is impossible.
 */
import { prisma } from "./prisma";

export type AgentPresenceStatus = "ONLINE" | "BUSY" | "OFFLINE";

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
