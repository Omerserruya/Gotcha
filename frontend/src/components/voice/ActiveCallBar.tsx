"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";
import { useI18n } from "@/context/I18nContext";
import { useVoiceFlags } from "@/lib/use-voice-flags";
import { useVoiceSessions } from "@/contexts/VoiceSessionsContext";
import { useVoiceCall } from "@/context/VoiceCallContext";
import { normalizeE164 } from "@/lib/phone";

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

/**
 * Phase 1 GLOBAL SINGLETON - mounted ONCE at the providers tree. Renders
 * only when an active session is assigned to THIS agent (per the singleton
 * invariant in VoiceSessionsContext). Hidden on the dedicated workspace
 * route (`/voice/:id`) to avoid double-controls.
 *
 * Mute + Hangup proxy to the local Twilio Device when this agent placed
 * the call (`VoiceCallContext.state !== "idle"`); otherwise they call the
 * server-side `/api/voice-sessions/:id/hangup` so server-anchored sessions
 * (inbound calls that touched a separate browser tab) can still be ended.
 */
export function ActiveCallBar() {
  const flags = useVoiceFlags();
  const { t } = useI18n();
  const { live, hangup: hangupSession } = useVoiceSessions();
  const voice = useVoiceCall();
  const router = useRouter();
  const pathname = usePathname();
  const [tick, setTick] = useState(0);

  // Re-render once per second so the mm:ss timer ticks without leaning on
  // any specific session field. Cheap - bound to the bar's lifecycle.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [live]);
  // Touch the tick so the unused-var lint stays happy and the effect is observable.
  void tick;

  if (flags.loading) return null;
  if (!flags.voiceInboxUiEnabled) return null;
  if (!live) return null;
  // Suppress on the dedicated workspace - its header already shows the controls.
  if (pathname?.startsWith(`/voice/${live.id}`)) return null;

  const isLocalDevice = voice.state !== "idle" && voice.state !== "ended";
  const elapsedMs = (() => {
    if (isLocalDevice) return voice.elapsedMs;
    const ref = live.answeredAt || live.claimedAt || live.startedAt;
    if (!ref) return 0;
    return Date.now() - new Date(ref).getTime();
  })();

  async function handleHangup() {
    if (!live) return;
    try {
      if (isLocalDevice) voice.hangup();
      // Always notify the server too - twilio webhook may already have
      // marked the session terminal but we want to be defensive.
      await hangupSession(live.id);
    } catch {
      // best-effort
    }
  }

  function handleMute() {
    if (isLocalDevice) voice.toggleMute();
  }

  function handleOpen() {
    if (live) router.push(`/voice/${live.id}`);
  }

  const stateLabel = live.state || (live.status === "in-progress" ? "ACTIVE" : live.status?.toUpperCase());

  return (
    <div className="fixed bottom-4 end-4 z-50 bg-white shadow-2xl border border-gray-200 rounded-xl px-4 py-3 flex items-center gap-3 min-w-[320px]">
      <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
      <div className="flex flex-col leading-tight min-w-0">
        <span className="text-xs text-gray-500">{stateLabel || t("voice.activeBar.onCall")}</span>
        <span className="text-sm font-semibold text-gray-900 tabular-nums truncate">
          {formatPhone(live.customerNumber) || live.customerNumber}
        </span>
        <span className="text-[11px] text-gray-500 tabular-nums">{formatDuration(elapsedMs)}</span>
      </div>
      <div className="ms-auto flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={handleMute}
          disabled={!isLocalDevice}
          title={isLocalDevice ? (voice.isMuted ? t("voice.activeBar.unmute") : t("voice.activeBar.mute")) : t("voice.activeBar.muteUnavailable")}
          className={clsx(
            "px-2 py-1.5 rounded-lg text-xs font-medium transition",
            !isLocalDevice && "bg-gray-50 text-gray-400 cursor-not-allowed",
            isLocalDevice && voice.isMuted && "bg-amber-100 text-amber-700",
            isLocalDevice && !voice.isMuted && "bg-gray-100 text-gray-700 hover:bg-gray-200",
          )}
        >
          {voice.isMuted && isLocalDevice ? t("voice.activeBar.unmute") : t("voice.activeBar.mute")}
        </button>
        <button
          type="button"
          onClick={handleOpen}
          className="px-2 py-1.5 rounded-lg text-xs font-medium bg-primary-50 text-primary-600 hover:bg-primary-100 transition"
        >
          {t("voice.activeBar.openWorkspace")}
        </button>
        <button
          type="button"
          onClick={handleHangup}
          className="px-2 py-1.5 rounded-lg text-xs font-semibold bg-red-600 text-white hover:bg-red-700 transition"
        >
          {t("voice.activeBar.hangup")}
        </button>
      </div>
    </div>
  );
}
