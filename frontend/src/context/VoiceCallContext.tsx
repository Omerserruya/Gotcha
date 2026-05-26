"use client";

import React, { createContext, useContext, useState, useRef, useEffect, useCallback } from "react";
import { Device, Call } from "@twilio/voice-sdk";
import { useAuth } from "@/context/AuthContext";
import { getSocket } from "@/lib/socket";
import { useVoiceFlags } from "@/lib/use-voice-flags";

export type CallState = "idle" | "connecting" | "ringing" | "active" | "ended" | "error";

export interface CallInfo {
  to: string;
  contactName?: string;
  conversationId?: string;
  notes?: string;
  startedAt?: number;
}

export interface LiveTranscript {
  speaker: "agent" | "customer";
  text: string;
  isFinal: boolean;
  seq: number;
  ts: number;
  conversationId: string;
}

export interface CommittedUtterance {
  speaker: "agent" | "customer";
  text: string;
  ts: number;
  seq: number;
}

export interface CopilotSuggestion {
  id?: string;
  title?: string;
  body?: string;
  text?: string;
  kind?: string;
  confidence?: number;
}

/**
 * Local mirror of the canonical `ConversationStateFrame` schema in
 * `packages/shared/src/schemas/conversation-frame.ts`. Phase 3 keeps the
 * frontend off the shared workspace import to avoid a Next.js transpile
 * change. Phase 4 should promote this to a direct shared import — keep
 * shapes in sync until then.
 */
export interface ConversationStateFrame {
  conversationId: string;
  mode: "live" | "qa" | "async";
  /** Monotonic per conversation. Reducer: replace iff version > current. */
  version: number;
  ts: string;
  intent: { primary: string; secondary: string[]; confidence: number } | null;
  stage: { id: string; name: string; enteredAt: string } | null;
  summary: { text: string; kind: "rolling" | "final" } | null;
  sentiment: { customer: number; escalationRisk: number } | null;
  missingFields: Array<{ field: string; required: boolean; suggestedQuestion?: string }>;
  suggestedActions: Array<{ text: string; rationale: string; urgency: "low" | "medium" | "high" }>;
  proposedTools: Array<{
    tool: string;
    args: Record<string, unknown>;
    rationale: string;
    requiresApproval: boolean;
  }>;
  risks: Array<{
    kind: string;
    severity: "low" | "medium" | "high";
    evidenceUtteranceIds: string[];
  }>;
  urgency: "low" | "medium" | "high";
  confidence: number;
}

interface VoiceCallContextType {
  state: CallState;
  call: CallInfo | null;
  elapsedMs: number;
  error: string | null;
  isReady: boolean;
  isMuted: boolean;
  /** Finals only — one entry per completed utterance, in arrival order. */
  committedTranscripts: CommittedUtterance[];
  /** The live "building" text for each speaker, overwritten on every partial. */
  currentUtterance: { agent: string; customer: string };
  /** Latest AI copilot suggestions fired after each customer final. */
  copilotSuggestions: CopilotSuggestion[];
  /**
   * Latest structured ConversationStateFrame from the Phase 3 intelligence
   * engine. Reduced by monotonic `version` so out-of-order arrivals can't
   * regress UI state. `null` until the first frame for the active call.
   */
  latestFrame: ConversationStateFrame | null;
  /**
   * Place an outbound call. Returns `{ mode: "AGENT_FIRST", sessionId,
   * openWorkspace }` when the channel is configured to ring the agent's
   * mobile first (the browser is NOT a participant). Callers should
   * navigate to /voice/<sessionId> ONLY when `openWorkspace=true`;
   * otherwise leave the agent on the current page (fire-and-forget).
   * Returns void in the IN_PLATFORM path (current Twilio SDK flow).
   */
  placeCall: (
    to: string,
    opts?: { contactName?: string; conversationId?: string; notes?: string },
  ) => Promise<void | { mode: "AGENT_FIRST"; sessionId: string | null; openWorkspace: boolean }>;
  /** Dial the agent's browser into an already-running conference (inbound answer flow). */
  joinConference: (conferenceName: string) => Promise<void>;
  hangup: () => void;
  toggleMute: () => void;
}

const VoiceCallContext = createContext<VoiceCallContextType | null>(null);

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

