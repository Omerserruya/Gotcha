"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { useI18n } from "@/context/I18nContext";
import { useVoiceFlags } from "@/lib/use-voice-flags";
import { useVoiceSessions } from "@/contexts/VoiceSessionsContext";
import { normalizeE164 } from "@/lib/phone";
import type { VoiceCallSession } from "@/lib/api";

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

function stateBadge(state: VoiceCallSession["state"], status: string, t: (key: string) => string) {
  const value = state || status?.toUpperCase();
  switch (value) {
    case "RINGING":
      return { label: t("voice.inbox.stateRinging"), className: "bg-emerald-50 text-emerald-600" };
    case "CONNECTING":
      return { label: t("voice.inbox.stateConnecting"), className: "bg-amber-50 text-amber-700" };
    case "ACTIVE":
    case "IN-PROGRESS":
      return { label: t("voice.inbox.stateActive"), className: "bg-emerald-100 text-emerald-700" };
    case "HOLD":
      return { label: t("voice.inbox.stateOnHold"), className: "bg-blue-50 text-blue-700" };
    default:
      return { label: String(value || t("voice.inbox.stateVoice")), className: "bg-gray-100 text-gray-600" };
  }
}

/**
 * Inbox-style listing of voice sessions, rendered ABOVE the existing
 * "My Active Chats" group inside the ConversationList card. Hidden when
 * `voiceInboxUiEnabled = false` or when there are zero sessions.
 *
 * Clicking a row routes the agent into the `/voice/[sessionId]` workspace.
 */
export function LiveCallsSection() {
  const flags = useVoiceFlags();
  const { t } = useI18n();
  const { ringing, allLive } = useVoiceSessions();
  const router = useRouter();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (allLive.length === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [allLive.length]);
  void tick;

  if (flags.loading) return null;
  if (!flags.voiceInboxUiEnabled) return null;
  const sessions = [...ringing, ...allLive];
  if (sessions.length === 0) return null;

  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
      <div className="px-3.5 py-2.5 flex items-center gap-2">
        <span className="text-emerald-600">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
          </svg>
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-widest text-emerald-600">
          {t("voice.inbox.liveCalls")}
        </span>
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full ms-auto bg-emerald-50 text-emerald-600">
          {sessions.length}
        </span>
      </div>
      {sessions.map((s) => {
        const badge = stateBadge(s.state, s.status, t);
        const isRinging = (s.state || "").toUpperCase() === "RINGING" || s.status === "ringing";
        const startRef = s.answeredAt || s.claimedAt || s.startedAt;
        const elapsed = startRef ? Date.now() - new Date(startRef).getTime() : 0;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => router.push(`/voice/${s.id}`)}
            className="w-full text-start px-4 py-3 hover:bg-gray-50/80 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className={clsx(
                "w-9 h-9 rounded-full flex items-center justify-center shrink-0",
                isRinging ? "bg-emerald-50 text-emerald-600 animate-pulse" : "bg-emerald-100 text-emerald-700",
              )}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-sm truncate text-gray-900">
                    {formatPhone(s.customerNumber) || s.customerNumber}
                  </p>
                  <span className="text-[10px] text-gray-500 tabular-nums shrink-0">
                    {isRinging ? "—" : formatDuration(elapsed)}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className={clsx("text-[10px] px-2 py-0.5 rounded-full font-medium", badge.className)}>
                    {badge.label}
                  </span>
                  <span className="text-[11px] text-gray-400 truncate">
                    {s.direction === "inbound" ? t("voice.inbox.inbound") : t("voice.inbox.outbound")}
                  </span>
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
