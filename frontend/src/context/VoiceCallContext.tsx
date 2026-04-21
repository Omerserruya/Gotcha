"use client";

import React, { createContext, useContext, useState, useRef, useEffect, useCallback } from "react";
import { Device, Call } from "@twilio/voice-sdk";
import { useAuth } from "@/context/AuthContext";
import { getSocket } from "@/lib/socket";

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
  placeCall: (to: string, opts?: { contactName?: string; conversationId?: string; notes?: string }) => Promise<void>;
  hangup: () => void;
  toggleMute: () => void;
}

const VoiceCallContext = createContext<VoiceCallContextType | null>(null);

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

export function VoiceCallProvider({ children }: { children: React.ReactNode }) {
  const { token, user } = useAuth();

  const [state, setState] = useState<CallState>("idle");
  const [call, setCall] = useState<CallInfo | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [committed, setCommitted] = useState<CommittedUtterance[]>([]);
  const [currentUtterance, setCurrentUtterance] = useState<{ agent: string; customer: string }>({ agent: "", customer: "" });
  const [isMuted, setIsMuted] = useState(false);

  const deviceRef = useRef<Device | null>(null);
  const twilioTokenRef = useRef<string | null>(null);
  const activeCallRef = useRef<Call | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const resetToIdleSoon = useCallback(() => {
    window.setTimeout(() => {
      setState("idle");
      setCall(null);
      setElapsedMs(0);
      setError(null);
      setCommitted([]);
      setCurrentUtterance({ agent: "", customer: "" });
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

    const attach = () => {
      const s = getSocket();
      if (!s) return false;
      socket = s;
      s.on("voice.transcript", handler);
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
        socket.off("voice.transcript", handler);
        socket.off("voice.session.ended", endedHandler);
      }
    };
  }, [token]);

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
  useEffect(() => {
    if (!token) {
      if (deviceRef.current) {
        try { deviceRef.current.destroy(); } catch { /* ignore */ }
        deviceRef.current = null;
      }
      twilioTokenRef.current = null;
      setIsReady(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/voice-copilot/token`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `token_fetch_failed:${res.status}`);
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
      if (deviceRef.current) {
        try { deviceRef.current.destroy(); } catch { /* ignore */ }
        deviceRef.current = null;
      }
      twilioTokenRef.current = null;
      setIsReady(false);
    };
  }, [token, stopTimer]);

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

    setError(null);
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
  }, [state, startTimer, stopTimer, resetToIdleSoon, ensureDevice, user?.tenantId]);

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
    placeCall,
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
