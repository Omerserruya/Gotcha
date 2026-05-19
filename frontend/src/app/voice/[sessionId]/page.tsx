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
import { closeConversation, getVoiceSession, type VoiceCallSession } from "@/lib/api";
import { normalizeE164 } from "@/lib/phone";
import { TranscriptStage } from "@/components/voice/workspace/TranscriptStage";
import { CallRightPanel } from "@/components/voice/workspace/CallRightPanel";
import { useCueRecorder } from "@/lib/cue-recorder";
import { getSocket } from "@/lib/socket";

interface CallFrame {
  conversationId: string;
  version: number;
  stage: { id: string; name: string } | null;
  sentiment: { customer: number; escalationRisk: number } | null;
  missingFields: Array<{ field: string; required: boolean }>;
  urgency: "low" | "medium" | "high";
}

const TERMINAL_STATES = new Set(["ENDED", "FAILED", "MISSED"]);

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function SentimentDot({ value, risk }: { value?: number; risk?: number }) {
  // value: -1..1 (customer sentiment), risk: 0..1 (escalation)
  const v = typeof value === "number" ? value : 0;
  const r = typeof risk === "number" ? risk : 0;
  const high = r >= 0.6 || v <= -0.4;
  const ok = v >= 0.3 && r < 0.3;
  const cls = high ? "bg-rose-400" : ok ? "bg-emerald-400" : "bg-gray-400";
  const label = high ? "tense" : ok ? "positive" : "neutral";
  return (
    <span className="inline-flex items-center gap-1" title={`Sentiment: ${label}`}>
      <span className={clsx("inline-block w-1.5 h-1.5 rounded-full", cls, high && "animate-pulse")} />
      <span className="text-gray-400 uppercase tracking-wider text-[10px]">{label}</span>
    </span>
  );
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
  // Mobile-only slide-over for the call context panel. On desktop the panel
  // is always rendered as the right column; on phones it would push the
  // call stage off-screen, so we hide it under `md` and open it on demand
  // from the header toggle.
  const [mobileContextOpen, setMobileContextOpen] = useState(false);

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
  // on a stale dead session. MISSED gets a longer delay so the agent has
  // time to read the decline-reason banner before the redirect.
  useEffect(() => {
    if (!session) return;
    const state = (session.state || "").toUpperCase();
    if (TERMINAL_STATES.has(state)) {
      const delay = state === "MISSED" ? 2800 : 1500;
      const t = setTimeout(() => router.push("/conversations"), delay);
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
  // Single-mount recorder so /voice/[sessionId]/replay can reconstruct the
  // call after hangup. Mounted at the page level (not inside CallRightPanel,
  // which renders twice for mobile/desktop) to avoid double-recording.
  useCueRecorder(sessionId, conversationId);

  // Subscribe to the Phase-3 ConversationStateFrame directly so the header
  // status strip works for inbound calls too (VoiceCallContext.latestFrame
  // only fires for self-placed outbound). Monotonic-version reducer so late
  // frames are dropped.
  const [frame, setFrame] = useState<CallFrame | null>(null);
  useEffect(() => {
    if (!conversationId) return;
    const socket = getSocket();
    if (!socket) return;
    const onFrame = (data: unknown) => {
      const d = data as { frame?: CallFrame };
      const f = d?.frame;
      if (!f || f.conversationId !== conversationId) return;
      if (typeof f.version !== "number") return;
      setFrame((prev) => (prev && prev.version >= f.version ? prev : f));
    };
    socket.on("voice.frame.updated", onFrame);
    return () => { socket.off("voice.frame.updated", onFrame); };
  }, [conversationId]);
  useEffect(() => { setFrame(null); }, [conversationId]);

  // Customer declined the outbound call (no-answer/busy/canceled/failed
  // before joining the conference). voice-copilot publishes this from
  // /twiml/customer-status — surfacing it here lets us render a brief
  // reason banner instead of an unexplained redirect.
  const [declineReason, setDeclineReason] = useState<string | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const socket = getSocket();
    if (!socket) return;
    const onDeclined = (data: unknown) => {
      const d = data as { sessionId?: string; reason?: string };
      if (!d || d.sessionId !== sessionId) return;
      setDeclineReason(d.reason ?? "no-answer");
    };
    socket.on("voice.session.declined", onDeclined);
    return () => { socket.off("voice.session.declined", onDeclined); };
  }, [sessionId]);

  // Spelling/code-switch detector output — emails/domains/URLs the LLM
  // reconstructed from a mixed Hebrew/English window. We render them as
  // confirmation chips so the rep can verify the parse before relying on
  // it (e.g. typing the email into a follow-up). Each chip carries a
  // confidence score; below 0.5 it's marked "needs confirmation".
  interface SpellingEntity {
    kind: "email" | "domain" | "url" | "name" | "phone" | "other";
    raw: string;
    normalized: string;
    confidence: number;
  }
  const [spellingEntities, setSpellingEntities] = useState<SpellingEntity[]>([]);
  useEffect(() => {
    if (!conversationId) return;
    const socket = getSocket();
    if (!socket) return;
    const onSpelling = (data: unknown) => {
      const d = data as {
        conversationId?: string;
        hints?: { normalizedEntities?: SpellingEntity[] };
      };
      if (!d || d.conversationId !== conversationId) return;
      const entities = d.hints?.normalizedEntities ?? [];
      if (entities.length === 0) return;
      // Keep last 6 unique-by-normalized so the chip strip doesn't grow
      // unbounded across a long call.
      setSpellingEntities((prev) => {
        const seen = new Set(prev.map((e) => e.normalized));
        const next = [...prev];
        for (const e of entities) {
          if (!e?.normalized) continue;
          if (seen.has(e.normalized)) continue;
          seen.add(e.normalized);
          next.push(e);
        }
        return next.slice(-6);
      });
    };
    socket.on("spelling.detected", onSpelling);
    return () => { socket.off("spelling.detected", onSpelling); };
  }, [conversationId]);
  useEffect(() => { setSpellingEntities([]); }, [conversationId]);

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
      // Optimistically close the linked Conversation so the call doesn't
      // linger as an open chat in the inbox. The backend voice-auto-close
      // subscriber is the safety net; this is the user-clicked-hangup path.
      // Fire-and-forget — a failure here shouldn't block the redirect.
      if (token && session.conversationId) {
        closeConversation(token, session.conversationId).catch(() => { /* ignore */ });
      }
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
    <div className="flex flex-col md:flex-row h-[100dvh] md:h-[calc(100vh-16px)] md:gap-3 md:p-2">
      {/* Stage — full-height on mobile so the call UI is the primary surface
          and isn't pushed off-screen by the context panel stacked below.
          The context panel is hidden under md and opened via the header
          toggle as a slide-over sheet. */}
      <div
        className={clsx(
          "flex-1 min-h-0 flex flex-col text-gray-100 overflow-hidden md:rounded-2xl shadow-subtle",
        )}
        style={{ background: "linear-gradient(135deg, #05070d 0%, #0f172a 50%, #05070d 100%)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 md:px-10 py-3 md:py-4 gap-2">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <span
              className={clsx(
                "inline-block w-2 h-2 rounded-full shrink-0",
                stateLabel === "ACTIVE" ? "bg-emerald-400 animate-pulse" : isLive ? "bg-amber-400" : "bg-gray-500",
              )}
            />
            <div className="flex flex-col leading-tight min-w-0">
              <span className="text-sm font-medium text-gray-100 truncate">{customerName}</span>
              <span className="text-[11px] md:text-xs text-gray-500 tabular-nums">
                {stateLabel} {isLive ? `· ${formatDuration(elapsedMs)}` : ""}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Mobile-only toggle for the context panel slide-over. */}
            <button
              type="button"
              onClick={() => setMobileContextOpen((v) => !v)}
              className="md:hidden px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white/10 text-gray-100 ring-1 ring-white/10 hover:bg-white/20"
              aria-label="toggle context panel"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5" />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleMute}
              disabled={!isLocalDevice}
              aria-label={isLocalDevice && voice.isMuted ? t("voice.workspace.header.unmuteButton") : t("voice.workspace.header.muteButton")}
              className={clsx(
                "inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-sm font-medium transition ring-1",
                !isLocalDevice && "bg-white/5 text-gray-500 ring-white/10 cursor-not-allowed",
                isLocalDevice && voice.isMuted && "bg-amber-400 text-gray-900 ring-amber-300",
                isLocalDevice && !voice.isMuted && "bg-white/15 text-gray-100 ring-white/20 hover:bg-white/25",
              )}
            >
              {isLocalDevice && voice.isMuted ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 14a5 5 0 01-5 5m-5-5V9a5 5 0 015-5m0 0a5 5 0 015 5v2m-5 5v3m-4 0h8M3 3l18 18" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m7 7v4m-4 0h8m-4-9a3 3 0 01-3-3V6a3 3 0 116 0v4a3 3 0 01-3 3z" />
                </svg>
              )}
              <span>{isLocalDevice && voice.isMuted ? t("voice.workspace.header.unmuteButton") : t("voice.workspace.header.muteButton")}</span>
            </button>
            <button
              type="button"
              onClick={handleHangup}
              aria-label={t("voice.workspace.header.hangupButton")}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-red-600 text-white text-sm font-semibold hover:bg-red-700 transition shadow-lg ring-1 ring-red-900/40"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08C.11 12.9 0 12.65 0 12.38s.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71s-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.1-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.51-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
              </svg>
              <span>{t("voice.workspace.header.hangupButton")}</span>
            </button>
          </div>
        </div>

        {/* Decline banner — shown when the customer didn't pick up the
            outbound call (no-answer/busy/canceled/failed). Replaces the
            silent terminal-state redirect with a one-line reason so the
            agent knows what just happened. */}
        {(stateLabel === "MISSED" || declineReason) && (
          <div className="px-4 md:px-10 mb-2">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-amber-400/15 text-amber-200 ring-1 ring-amber-300/30 text-xs">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              <span>
                {declineReason === "busy"
                  ? t("voice.workspace.declined.busy")
                  : declineReason === "failed"
                  ? t("voice.workspace.declined.failed")
                  : t("voice.workspace.declined.noAnswer")}
              </span>
            </div>
          </div>
        )}

        {/* Status strip — sentiment dot · stage · missing-data badge.
            Only renders once the intelligence engine has produced a frame.
            Stays terse so the agent's eye doesn't get pulled here mid-call. */}
        {isLive && frame && (() => {
          const required = Array.isArray(frame.missingFields)
            ? frame.missingFields.filter((f) => f && f.required)
            : [];
          return (
            <div className="px-4 md:px-10 -mt-1 mb-2 flex items-center gap-3 text-[11px] text-gray-300">
              <SentimentDot value={frame.sentiment?.customer} risk={frame.sentiment?.escalationRisk} />
              {frame.stage?.name && (
                <span className="text-gray-300 truncate">{frame.stage.name}</span>
              )}
              {required.length > 0 && (
                <span className="px-1.5 py-0.5 rounded-md bg-amber-400/15 text-amber-200 ring-1 ring-amber-300/30">
                  Missing: {required.map((f) => f.field).slice(0, 2).join(", ")}
                  {required.length > 2 ? "…" : ""}
                </span>
              )}
              {frame.urgency === "high" && (
                <span className="px-1.5 py-0.5 rounded-md bg-rose-500/20 text-rose-200 ring-1 ring-rose-400/40 uppercase tracking-wider text-[10px] font-semibold">
                  Act now
                </span>
              )}
            </div>
          );
        })()}

        {/* Spelling/code-switch entity chips — high-signal reconstructions
            of emails / domains / URLs spoken on a Hebrew-English call.
            Click-to-copy because the most common follow-on action is
            pasting the email/URL into a follow-up message. Confidence
            below 0.5 gets a "?" marker so the rep verbally confirms. */}
        {spellingEntities.length > 0 && (
          <div className="px-4 md:px-10 mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="text-gray-400 uppercase tracking-wider text-[10px]">
              {t("voice.workspace.spelling.heard")}
            </span>
            {spellingEntities.map((e, i) => (
              <button
                key={`${e.normalized}-${i}`}
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(e.normalized).catch(() => { /* ignore */ });
                }}
                className={clsx(
                  "inline-flex items-center gap-1 px-2 py-0.5 rounded-md ring-1 font-mono",
                  e.confidence >= 0.5
                    ? "bg-sky-400/15 text-sky-200 ring-sky-300/30 hover:bg-sky-400/25"
                    : "bg-amber-400/15 text-amber-200 ring-amber-300/30 hover:bg-amber-400/25",
                )}
                title={t("voice.workspace.spelling.copyHint")}
              >
                <span>{e.normalized}</span>
                {e.confidence < 0.5 && <span className="opacity-70">?</span>}
              </button>
            ))}
          </div>
        )}

        <TranscriptStage
          committedTranscripts={voice.committedTranscripts}
          currentUtterance={voice.currentUtterance}
          agentName={agentName}
          customerName={customerName}
          isLive={isLive}
        />
      </div>

      {/* Right panel — desktop sidebar AND mobile slide-over.
          The mobile slide-over is rendered as a fixed full-screen overlay
          so it doesn't compete with the call stage for vertical space. */}
      <div className="hidden md:flex md:w-[380px] flex-shrink-0 flex-col md:rounded-2xl md:overflow-hidden">
        <CallRightPanel sessionId={session.id} conversationId={conversationId} />
      </div>
      {mobileContextOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <button
            type="button"
            aria-label="close context"
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileContextOpen(false)}
          />
          <div className="relative ml-auto h-full w-[88vw] max-w-sm bg-white shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
              <span className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
                {t("voice.workspace.header.contextTitle") || "Context"}
              </span>
              <button
                type="button"
                onClick={() => setMobileContextOpen(false)}
                className="text-gray-500 hover:text-gray-900 p-1"
                aria-label="close"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <CallRightPanel sessionId={session.id} conversationId={conversationId} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