export function VoiceCallProvider({ children }: { children: React.ReactNode }) {
  const { token, user } = useAuth();
  const voiceFlags = useVoiceFlags();

  const [state, setState] = useState<CallState>("idle");
  const [call, setCall] = useState<CallInfo | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [committed, setCommitted] = useState<CommittedUtterance[]>([]);
  const [currentUtterance, setCurrentUtterance] = useState<{ agent: string; customer: string }>({ agent: "", customer: "" });
  const [copilotSuggestions, setCopilotSuggestions] = useState<CopilotSuggestion[]>([]);
  const [latestFrame, setLatestFrame] = useState<ConversationStateFrame | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  /** True after a 503/no_active_voice_channel response — halts retry until re-armed. */
  const [noActiveChannel, setNoActiveChannel] = useState(false);

  const deviceRef = useRef<Device | null>(null);
  const twilioTokenRef = useRef<string | null>(null);
  const activeCallRef = useRef<Call | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Timestamp (ms) of the last failed token attempt — used for the focus re-arm heuristic. */
  const lastTokenAttemptRef = useRef<number>(0);
  // Kept in sync with call?.conversationId so the socket handler (which closes
  // over a single `call` snapshot) can filter tenant-wide broadcasts down to
  // the current agent's call. Without this, every agent in the tenant sees
  // every call's suggestions.
  const activeConversationIdRef = useRef<string | undefined>(undefined);

  const resetToIdleSoon = useCallback(() => {
    window.setTimeout(() => {
      setState("idle");
      setCall(null);
      setElapsedMs(0);
      setError(null);
      setCommitted([]);
      setCurrentUtterance({ agent: "", customer: "" });
      setCopilotSuggestions([]);
      setLatestFrame(null);
    }, 2000);
  }, []);

  // Subscribe to live transcripts over Socket.IO. Conversation service bridges
  // any `voice.transcript` event published by voice-copilot to `tenant:{id}` rooms.
  // Resubscribe when the auth token arrives — AuthContext connects the socket
  // lazily after login, so a mount-time subscription would attach to a null socket.
  useEffect(() => {
    if (!token) return;

    let socket = getSocket();
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const handler = (data: LiveTranscript) => {
      if (!data || typeof data !== "object" || !data.speaker || !data.text) return;
      const speaker = data.speaker;
      if (data.isFinal) {
        // Commit the utterance + clear the live line for this speaker.
        setCommitted((prev) => [
          ...prev.slice(-199),
          { speaker, text: data.text, ts: data.ts, seq: data.seq },
        ]);
        setCurrentUtterance((prev) => ({ ...prev, [speaker]: "" }));
      } else {
        setCurrentUtterance((prev) => ({ ...prev, [speaker]: data.text }));
      }
    };

    // Server-side call-ended fallback — if voice-copilot ends the session
    // (stop frame, reaper, STT overload), catch it here so the UI doesn't
    // hang waiting for Twilio's client-side disconnect event. Also clear
    // any lingering live interims so the UI settles on committed finals.
    const endedHandler = (data: any) => {
      if (!data?.conversationId) return;
      setState((prev) => (prev === "idle" ? prev : "ended"));
      setCurrentUtterance({ agent: "", customer: "" });
    };

    // AI copilot suggestions — fired by ai-service after each customer final
    // (debounced 1500ms). Expected payload: { conversationId, suggestions: [...] }.
    // publishEvent broadcasts to the entire tenant room, so filter down to
    // the conversation this agent is actively on.
    const suggestionsHandler = (data: any) => {
      if (!data || !Array.isArray(data.suggestions)) return;
      if (!data.conversationId || data.conversationId !== activeConversationIdRef.current) return;
      setCopilotSuggestions(data.suggestions.slice(0, 5));
    };

    // Phase 3: structured ConversationStateFrame from the intelligence engine.
    // Replaces the chat-shaped suggestions array on the new path. Reduced by
    // monotonic `version` — late frames are dropped. Coexists with the
    // legacy suggestionsHandler during Phase 3.
    const frameHandler = (data: any) => {
      if (!data || !data.frame || typeof data.frame !== "object") return;
      const frame = data.frame as ConversationStateFrame;
      if (!frame.conversationId || frame.conversationId !== activeConversationIdRef.current) return;
      if (typeof frame.version !== "number") return;
      setLatestFrame((prev) => (prev && prev.version >= frame.version ? prev : frame));

      // Bridge: populate the copilot suggestion list from the frame's
      // `suggestedActions[]`. The legacy `voice.copilot.suggestions` event
      // is no longer published by the live runner, so without this bridge
      // the live-call UI shows "Listening — hints appear after the customer speaks."
      // forever even though the backend is producing perfectly good frames.
      if (Array.isArray(frame.suggestedActions) && frame.suggestedActions.length > 0) {
        const mapped: CopilotSuggestion[] = frame.suggestedActions.slice(0, 5).map((a, i) => ({
          id: `frame:v${frame.version}:${i}`,
          title:
            a.urgency === "high" ? "Act now" :
            a.urgency === "medium" ? "Consider" : "Hint",
          body: a.text,
          text: a.rationale || a.text,
          kind: a.urgency,
          confidence: 1,
        }));
        setCopilotSuggestions(mapped);
      } else {
        setCopilotSuggestions([]);
      }
    };

    const attach = () => {
      const s = getSocket();
      if (!s) return false;
      socket = s;
      s.on("voice.transcript", handler);
      s.on("voice.session.ended", endedHandler);
      s.on("voice.copilot.suggestions", suggestionsHandler);
      s.on("voice.frame.updated", frameHandler);
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
        socket.off("voice.transcript", handler);
        socket.off("voice.session.ended", endedHandler);
        socket.off("voice.copilot.suggestions", suggestionsHandler);
        socket.off("voice.frame.updated", frameHandler);
      }
    };
  }, [token]);

  // Mirror the active call's conversationId into a ref so the socket handler
  // (attached once per token) can always read the current value without
  // re-attaching on every call state change.
  useEffect(() => {
    activeConversationIdRef.current = call?.conversationId;
  }, [call?.conversationId]);

  const stopTimer = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const startTimer = useCallback((startedAt: number) => {
    stopTimer();
    tickRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 500);
  }, [stopTimer]);

  // Fetch the Twilio AccessToken up-front — but DO NOT construct the Device
  // until the user clicks Call. Chrome blocks AudioContext.start() outside
  // a user gesture, which silently produces one-way audio.
  //
  // Guards:
  //  1. Skip entirely if voiceCopilotEnabled is false (or still loading).
  //  2. Skip entirely if hasActiveVoiceChannel is false — the tenant hasn't
  //     onboarded any Twilio channel yet, so the token endpoint will 503
  //     `no_active_voice_channel`. Save the round-trip. The flag flips back
  //     to true via the wizard's "voice-channel:activated" event, which
  //     invalidates the flags cache and re-runs this effect.
  //  3. Skip if noActiveChannel is true — a previous attempt got a
  //     503/no_active_voice_channel response. Re-arm via the
  //     "voice-channel:activated" event or window.focus (>30 s heuristic).
  useEffect(() => {
    if (!token || voiceFlags.loading || !voiceFlags.voiceCopilotEnabled || !voiceFlags.hasActiveVoiceChannel) {
      // Clean up any existing device when the feature turns off OR the
      // tenant has no active channel anymore.
      if (!voiceFlags.loading && (!voiceFlags.voiceCopilotEnabled || !voiceFlags.hasActiveVoiceChannel)) {
        if (deviceRef.current) {
          try { deviceRef.current.destroy(); } catch { /* ignore */ }
          deviceRef.current = null;
        }
        twilioTokenRef.current = null;
        setIsReady(false);
        setNoActiveChannel(false);
      }
      if (!token) {
        if (deviceRef.current) {
          try { deviceRef.current.destroy(); } catch { /* ignore */ }
          deviceRef.current = null;
        }
        twilioTokenRef.current = null;
        setIsReady(false);
      }
      return;
    }

    if (noActiveChannel) return;

    let cancelled = false;
    lastTokenAttemptRef.current = Date.now();
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/voice-copilot/token`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const errCode = body.error || `token_fetch_failed:${res.status}`;
          if (res.status === 503 && body.error === "no_active_voice_channel") {
            if (!cancelled) {
              // eslint-disable-next-line no-console
              console.warn("[voice] no active voice channel configured — token fetch suppressed until channel is activated.");
              setNoActiveChannel(true);
              setIsReady(false);
            }
            return;
          }
          throw new Error(errCode);
        }
        const data = await res.json() as { token: string };
        if (cancelled) return;
        twilioTokenRef.current = data.token;
        setIsReady(true);
      } catch (err) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error("[voice] token fetch failed:", err);
        setError(err instanceof Error ? err.message : "init_failed");
        setIsReady(false);
      }
    })();

    return () => {
      cancelled = true;
      stopTimer();
      // CRITICAL — do NOT destroy the device while a call is live. This
      // cleanup runs on every dep change (e.g., voiceFlags settling from
      // loading=true to loading=false right after the agent clicks Call),
      // and an unconditional destroy() kills the in-flight Twilio Voice
      // SDK call mid-handshake. The agent leg drops, conference ends
      // within ~150ms of participant-join, and the customer never gets
      // dialed (404 on dialConferenceParticipant). Only tear down when
      // there's no active connection to lose; the guarded branches above
      // (no token / flags off / no active channel) already destroy
      // explicitly when we really do need to drop the device.
      if (!activeCallRef.current && deviceRef.current) {
        try { deviceRef.current.destroy(); } catch { /* ignore */ }
        deviceRef.current = null;
        twilioTokenRef.current = null;
        setIsReady(false);
      }
    };
  }, [token, voiceFlags.loading, voiceFlags.voiceCopilotEnabled, voiceFlags.hasActiveVoiceChannel, noActiveChannel, stopTimer]);

  // Re-arm the token fetch when a voice channel comes online.
  // Dispatched externally via: window.dispatchEvent(new Event("voice-channel:activated"))
  useEffect(() => {
    const onActivated = () => {
      setNoActiveChannel(false);
    };
    window.addEventListener("voice-channel:activated", onActivated);
    return () => window.removeEventListener("voice-channel:activated", onActivated);
  }, []);

  // Re-arm on window focus if noActiveChannel is true and last attempt was >30 s ago.
  useEffect(() => {
    const onFocus = () => {
      if (noActiveChannel && Date.now() - lastTokenAttemptRef.current > 30_000) {
        setNoActiveChannel(false);
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [noActiveChannel]);

  // Lazily create + register the Twilio Device on first call. Must run inside
  // a user-gesture handler so Chrome lets the AudioContext start.
  const ensureDevice = useCallback(async (): Promise<Device> => {
    if (deviceRef.current) return deviceRef.current;
    const tok = twilioTokenRef.current;
    if (!tok) throw new Error("twilio_token_not_ready");
    const device = new Device(tok, {
      logLevel: "warn",
      codecPreferences: ["opus" as any, "pcmu" as any],
    });
    try {
      await device.audio?.setAudioConstraints({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      } as MediaTrackConstraints);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[voice] setAudioConstraints failed:", e);
    }
    device.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[voice] Device error:", err);
      setError(err?.message || "device_error");
      setState("error");
    });
    await device.register();
    deviceRef.current = device;
    return device;
  }, []);

  const placeCall = useCallback<VoiceCallContextType["placeCall"]>(async (to, opts) => {
    if (state !== "idle" && state !== "ended" && state !== "error") {
      throw new Error("already_on_call");
    }
    if (noActiveChannel) {
      throw new Error("no_active_voice_channel");
    }
    if (!token) {
      throw new Error("not_authenticated");
    }

    setError(null);

    // Channel outboundMode gate. The server decides whether this call
    // uses the browser SDK (IN_PLATFORM) or rings the agent's mobile
    // first (AGENT_FIRST). For AGENT_FIRST we skip device.connect()
    // entirely — the agent talks via their phone, not the browser.
    let gateMode: "IN_PLATFORM" | "AGENT_FIRST" = "IN_PLATFORM";
    let agentFirstSessionId: string | null = null;
    let agentFirstOpenWorkspace = true;
    try {
      const { startOutboundVoiceCall } = await import("@/lib/api");
      const { data } = await startOutboundVoiceCall(token, to, {
        conversationId: opts?.conversationId,
        notes: opts?.notes,
      });
      gateMode = data.mode;
      if (data.mode === "AGENT_FIRST") {
        agentFirstSessionId = data.sessionId;
        agentFirstOpenWorkspace = data.openWorkspace;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[voice] start-outbound gate failed:", err);
      setError(err instanceof Error ? err.message : "start_outbound_failed");
      setState("error");
      resetToIdleSoon();
      throw err;
    }

    if (gateMode === "AGENT_FIRST") {
      // The platform is REST-dialing the agent's mobile right now.
      // The browser is NOT participating in this call — don't open
      // the Twilio Device, don't change call state. Whether to open
      // the workspace page is the per-channel toggle (openWorkspace).
      return {
        mode: "AGENT_FIRST",
        sessionId: agentFirstSessionId,
        openWorkspace: agentFirstOpenWorkspace,
      };
    }

    setState("connecting");
    const info: CallInfo = { to, ...(opts || {}) };
    setCall(info);

    try {
      // Force mic permission + confirm an input stream exists before Twilio
      // tries to use it. Without this, Chrome can silently bind an empty
      // stream and the remote party hears nothing even though we hear them.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        // eslint-disable-next-line no-console
        console.info("[voice] mic permission OK");
      } catch (micErr) {
        // eslint-disable-next-line no-console
        console.error("[voice] getUserMedia failed:", micErr);
        throw new Error("microphone_access_denied");
      }

      const device = await ensureDevice();

      const params: Record<string, string> = { To: to };
      if (user?.tenantId) params.tenantId = user.tenantId;
      if (user?.id) params.agentId = user.id;
      if (opts?.conversationId) params.conversationId = opts.conversationId;
      if (opts?.notes) params.notes = opts.notes;

      const connection = await device.connect({ params });
      activeCallRef.current = connection;

      connection.on("ringing", () => setState("ringing"));
      connection.on("accept", () => {
        const startedAt = Date.now();
        setCall((c) => (c ? { ...c, startedAt } : c));
        setState("active");
        startTimer(startedAt);
      });
      connection.on("disconnect", () => {
        stopTimer();
        activeCallRef.current = null;
        setState("ended");
        resetToIdleSoon();
      });
      connection.on("cancel", () => {
        stopTimer();
        activeCallRef.current = null;
        setState("ended");
        resetToIdleSoon();
      });
      connection.on("reject", () => {
        stopTimer();
        activeCallRef.current = null;
        setState("ended");
        resetToIdleSoon();
      });
      connection.on("error", (err: Error) => {
        // eslint-disable-next-line no-console
        console.error("[voice] Call error:", err);
        setError(err?.message || "call_error");
        setState("error");
        stopTimer();
        activeCallRef.current = null;
        resetToIdleSoon();
      });
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "connect_failed");
      resetToIdleSoon();
      throw err;
    }
  }, [state, noActiveChannel, startTimer, stopTimer, resetToIdleSoon, ensureDevice, user?.tenantId]);

  const joinConference = useCallback(async (conferenceName: string): Promise<void> => {
    if (state !== "idle" && state !== "ended" && state !== "error") {
      throw new Error("already_on_call");
    }
    if (noActiveChannel) {
      throw new Error("no_active_voice_channel");
    }

    setError(null);
    setState("connecting");

    try {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch (micErr) {
        // eslint-disable-next-line no-console
        console.error("[voice] getUserMedia failed:", micErr);
        throw new Error("microphone_access_denied");
      }

      const device = await ensureDevice();

      const params: Record<string, string> = { joinConference: conferenceName };
      if (user?.tenantId) params.tenantId = user.tenantId;

      const connection = await device.connect({ params });
      activeCallRef.current = connection;

      connection.on("ringing", () => setState("ringing"));
      connection.on("accept", () => {
        const startedAt = Date.now();
        setCall((c) => (c ? { ...c, startedAt } : c));
        setState("active");
        startTimer(startedAt);
      });
      connection.on("disconnect", () => {
        stopTimer();
        activeCallRef.current = null;
        setState("ended");
        resetToIdleSoon();
      });
      connection.on("cancel", () => {
        stopTimer();
        activeCallRef.current = null;
        setState("ended");
        resetToIdleSoon();
      });
      connection.on("reject", () => {
        stopTimer();
        activeCallRef.current = null;
        setState("ended");
        resetToIdleSoon();
      });
      connection.on("error", (err: Error) => {
        // eslint-disable-next-line no-console
        console.error("[voice] joinConference error:", err);
        setError(err?.message || "call_error");
        setState("error");
        stopTimer();
        activeCallRef.current = null;
        resetToIdleSoon();
      });
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "connect_failed");
      resetToIdleSoon();
      throw err;
    }
  }, [state, noActiveChannel, startTimer, stopTimer, resetToIdleSoon, ensureDevice, user?.tenantId]);

  const hangup = useCallback(() => {
    const active = activeCallRef.current;
    if (active) {
      try { active.disconnect(); } catch { /* ignore */ }
    } else if (deviceRef.current) {
      try { deviceRef.current.disconnectAll(); } catch { /* ignore */ }
    }
    setIsMuted(false);
  }, []);

  const toggleMute = useCallback(() => {
    const active = activeCallRef.current;
    if (!active) return;
    setIsMuted((prev) => {
      const next = !prev;
      try { active.mute(next); } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[voice] mute toggle failed:", err);
        return prev;
      }
      return next;
    });
  }, []);

  const value: VoiceCallContextType = {
    state,
    call,
    elapsedMs,
    error,
    isReady,
    isMuted,
    committedTranscripts: committed,
    currentUtterance,
    copilotSuggestions,
    latestFrame,
    placeCall,
    joinConference,
    hangup,
    toggleMute,
  };

  return <VoiceCallContext.Provider value={value}>{children}</VoiceCallContext.Provider>;
}

export function useVoiceCall(): VoiceCallContextType {
  const ctx = useContext(VoiceCallContext);
  if (!ctx) throw new Error("useVoiceCall must be used within VoiceCallProvider");
  return ctx;
}
