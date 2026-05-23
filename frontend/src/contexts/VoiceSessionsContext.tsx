"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth } from "@/context/AuthContext";
import { getSocket } from "@/lib/socket";
import { useVoiceFlags } from "@/lib/use-voice-flags";
import {
  answerVoiceSession,
  declineVoiceSession,
  getActiveVoiceSessions,
  hangupVoiceSession,
  type VoiceCallSession,
} from "@/lib/api";

interface VoiceSessionsContextValue {
  ringing: VoiceCallSession[];
  /**
   * Phase 1 single-active-call invariant. At most one session — the one
   * claimed by the current agent. Out-of-tenant or other-agent live
   * sessions are deliberately filtered out so the global call bar can
   * only ever represent THIS user's call.
   */
  live: VoiceCallSession | null;
  /**
   * Every live session in the tenant (this agent's + everyone else's).
   * Used by inbox/list views; do NOT use for the global call bar.
   */
  allLive: VoiceCallSession[];
  loading: boolean;
  claim: (id: string) => Promise<VoiceCallSession | null>;
  decline: (id: string) => Promise<void>;
  hangup: (id: string) => Promise<void>;
  reconcile: () => Promise<void>;
}

const VoiceSessionsContext = createContext<VoiceSessionsContextValue | null>(null);

const RINGING_STATES = new Set(["RINGING"]);
const LIVE_STATES = new Set(["CONNECTING", "ACTIVE", "HOLD"]);
const TERMINAL_STATES = new Set(["ENDED", "FAILED", "MISSED"]);

function isRinging(s: VoiceCallSession): boolean {
  return s.state ? RINGING_STATES.has(s.state) : s.status === "ringing";
}

function isLive(s: VoiceCallSession): boolean {
  if (s.state) return LIVE_STATES.has(s.state);
  return s.status === "in-progress";
}

function isTerminal(s: VoiceCallSession): boolean {
  if (s.state) return TERMINAL_STATES.has(s.state);
  return ["completed", "failed", "no-answer"].includes(s.status);
}

