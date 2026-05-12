"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import clsx from "clsx";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { useVoiceCall } from "@/context/VoiceCallContext";
import { useVoiceSessions } from "@/contexts/VoiceSessionsContext";
import { useVoiceFlags } from "@/lib/use-voice-flags";
import { getVoiceSession, type VoiceCallSession } from "@/lib/api";
import { normalizeE164 } from "@/lib/phone";
import { TranscriptStage } from "@/components/voice/workspace/TranscriptStage";
import { CallRightPanel } from "@/components/voice/workspace/CallRightPanel";

const TERMINAL_STATES = new Set(["ENDED", "FAILED", "MISSED"]);

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatPhone(num: string): string {
  const normalized = normalizeE164(num);
  const display = normalized || num;
  if (!display) return "";
  if (!display.startsWith("+")) return display;
  return display.replace(/(\+\d{1,3})(\d{3})(\d{3})(\d+)/, "$1 $2 $3 $4").trim();
}

export default function VoiceWorkspacePage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params?.sessionId || "";
  return (
    <AppLayout>
      <VoiceWorkspaceInner sessionId={sessionId} />
    </AppLayout>
  );
}

function VoiceWorkspaceInner({ sessionId }: { sessionId: string }) {
  const flags = useVoiceFlags();
  const { t } = useI18n();
  const router = useRouter();
  const { token, user } = useAuth();
  const voice = useVoiceCall();
  const { live, allLive, ringing, hangup: hangupSession } = useVoiceSessions();
  const [session, setSession] = useState<VoiceCallSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  void tick;

  // Prefer the live socket-fed session (kept up to date by VoiceSessionsContext).
  // Fall back to a one-shot fetch when the context doesn't carry this id (e.g.
  // deep link from outside the inbox).
  useEffect(() => {
    if (!sessionId) return;
    const fromCtx =
      (live && live.id === sessionId) ? live :
      allLive.find((s) => s.id === sessionId) ||
      ringing.find((s) => s.id === sessionId) ||
      null;
    if (fromCtx) {
      setSession(fromCtx);
      return;
    }
    if (!token) return;
    let cancelled = false;
    getVoiceSession(token, sessionId)
      .then((res) => {
        if (!cancelled) setSession(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "failed_to_load");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, token, live, allLive, ringing]);

  // Auto-redirect when the call terminates so the workspace never lingers
  // on a stale dead session.
  useEffect(() => {
    if (!session) return;
    const state = (session.state || "").toUpperCase();
    if (TERMINAL_STATES.has(state)) {
      const t = setTimeout(() => router.push("/conversations"), 1500);
      return () => clearTimeout(t);
    }
  }, [session, router]);

  // Auto-join the inbound conference if we land on this page with a claimed
  // session (CONNECTING/ACTIVE) but the local Twilio Device isn't connected yet.
  // This handles direct navigation to /voice/[sessionId] and page refreshes.
  useEffect(() => {
    if (!session) return;
    if (!session.callSid) return;
    const sessionState = (session.state || "").toUpperCase();
    if (sessionState !== "CONNECTING" && sessionState !== "ACTIVE") return;
    if ((session.direction as string).toUpperCase() !== "INBOUND") return;
    // Only dial in if the Device is not already in use.
    if (voice.state !== "idle" && voice.state !== "ended" && voice.state !== "error") return;
    voice.joinConference(`inbound-${session.callSid}`).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[voice-workspace] auto-join conference failed:", err);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.state, session?.callSid, session?.direction]);

  const conversationId = session?.conversationId ?? null;
  const isLocalDevice = voice.state !== "idle" && voice.state !== "ended";

  const elapsedMs = useMemo(() => {
    if (isLocalDevice) return voice.elapsedMs;
    if (!session) return 0;
    const ref = session.answeredAt || session.claimedAt || session.startedAt;
    if (!ref) return 0;
    return Date.now() - new Date(ref).getTime();
  }, [isLocalDevice, voice.elapsedMs, session, tick]);

  async function handleHangup() {
    if (!session) return;
    try {
      if (isLocalDevice) voice.hangup();
      // Route through the context so the session is dropped from `live`/
      // `ringing`/`allLive` immediately — otherwise the ActiveCallBar lingers
      // until a websocket state push arrives.
      await hangupSession(session.id);
      // Optimistically mark the local session terminal so the redirect effect
      // dismisses this screen even if the websocket state-change is slow.
      setSession((prev) => (prev ? { ...prev, state: "ENDED" } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "hangup_failed");
    }
  }

  function handleMute() {
    if (isLocalDevice) voice.toggleMute();
  }

  if (flags.loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        {t("voice.workspace.loadingWorkspace")}
      </div>
    );
  }

  if (!flags.voiceCopilotEnabled) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
        <h1 className="text-2xl font-semibold text-gray-800 mb-2">404</h1>
        <p className="text-sm text-gray-500">{t("voice.workspace.pageNotAvailable")}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
        <p className="text-sm text-red-600">{error}</p>
        <button
          type="button"
          onClick={() => router.push("/conversations")}
          className="mt-3 px-3 py-1.5 text-xs rounded-lg bg-gray-100 hover:bg-gray-200"
        >
          {t("voice.workspace.backToInbox")}
        </button>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        {t("voice.workspace.loadingCall")}
      </div>
    );
  }

  const stateLabel = session.state || (session.status || "").toUpperCase();
  const isLive = !TERMINAL_STATES.has((session.state || "").toUpperCase());
  const customerName = formatPhone(session.customerNumber) || session.customerNumber;
  const agentName = user?.name || "You";

  return (
    <div className="flex flex-col md:flex-row h-[calc(100vh-16px)] md:gap-3 md:p-2">
      {/* Left half — stage */}
      <div
        className={clsx(
          "flex-1 flex flex-col text-gray-100 overflow-hidden md:rounded-2xl shadow-subtle",
        )}
        style={{ background: "linear-gradient(135deg, #05070d 0%, #0f172a 50%, #05070d 100%)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 md:px-10 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <span
              className={clsx(
                "inline-block w-2 h-2 rounded-full shrink-0",
                stateLabel === "ACTIVE" ? "bg-emerald-400 animate-pulse" : isLive ? "bg-amber-400" : "bg-gray-500",
              )}
            />
            <div className="flex flex-col leading-tight min-w-0">
              <span className="text-sm font-medium text-gray-100 truncate">{customerName}</span>
              <span className="text-xs text-gray-500 tabular-nums">
                {stateLabel} {isLive ? `· ${formatDuration(elapsedMs)}` : ""}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleMute}
              disabled={!isLocalDevice}
              className={clsx(
                "px-3 py-1.5 rounded-lg text-xs font-medium transition ring-1",
                !isLocalDevice && "bg-white/5 text-gray-500 ring-white/10 cursor-not-allowed",
                isLocalDevice && voice.isMuted && "bg-amber-400/20 text-amber-200 ring-amber-300/40",
                isLocalDevice && !voice.isMuted && "bg-white/10 text-gray-100 ring-white/10 hover:bg-white/20",
              )}
            >
              {isLocalDevice && voice.isMuted ? t("voice.workspace.header.unmuteButton") : t("voice.workspace.header.muteButton")}
            </button>
            <button
              type="button"
              onClick={handleHangup}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-600 text-white hover:bg-red-700 transition"
            >
              {t("voice.workspace.header.hangupButton")}
            </button>
          </div>
        </div>

        <TranscriptStage
          committedTranscripts={voice.committedTranscripts}
          currentUtterance={voice.currentUtterance}
          agentName={agentName}
          customerName={customerName}
          isLive={isLive}
        />
      </div>

      {/* Right half — context */}
      <div className="w-full md:w-[380px] flex-shrink-0 flex flex-col md:rounded-2xl md:overflow-hidden">
        <CallRightPanel sessionId={session.id} conversationId={conversationId} />
      </div>
    </div>
  );
}
