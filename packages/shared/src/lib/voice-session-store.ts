/**
 * Voice session persistence — wraps every VoiceCallSession write with
 * FSM-aware dual-write (state + legacy status), append-only stateHistory,
 * and atomic optimistic locks for claim/transition.
 *
 * Phase 1 invariant: a single agent has at most one live (CONNECTING /
 * ACTIVE / HOLD) call at any moment. Enforced by:
 *   - claimIncomingCall: refuses claim if the agent has any live session
 *   - outbound call placement: same precondition before insert
 */
import { Prisma, type VoiceCallSession } from "@prisma/client";
import { prisma } from "./prisma";
import {
  assertTransition,
  appendHistory,
  canTransition,
  fromLegacyStatus,
  LIVE_STATES,
  toLegacyStatus,
  type CallState,
} from "./call-state-machine";
import { markBusy } from "./agent-presence";
import { publishEvent } from "./event-bus";

const TERMINAL_STATES: ReadonlySet<CallState> = new Set(["ENDED", "FAILED", "MISSED"]);

export type TransitionFailure =
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "stale_state"; currentState: CallState }
  | { ok: false; reason: "invalid_transition"; from: CallState; to: CallState };

export type ClaimFailure =
  | { ok: false; reason: "not_ringing" }
  | { ok: false; reason: "agent_busy"; busyOnSessionId: string }
  | { ok: false; reason: "already_claimed"; byAgentId: string };

export async function transitionVoiceCallSessionState(
  sessionId: string,
  toState: CallState,
  opts: {
    fromState?: CallState | null;
    reason?: string;
    extraData?: Prisma.VoiceCallSessionUpdateManyMutationInput;
  } = {},
): Promise<{ ok: true; session: VoiceCallSession } | TransitionFailure> {
  const existing = await prisma.voiceCallSession.findUnique({ where: { id: sessionId } });
  if (!existing) return { ok: false, reason: "not_found" };

  const currentState: CallState = (existing.state as CallState | null) ?? fromLegacyStatus(existing.status);
  const expectedFrom = opts.fromState === undefined ? currentState : opts.fromState;

  if (expectedFrom !== null) {
    if (expectedFrom !== currentState) {
      return { ok: false, reason: "stale_state", currentState };
    }
    if (!canTransition(currentState, toState)) {
      return { ok: false, reason: "invalid_transition", from: currentState, to: toState };
    }
  } else {
    assertTransition(currentState, toState);
  }

  const nextHistory = appendHistory(existing.stateHistory, toState, opts.reason);
  const updated = await prisma.voiceCallSession.updateMany({
    where: expectedFrom === null
      ? { id: sessionId }
      : { id: sessionId, state: expectedFrom },
    data: {
      state: toState,
      status: toLegacyStatus(toState),
      stateHistory: nextHistory as unknown as Prisma.InputJsonValue,
      ...(toState === "ENDED" || toState === "FAILED" || toState === "MISSED"
        ? { endedAt: new Date(), endReason: opts.reason ?? null }
        : {}),
      ...(toState === "ACTIVE" && !existing.answeredAt ? { answeredAt: new Date() } : {}),
      ...(opts.extraData ?? {}),
    },
  });
  if (updated.count !== 1) {
    const fresh = await prisma.voiceCallSession.findUnique({ where: { id: sessionId } });
    const freshState: CallState = (fresh?.state as CallState | null) ?? "ENDED";
    return { ok: false, reason: "stale_state", currentState: freshState };
  }
  const session = await prisma.voiceCallSession.findUniqueOrThrow({ where: { id: sessionId } });

  // Auto-handle cascade: when an OUTBOUND call to this customer reaches
  // ACTIVE, every MISSED inbound row for the same (tenant, customerNumber)
  // gets `handledAt` stamped. The agent has actually picked up — those
  // missed-call inbox rows are now stale. This is the server-side path
  // that closes the loop even when the callback came from the WhatsApp
  // template button (no browser involved, so localStorage couldn't help).
  if (toState === "ACTIVE" && session.direction === "outbound" && session.customerNumber) {
    try {
      await prisma.voiceCallSession.updateMany({
        where: {
          tenantId: session.tenantId,
          direction: "inbound",
          state: "MISSED",
          customerNumber: session.customerNumber,
          handledAt: null,
        },
        data: { handledAt: new Date() },
      });
    } catch {
      // Non-fatal — the inbox would still show the rows on next reload,
      // and the agent's explicit "Mark as handled" still works.
    }
  }

  // Broadcast the transition so live UIs (ActiveCallBar, IncomingCallBanner,
  // workspace page) drop/refresh the session without waiting on a reconcile.
  // Without this, customer-side hangups never reach the browser — the DB row
  // is updated by Twilio webhooks but no socket event fires.
  try {
    await publishEvent({
      event: "voice.session.state",
      tenantId: session.tenantId,
      data: {
        sessionId: session.id,
        state: toState,
        from: currentState,
        session,
      },
    });
    if (TERMINAL_STATES.has(toState)) {
      await publishEvent({
        event: "voice.session.ended",
        tenantId: session.tenantId,
        data: {
          sessionId: session.id,
          conversationId: session.conversationId,
          callSid: session.callSid,
          state: toState,
          reason: opts.reason ?? null,
        },
      });
    }
  } catch {
    // Best-effort — DB write already succeeded; the next reconcile will repair.
  }

  return { ok: true, session };
}

