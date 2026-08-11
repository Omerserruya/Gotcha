"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useDynamicParam } from "@/lib/useRouteParam";
import clsx from "clsx";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { useVoiceCall } from "@/context/VoiceCallContext";
import { useVoiceSessions } from "@/contexts/VoiceSessionsContext";
import { useVoiceFlags } from "@/lib/use-voice-flags";
import {
  addVoiceSessionParticipant,
  closeConversation,
  getVoiceSession,
  getVoiceSessionParticipants,
  kickVoiceParticipant,
  setVoiceParticipantHold,
  setVoiceSessionCustomerHold,
  voiceSessionAgentLeave,
  type VoiceCallSession,
  type VoiceSessionParticipant,
} from "@/lib/api";
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
  const sessionIdFromRoute = useDynamicParam("sessionId", "/voice/[sessionId]");
  const sessionId = sessionIdFromRoute;
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

  // Missed-call callback follow-up: MissedCallsSection writes a
  // {newSessionId → { missedSessionId, customerNumber }} entry to
  // localStorage when an agent clicks Call back. When THIS session
  // reaches ACTIVE (= customer actually picked up), promote the missed
  // row AND the customer phone to the dismissed sets so it (and any
  // sibling missed calls from the same number) stop nagging the inbox.
  // Unanswered callbacks never reach ACTIVE, so the row stays put.
  useEffect(() => {
    if (!session) return;
    const state = (session.state || "").toUpperCase();
    if (state !== "ACTIVE") return;
    try {
      const PENDING_KEY = "chatcenter:pendingMissedHandle";
      const DISMISS_KEY = "chatcenter:dismissedMissedCalls";
      const DISMISS_PHONES_KEY = "chatcenter:dismissedMissedPhones";
      const raw = localStorage.getItem(PENDING_KEY);
      if (!raw) return;
      const map = JSON.parse(raw) as Record<
        string,
        string | { missedSessionId: string; customerNumber: string | null }
      >;
      const entry = map[sessionId];
      if (!entry) return;
      // Legacy (string) and current (object) shapes co-exist for one
      // bundle cycle while old tabs flush their pending state.
      const missedId = typeof entry === "string" ? entry : entry.missedSessionId;
      const customerNumber = typeof entry === "string" ? null : entry.customerNumber;
      const dismissedRaw = localStorage.getItem(DISMISS_KEY);
      const dismissed: string[] = dismissedRaw ? JSON.parse(dismissedRaw) : [];
      if (!dismissed.includes(missedId)) dismissed.push(missedId);
      localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed));
      if (customerNumber) {
        const phonesRaw = localStorage.getItem(DISMISS_PHONES_KEY);
        const phones: string[] = phonesRaw ? JSON.parse(phonesRaw) : [];
        if (!phones.includes(customerNumber)) phones.push(customerNumber);
        localStorage.setItem(DISMISS_PHONES_KEY, JSON.stringify(phones));
      }
      delete map[sessionId];
      localStorage.setItem(PENDING_KEY, JSON.stringify(map));
    } catch { /* parse/quota - degrade silently */ }
  }, [session?.state, sessionId]);

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
  // /twiml/customer-status - surfacing it here lets us render a brief
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

  // Spelling/code-switch detector output - emails/domains/URLs the LLM
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
      // `ringing`/`allLive` immediately - otherwise the ActiveCallBar lingers
      // until a websocket state push arrives.
      await hangupSession(session.id);
      // Optimistically close the linked Conversation so the call doesn't
      // linger as an open chat in the inbox. The backend voice-auto-close
      // subscriber is the safety net; this is the user-clicked-hangup path.
      // Fire-and-forget - a failure here shouldn't block the redirect.
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

  // Add-participant flow - opens a small inline panel with a phone input
  // that calls /api/voice-sessions/:id/add-participant. The added party
  // joins the live conference (3-way); their leg is `endConferenceOnExit:
  // false` so they can drop without ending the call.
  const [addPanelOpen, setAddPanelOpen] = useState(false);
  const [addParticipantNumber, setAddParticipantNumber] = useState("");
  const [addingParticipant, setAddingParticipant] = useState(false);
  const [addParticipantError, setAddParticipantError] = useState<string | null>(null);
  async function handleAddParticipant() {
    if (!token || !session) return;
    const to = addParticipantNumber.trim();
    if (!to) {
      setAddParticipantError(t("voice.workspace.addParticipant.errInvalid"));
      return;
    }
    setAddingParticipant(true);
    setAddParticipantError(null);
    try {
      await addVoiceSessionParticipant(token, session.id, to);
      setAddParticipantNumber("");
      setAddPanelOpen(false);
    } catch (err) {
      setAddParticipantError(err instanceof Error ? err.message : "failed");
    } finally {
      setAddingParticipant(false);
    }
  }

  // Participants panel - live legs of the conference (customer, agent,
  // any added 3rd parties). Polled while the session is live so the UI
  // sees DIALING → JOINED → LEFT transitions even when the websocket
  // doesn't carry per-participant events. Per-row controls call the
  // generic participants/:id/{hold,kick} endpoints.
  const [participants, setParticipants] = useState<VoiceSessionParticipant[]>([]);
  const [participantBusy, setParticipantBusy] = useState<Record<string, "hold" | "kick" | null>>({});
  async function refreshParticipants() {
    if (!token || !session) return;
    try {
      const { data } = await getVoiceSessionParticipants(token, session.id);
      setParticipants(data);
    } catch {
      /* swallow - non-fatal */
    }
  }
  useEffect(() => {
    if (!token || !session) return;
    if (TERMINAL_STATES.has((session.state || "").toUpperCase())) {
      // One final refresh so the post-call view shows leftAt timestamps.
      void refreshParticipants();
      return;
    }
    void refreshParticipants();
    const id = setInterval(() => void refreshParticipants(), 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, session?.id, session?.state]);
  async function handleToggleParticipantHold(p: VoiceSessionParticipant) {
    if (!token || !session) return;
    const next = !p.onHold;
    setParticipantBusy((s) => ({ ...s, [p.id]: "hold" }));
    // Optimistic update so the toggle feels instant.
    setParticipants((rows) => rows.map((r) => (r.id === p.id ? { ...r, onHold: next } : r)));
    try {
      await setVoiceParticipantHold(token, session.id, p.id, next);
    } catch (err) {
      // Revert on failure.
      setParticipants((rows) => rows.map((r) => (r.id === p.id ? { ...r, onHold: !next } : r)));
      setAddParticipantError(err instanceof Error ? err.message : "hold_failed");
    } finally {
      setParticipantBusy((s) => ({ ...s, [p.id]: null }));
    }
  }
  async function handleKickParticipant(p: VoiceSessionParticipant) {
    if (!token || !session) return;
    if (!window.confirm(t("voice.workspace.participants.confirmKick"))) return;
    setParticipantBusy((s) => ({ ...s, [p.id]: "kick" }));
    try {
      await kickVoiceParticipant(token, session.id, p.id);
      // Refresh so the row flips to LEFT once the participant-leave
      // webhook lands. Don't preemptively remove - the webhook is the
      // source of truth for leftAt/endReason.
      void refreshParticipants();
    } catch (err) {
      setAddParticipantError(err instanceof Error ? err.message : "kick_failed");
    } finally {
      setParticipantBusy((s) => ({ ...s, [p.id]: null }));
    }
  }

  // Whisper / cold-transfer.
  // - "Hold customer" puts the customer leg on hold music so the agent
  //   can speak privately with the added 3rd party (consult mode).
  // - "Leave call" drops the agent's leg after a transfer so the
  //   customer + 3rd party continue without us (cold transfer).
  const [customerOnHold, setCustomerOnHold] = useState(false);
  const [holdBusy, setHoldBusy] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  async function handleToggleCustomerHold() {
    if (!token || !session || holdBusy) return;
    const next = !customerOnHold;
    setHoldBusy(true);
    try {
      await setVoiceSessionCustomerHold(token, session.id, next);
      setCustomerOnHold(next);
    } catch (err) {
      // Surface as the inline error band on the add panel so the agent sees something.
      setAddParticipantError(err instanceof Error ? err.message : "hold_failed");
    } finally {
      setHoldBusy(false);
    }
  }
  async function handleAgentLeave() {
    if (!token || !session || leaveBusy) return;
    if (!window.confirm(t("voice.workspace.agentLeave.confirm"))) return;
    setLeaveBusy(true);
    try {
      await voiceSessionAgentLeave(token, session.id);
      // The agent leg is dropped server-side - the local Twilio device
      // will fire its own end event; the redirect-on-terminal effect
      // takes us back to /conversations.
    } catch (err) {
      setAddParticipantError(err instanceof Error ? err.message : "leave_failed");
    } finally {
      setLeaveBusy(false);
    }
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
    <div className="flex flex-col md:flex-row h-[100dvh] md:h-screen md:gap-3 md:p-2">
      {/* Stage - full-height on mobile so the call UI is the primary surface
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
            {/* Add participant (3-way). Hidden until the conference is live
                - RINGING/CONNECTING conferences don't yet have a conferenceSid. */}
            {(stateLabel === "ACTIVE" || stateLabel === "HOLD") && (
              <>
                <button
                  type="button"
                  onClick={() => setAddPanelOpen((v) => !v)}
                  aria-label={t("voice.workspace.addParticipant.button")}
                  className={clsx(
                    "inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-sm font-medium transition ring-1",
                    addPanelOpen
                      ? "bg-emerald-400 text-gray-900 ring-emerald-300"
                      : "bg-white/15 text-gray-100 ring-white/20 hover:bg-white/25",
                  )}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M18 9v6m3-3h-6m-3 0a4 4 0 11-8 0 4 4 0 018 0zm-4 6c-3.3 0-6 1.5-6 4v1h12v-1c0-2.5-2.7-4-6-4z" />
                  </svg>
                  <span>{t("voice.workspace.addParticipant.button")}</span>
                </button>
                <button
                  type="button"
                  onClick={handleToggleCustomerHold}
                  disabled={holdBusy}
                  aria-label={customerOnHold ? t("voice.workspace.customerHold.resume") : t("voice.workspace.customerHold.hold")}
                  className={clsx(
                    "inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-sm font-medium transition ring-1",
                    holdBusy && "opacity-60 cursor-wait",
                    customerOnHold
                      ? "bg-amber-400 text-gray-900 ring-amber-300"
                      : "bg-white/15 text-gray-100 ring-white/20 hover:bg-white/25",
                  )}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>{customerOnHold ? t("voice.workspace.customerHold.resume") : t("voice.workspace.customerHold.hold")}</span>
                </button>
                <button
                  type="button"
                  onClick={handleAgentLeave}
                  disabled={leaveBusy}
                  aria-label={t("voice.workspace.agentLeave.button")}
                  className={clsx(
                    "inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-sm font-medium transition ring-1 bg-white/15 text-gray-100 ring-white/20 hover:bg-white/25",
                    leaveBusy && "opacity-60 cursor-wait",
                  )}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V5a2 2 0 012-2h6a2 2 0 012 2v14m-8 0H5m4 0a2 2 0 002-2v-1m6 3h2m-2 0a2 2 0 01-2-2v-1" />
                  </svg>
                  <span>{t("voice.workspace.agentLeave.button")}</span>
                </button>
              </>
            )}
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

        {/* Add-participant inline panel - slides in when the agent clicks
            "Add". Submit dials the new leg into the live conference (3-way). */}
        {addPanelOpen && (
          <div className="px-4 md:px-10 mb-2">
            <div className="flex items-center gap-2 bg-white/10 rounded-lg p-2 ring-1 ring-white/15">
              <input
                type="tel"
                inputMode="tel"
                placeholder="+972..."
                value={addParticipantNumber}
                onChange={(e) => setAddParticipantNumber(e.target.value)}
                disabled={addingParticipant}
                className="flex-1 bg-transparent text-sm text-gray-100 placeholder-gray-500 px-2 py-1.5 focus:outline-none"
              />
              <button
                type="button"
                onClick={handleAddParticipant}
                disabled={addingParticipant || !addParticipantNumber.trim()}
                className={clsx(
                  "px-3 py-1.5 rounded-md text-sm font-semibold transition",
                  addingParticipant || !addParticipantNumber.trim()
                    ? "bg-white/10 text-gray-500 cursor-not-allowed"
                    : "bg-emerald-500 text-gray-900 hover:bg-emerald-400",
                )}
              >
                {addingParticipant ? t("voice.workspace.addParticipant.dialing") : t("voice.workspace.addParticipant.dial")}
              </button>
              <button
                type="button"
                onClick={() => { setAddPanelOpen(false); setAddParticipantError(null); }}
                className="px-2 py-1.5 rounded-md text-sm text-gray-300 hover:bg-white/10"
              >
                {t("voice.workspace.addParticipant.cancel")}
              </button>
            </div>
            {addParticipantError && (
              <p className="mt-1 text-xs text-rose-300">{addParticipantError}</p>
            )}
          </div>
        )}

        {/* Participants panel - one row per leg with per-row hold/kick
            controls. Rendered whenever any participant exists so post-
            call view shows who was on the line. */}
        {participants.length > 0 && (
          <div className="px-4 md:px-10 mb-2">
            <div className="bg-white/5 rounded-lg ring-1 ring-white/10 divide-y divide-white/5">
              {participants.map((p) => {
                const name = p.contact?.displayName || p.displayName || (p.role === "AGENT" ? agentName : null) || formatPhone(p.phoneNumber || "") || p.phoneNumber || p.label || p.role;
                const phone = p.contact?.phone || p.phoneNumber || null;
                const isLeft = !!p.leftAt || p.status === "LEFT" || p.status === "FAILED";
                const busy = participantBusy[p.id];
                const roleLabel = p.role === "CUSTOMER"
                  ? t("voice.workspace.participants.roleCustomer")
                  : p.role === "AGENT"
                    ? t("voice.workspace.participants.roleAgent")
                    : t("voice.workspace.participants.roleAdded");
                const statusLabel = p.status === "DIALING"
                  ? t("voice.workspace.participants.statusDialing")
                  : p.status === "JOINED"
                    ? t("voice.workspace.participants.statusJoined")
                    : p.status === "LEFT"
                      ? t("voice.workspace.participants.statusLeft")
                      : t("voice.workspace.participants.statusFailed");
                return (
                  <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={clsx(
                          "inline-block w-2 h-2 rounded-full shrink-0",
                          p.status === "JOINED" && !p.onHold && "bg-emerald-400",
                          p.status === "JOINED" && p.onHold && "bg-amber-400",
                          p.status === "DIALING" && "bg-amber-400 animate-pulse",
                          (p.status === "LEFT" || p.status === "FAILED") && "bg-gray-500",
                        )}
                      />
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm text-gray-100 truncate">{name}</span>
                        <span className="text-[11px] text-gray-500 truncate">
                          {roleLabel}
                          {phone ? ` · ${formatPhone(phone)}` : ""}
                          {p.contact ? ` · ${t("voice.workspace.participants.crmLinked")}` : ""}
                          {" · "}{statusLabel}
                          {p.onHold && p.status === "JOINED" ? ` · ${t("voice.workspace.participants.onHold")}` : ""}
                        </span>
                      </div>
                    </div>
                    {!isLeft && p.status === "JOINED" && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleToggleParticipantHold(p)}
                          disabled={busy === "hold"}
                          className={clsx(
                            "px-2.5 py-1 rounded-md text-xs font-medium transition ring-1",
                            busy === "hold" && "opacity-60 cursor-wait",
                            p.onHold
                              ? "bg-amber-400 text-gray-900 ring-amber-300"
                              : "bg-white/10 text-gray-100 ring-white/15 hover:bg-white/20",
                          )}
                        >
                          {p.onHold ? t("voice.workspace.participants.resume") : t("voice.workspace.participants.hold")}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleKickParticipant(p)}
                          disabled={busy === "kick"}
                          className={clsx(
                            "px-2.5 py-1 rounded-md text-xs font-medium transition bg-rose-500/80 text-white hover:bg-rose-500",
                            busy === "kick" && "opacity-60 cursor-wait",
                          )}
                        >
                          {t("voice.workspace.participants.hangup")}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Decline banner - shown when the customer didn't pick up the
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

        {/* Status strip - sentiment dot · stage · missing-data badge.
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

        {/* Spelling/code-switch entity chips - high-signal reconstructions
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

      {/* Right panel - desktop sidebar AND mobile slide-over.
          The mobile slide-over is rendered as a fixed full-screen overlay
          so it doesn't compete with the call stage for vertical space.
          Width grows on larger screens so the cards don't compress into
          a narrow column where everything looks stacked and noisy. */}
      <div className="hidden md:flex md:w-[400px] lg:w-[440px] xl:w-[480px] flex-shrink-0 flex-col md:rounded-2xl md:overflow-hidden bg-gray-50 ring-1 ring-gray-200">
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