export function VoiceSessionsProvider({ children }: { children: React.ReactNode }) {
  const { token, user } = useAuth();
  const voiceFlags = useVoiceFlags();
  const [sessions, setSessions] = useState<VoiceCallSession[]>([]);
  const [loading, setLoading] = useState(true);
  // The socket handler closes over a single `user.id` snapshot — mirror it
  // into a ref so the singleton-live filter always sees the current agent.
  const userIdRef = useRef<string | undefined>(user?.id);
  useEffect(() => {
    userIdRef.current = user?.id;
  }, [user?.id]);

  const reconcile = useCallback(async () => {
    if (!token || voiceFlags.loading || !voiceFlags.voiceCopilotEnabled) {
      setSessions([]);
      setLoading(false);
      return;
    }
    try {
      const res = await getActiveVoiceSessions(token);
      setSessions(res.data || []);
    } catch (err: unknown) {
      // 404 = tenant flag off — empty out and stop trying.
      const message = err instanceof Error ? err.message : "";
      if (message.includes("404") || /not_found/i.test(message)) {
        setSessions([]);
      } else {
        // eslint-disable-next-line no-console
        console.warn("[voice-sessions] reconcile failed:", err);
      }
    } finally {
      setLoading(false);
    }
  }, [token, voiceFlags.loading, voiceFlags.voiceCopilotEnabled]);

  // Initial seed + token change reseed.
  useEffect(() => {
    reconcile();
  }, [reconcile]);

  // Reconcile on browser visibility/online to recover from any missed
  // socket events while the tab was backgrounded or offline.
  useEffect(() => {
    if (!token) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const onOnline = () => reconcile();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [token, reconcile]);

  // Subscribe to tenant-room voice events. The conversation service bridges
  // every cross-service event to `tenant:{id}` rooms via subscribeToEvents,
  // so we hang off the existing AuthContext socket — DO NOT create another.
  // Skipped entirely when voiceCopilotEnabled is false to avoid noisy 404s.
  useEffect(() => {
    if (!token || voiceFlags.loading || !voiceFlags.voiceCopilotEnabled) return;

    let socket = getSocket();
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const upsert = (incoming: VoiceCallSession) => {
      setSessions((prev) => {
        const idx = prev.findIndex((s) => s.id === incoming.id);
        if (isTerminal(incoming)) {
          // Drop terminal sessions from the active list.
          if (idx === -1) return prev;
          const next = prev.slice();
          next.splice(idx, 1);
          return next;
        }
        if (idx === -1) return [...prev, incoming];
        const next = prev.slice();
        next[idx] = { ...prev[idx], ...incoming };
        return next;
      });
    };

    const removeById = (id: string) => {
      setSessions((prev) => prev.filter((s) => s.id !== id));
    };

    // voice.incoming.ringing — payload: { session: VoiceCallSession }
    // voice.session.created — same shape, fired by /twiml/outbound when the
    // outbound session row is created. Reuses the same upsert path.
    const ringingHandler = (data: unknown) => {
      const d = data as { session?: VoiceCallSession } | VoiceCallSession;
      const session = (d as { session?: VoiceCallSession }).session
        ?? (d as VoiceCallSession);
      if (!session || !session.id) return;
      upsert(session);
    };

    // Resolve a sessionId from whatever identifier the publisher gave us.
    // voice-copilot emits events keyed by conversationId/callSid — not by
    // VoiceCallSession.id — so we have to look the local row up ourselves.
    const findSessionId = (
      d: { sessionId?: string; id?: string; conversationId?: string; callSid?: string },
      list: VoiceCallSession[],
    ): string | null => {
      if (d.sessionId) return d.sessionId;
      if (d.id) return d.id;
      if (d.conversationId) {
        const match = list.find((s) => s.conversationId === d.conversationId);
        if (match) return match.id;
      }
      if (d.callSid) {
        const match = list.find((s) => s.callSid === d.callSid);
        if (match) return match.id;
      }
      return null;
    };

    const TERMINAL_LOWER = new Set(["ended", "failed", "missed"]);

    // voice.session.state — payload: { sessionId, state, session?: VoiceCallSession }
    const stateHandler = (data: unknown) => {
      const d = data as { sessionId?: string; session?: VoiceCallSession };
      if (d?.session && d.session.id) {
        upsert(d.session);
        return;
      }
      if (d?.sessionId) {
        // No session body — refetch the snapshot to stay correct.
        reconcile();
      }
    };

    // voice.session.state_changed — voice-copilot's transition event. Payload:
    // { conversationId, from, to, ts }. When `to` is terminal we drop locally
    // (matching by conversationId/callSid); otherwise we reconcile so the
    // server-truth state replaces ours.
    const stateChangedHandler = (data: unknown) => {
      const d = data as {
        conversationId?: string;
        callSid?: string;
        sessionId?: string;
        to?: string;
      };
      const target = (d?.to || "").toLowerCase();
      setSessions((prev) => {
        const id = findSessionId(d, prev);
        if (target && TERMINAL_LOWER.has(target)) {
          if (!id) return prev;
          return prev.filter((s) => s.id !== id);
        }
        // Non-terminal transition without a session body — fetch fresh data.
        reconcile();
        return prev;
      });
    };

    // voice.session.ended — voice-copilot publishes { conversationId, callSid,
    // reason, ts }; the older shape carries { sessionId }. Resolve either to a
    // local row and drop it. If we can't identify it, reconcile as a fallback.
    const endedHandler = (data: unknown) => {
      const d = data as {
        sessionId?: string;
        id?: string;
        conversationId?: string;
        callSid?: string;
      };
      setSessions((prev) => {
        const id = findSessionId(d, prev);
        if (id) return prev.filter((s) => s.id !== id);
        // Unknown identifier — refetch the snapshot so we don't keep a stale
        // ringing/active session on the screen forever.
        reconcile();
        return prev;
      });
    };

    const attach = () => {
      const s = getSocket();
      if (!s) return false;
      socket = s;
      s.on("voice.incoming.ringing", ringingHandler);
      s.on("voice.session.created", ringingHandler);
      s.on("voice.session.state", stateHandler);
      s.on("voice.session.state_changed", stateChangedHandler);
      s.on("voice.session.ended", endedHandler);
      return true;
    };

    if (!attach()) {
      pollTimer = setInterval(() => {
        if (attach() && pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }, 250);
    }

    return () => {
      if (pollTimer) clearInterval(pollTimer);
      if (socket) {
        socket.off("voice.incoming.ringing", ringingHandler);
        socket.off("voice.session.created", ringingHandler);
        socket.off("voice.session.state", stateHandler);
        socket.off("voice.session.state_changed", stateChangedHandler);
        socket.off("voice.session.ended", endedHandler);
      }
    };
  }, [token, reconcile, voiceFlags.loading, voiceFlags.voiceCopilotEnabled]);

  const claim = useCallback(
    async (id: string): Promise<VoiceCallSession | null> => {
      if (!token) return null;
      const res = await answerVoiceSession(token, id);
      if (res?.data) {
        setSessions((prev) => {
          const idx = prev.findIndex((s) => s.id === res.data.id);
          if (idx === -1) return [...prev, res.data];
          const next = prev.slice();
          next[idx] = res.data;
          return next;
        });
      }
      return res.data ?? null;
    },
    [token],
  );

  const decline = useCallback(
    async (id: string): Promise<void> => {
      if (!token) return;
      await declineVoiceSession(token, id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
    },
    [token],
  );

  const hangup = useCallback(
    async (id: string): Promise<void> => {
      if (!token) return;
      try {
        await hangupVoiceSession(token, id);
      } catch (err) {
        // 410 Gone = session already ended on the server. Still drop it
        // locally so the UI catches up; rethrow anything else.
        const message = err instanceof Error ? err.message : "";
        if (!/\b410\b|gone/i.test(message)) {
          setSessions((prev) => prev.filter((s) => s.id !== id));
          throw err;
        }
      }
      setSessions((prev) => prev.filter((s) => s.id !== id));
    },
    [token],
  );

  const { ringing, live, allLive } = useMemo(() => {
    const ringing: VoiceCallSession[] = [];
    const allLive: VoiceCallSession[] = [];
    let live: VoiceCallSession | null = null;
    const myUserId = userIdRef.current;
    for (const s of sessions) {
      if (isRinging(s)) {
        // Per-channel routing: if a default agent is set on the session it
        // rings only that agent for the first `ringTimeoutSeconds`. After
        // the timeout voice-copilot NULLs `assignedAgentId` so the same
        // event broadcasts to everyone. Filter accordingly.
        if (s.assignedAgentId && s.assignedAgentId !== myUserId) {
          continue;
        }
        ringing.push(s);
      } else if (isLive(s)) {
        allLive.push(s);
        // Phase 1 singleton — only surface THIS agent's live session as
        // the global "live" call. Other agents' sessions still appear in
        // LiveCallsSection but are NOT the singleton ActiveCallBar.
        if (s.assignedAgentId && s.assignedAgentId === userIdRef.current) {
          live = s;
        }
      }
    }
    return { ringing, live, allLive };
  }, [sessions]);

  const value: VoiceSessionsContextValue = {
    ringing,
    live,
    allLive,
    loading,
    claim,
    decline,
    hangup,
    reconcile,
  };

  return (
    <VoiceSessionsContext.Provider value={value}>{children}</VoiceSessionsContext.Provider>
  );
}

export function useVoiceSessions(): VoiceSessionsContextValue {
  const ctx = useContext(VoiceSessionsContext);
  if (!ctx) {
    throw new Error("useVoiceSessions must be used within VoiceSessionsProvider");
  }
  return ctx;
}