export async function claimIncomingCall(
  sessionId: string,
  agentId: string,
): Promise<{ ok: true; session: VoiceCallSession } | ClaimFailure> {
  const busy = await prisma.voiceCallSession.findFirst({
    where: { assignedAgentId: agentId, state: { in: ["CONNECTING", "ACTIVE", "HOLD"] } },
    select: { id: true },
  });
  if (busy) return { ok: false, reason: "agent_busy", busyOnSessionId: busy.id };

  const existing = await prisma.voiceCallSession.findUnique({ where: { id: sessionId } });
  if (!existing) return { ok: false, reason: "not_ringing" };
  if (existing.assignedAgentId && existing.assignedAgentId !== agentId) {
    return { ok: false, reason: "already_claimed", byAgentId: existing.assignedAgentId };
  }
  if (existing.state !== "RINGING") return { ok: false, reason: "not_ringing" };

  const nextHistory = appendHistory(existing.stateHistory, "CONNECTING", "claimed");
  // Inbound rows are now pre-assigned to the channel's default agent at
  // ring time (so the right UI rings first). That agent must still be
  // able to claim — accept either `null` (unassigned ring) OR
  // `assignedAgentId === claimer` (pre-assigned to this agent). The
  // line 133 check above already rejects claims by a DIFFERENT agent.
  const claimed = await prisma.voiceCallSession.updateMany({
    where: {
      id: sessionId,
      state: "RINGING",
      OR: [{ assignedAgentId: null }, { assignedAgentId: agentId }],
    },
    data: {
      state: "CONNECTING",
      status: toLegacyStatus("CONNECTING"),
      assignedAgentId: agentId,
      agentId,
      claimedAt: new Date(),
      stateHistory: nextHistory as unknown as Prisma.InputJsonValue,
    },
  });
  if (claimed.count !== 1) {
    const fresh = await prisma.voiceCallSession.findUnique({
      where: { id: sessionId },
      select: { assignedAgentId: true, state: true },
    });
    if (fresh?.assignedAgentId && fresh.assignedAgentId !== agentId) {
      return { ok: false, reason: "already_claimed", byAgentId: fresh.assignedAgentId };
    }
    return { ok: false, reason: "not_ringing" };
  }
  const session = await prisma.voiceCallSession.findUniqueOrThrow({ where: { id: sessionId } });
  // Best-effort presence write — never block the claim on presence row errors.
  try {
    await markBusy(agentId, session.tenantId, session.id);
  } catch {
    /* presence write is best-effort */
  }
  return { ok: true, session };
}

export async function agentBusyOnLiveCall(agentId: string): Promise<VoiceCallSession | null> {
  return prisma.voiceCallSession.findFirst({
    where: { assignedAgentId: agentId, state: { in: Array.from(LIVE_STATES) as CallState[] } },
  });
}
