"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { useI18n } from "@/context/I18nContext";
import { useVoiceFlags } from "@/lib/use-voice-flags";
import { useVoiceSessions } from "@/contexts/VoiceSessionsContext";
import { useVoiceCall } from "@/context/VoiceCallContext";
import { normalizeE164 } from "@/lib/phone";
import type { VoiceCallSession } from "@/lib/api";

const AUTO_DISMISS_MS = 30_000;
const SOUND_KEY = "gotcha.incomingCallSound";

function formatPhone(num: string): string {
  const normalized = normalizeE164(num);
  const display = normalized || num;
  if (!display) return "";
  if (!display.startsWith("+")) return display;
  return display.replace(/(\+\d{1,3})(\d{3})(\d{3})(\d+)/, "$1 $2 $3 $4").trim();
}

/** Returns true if the user has ring sound enabled (default: true). */
function getSoundEnabled(): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem(SOUND_KEY);
  return stored !== "off";
}

/**
 * Play a short two-note attention chime (no loop).
 * Two soft sine pings (E5 → A5, ~140 ms each) at low volume — enough to
 * grab the agent's attention without becoming annoying. Returns a stop
 * function that closes the audio context if called before the chime ends.
 */
export function playRingtone(): () => void {
  let ctx: AudioContext | null = null;

  try {
    ctx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  } catch {
    return () => {};
  }

  const audioCtx = ctx;
  const PEAK_GAIN = 0.12;

  function ping(startTime: number, frequency: number, duration: number) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, startTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration);
  }

  const t0 = audioCtx.currentTime + 0.02;
  ping(t0, 659.25, 0.18);          // E5
  ping(t0 + 0.16, 880.0, 0.22);    // A5

  // Auto-close the context after the chime finishes so we don't leak it.
  const totalMs = (0.16 + 0.22 + 0.05) * 1000;
  const closeTimer = setTimeout(() => {
    try { audioCtx.close(); } catch { /* ignore */ }
  }, totalMs);

  return () => {
    clearTimeout(closeTimer);
    try { audioCtx.close(); } catch { /* ignore */ }
  };
}

// ─── Shared hook ─────────────────────────────────────────────────────────────

function useIncomingCallState() {
  const flags = useVoiceFlags();
  const { ringing, claim, decline } = useVoiceSessions();
  const { joinConference } = useVoiceCall();
  const router = useRouter();
  const { t } = useI18n();
  const [pending, setPending] = useState<"answer" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const stopRingtoneRef = useRef<(() => void) | null>(null);

  // Auto-dismiss after 30 s
  useEffect(() => {
    if (!flags.voiceInboxUiEnabled) return;
    if (ringing.length === 0) return;
    const top = ringing[0];
    if (dismissed.has(top.id)) return;
    const start = top.startedAt ? new Date(top.startedAt).getTime() : Date.now();
    const elapsed = Date.now() - start;
    const remaining = Math.max(0, AUTO_DISMISS_MS - elapsed);
    const timer = setTimeout(() => {
      setDismissed((prev) => {
        if (prev.has(top.id)) return prev;
        const next = new Set(prev);
        next.add(top.id);
        return next;
      });
    }, remaining);
    return () => clearTimeout(timer);
  }, [ringing, dismissed, flags.voiceInboxUiEnabled]);

  // Ringtone: play when ringing, stop when empty
  useEffect(() => {
    const actionable = ringing.filter((s) => !dismissed.has(s.id));
    if (actionable.length > 0 && getSoundEnabled()) {
      if (!stopRingtoneRef.current) {
        try {
          stopRingtoneRef.current = playRingtone();
        } catch {
          console.warn("[IncomingCallBanner] ringtone failed to start");
        }
      }
    } else {
      if (stopRingtoneRef.current) {
        stopRingtoneRef.current();
        stopRingtoneRef.current = null;
      }
    }
  }, [ringing, dismissed]);

  // Stop ringtone on unmount
  useEffect(() => {
    return () => {
      stopRingtoneRef.current?.();
    };
  }, []);

  async function handleAnswer(session: VoiceCallSession) {
    if (pending) return;
    setPending("answer");
    setError(null);
    try {
      const claimed = await claim(session.id);
      if (claimed?.callSid) {
        await joinConference(`inbound-${claimed.callSid}`);
      }
      router.push(`/voice/${session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed_to_answer");
    } finally {
      setPending(null);
    }
  }

  async function handleDecline(session: VoiceCallSession) {
    if (pending) return;
    setPending("decline");
    setError(null);
    try {
      await decline(session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed_to_decline");
    } finally {
      setPending(null);
    }
  }

  const actionable = ringing.filter((s) => !dismissed.has(s.id));
  const top = actionable[0] ?? null;
  const stacked = actionable.slice(1);

  return { flags, t, pending, error, top, stacked, handleAnswer, handleDecline };
}

// ─── Desktop: sidebar card ────────────────────────────────────────────────────

/**
 * Compact incoming-call card for the sidebar bottom slot (desktop ≥ md).
 * Hidden on mobile via `hidden md:block`.
 */
export function IncomingCallBannerSidebar() {
  const { flags, t, pending, error, top, stacked, handleAnswer, handleDecline } =
    useIncomingCallState();

  if (flags.loading || !flags.voiceInboxUiEnabled) return null;
  if (!top) return null;

  return (
    <div className="hidden md:block px-2 pb-2">
      {/* Attention-grabbing pulsing card */}
      <div
        className={clsx(
          "rounded-2xl ring-2 ring-emerald-300 shadow-lg p-3 bg-white",
          "animate-[pulse_1.8s_ease-in-out_infinite]",
        )}
      >
        <div className="flex items-center gap-2 mb-2">
          {/* Phone icon */}
          <span className="w-7 h-7 rounded-xl bg-emerald-100 flex items-center justify-center shrink-0">
            <svg className="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
            </svg>
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600 leading-none">
              {t("voice.banner.incomingCall")}
            </p>
            <p className="text-sm font-semibold text-gray-900 truncate leading-tight mt-0.5">
              {formatPhone(top.customerNumber) || top.customerNumber}
            </p>
          </div>
        </div>

        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => handleDecline(top)}
            disabled={pending !== null}
            className={clsx(
              "flex-1 py-1.5 rounded-xl text-xs font-semibold transition",
              pending !== null
                ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                : "bg-red-50 text-red-600 hover:bg-red-100",
            )}
          >
            {t("voice.banner.declineButton")}
          </button>
          <button
            type="button"
            onClick={() => handleAnswer(top)}
            disabled={pending !== null}
            className={clsx(
              "flex-1 py-1.5 rounded-xl text-xs font-semibold transition",
              pending !== null
                ? "bg-emerald-200 text-white cursor-not-allowed"
                : "bg-emerald-600 text-white hover:bg-emerald-700",
            )}
          >
            {pending === "answer" ? t("voice.banner.answeringButton") : t("voice.banner.answerButton")}
          </button>
        </div>

        {error && (
          <p className="mt-1.5 text-[10px] text-red-600 text-center">{error}</p>
        )}
      </div>

      {/* Stack overflow indicator */}
      {stacked.length > 0 && (
        <p className="text-[10px] text-gray-400 text-center mt-1">
          {t("voice.banner.moreRinging", { count: String(stacked.length) })}
        </p>
      )}
    </div>
  );
}

// ─── Mobile: iPhone-style top banner ─────────────────────────────────────────

/**
 * iOS-style sliding top banner for mobile (< md). Hidden on desktop via `md:hidden`.
 */
export function IncomingCallBannerMobile() {
  const { flags, t, pending, top, handleAnswer, handleDecline } = useIncomingCallState();
  const [visible, setVisible] = useState(false);

  // Slide-in on mount when there is a call, slide-out when gone.
  useEffect(() => {
    if (top) {
      // Tiny defer so the element is mounted before transition kicks in.
      const id = setTimeout(() => setVisible(true), 16);
      return () => clearTimeout(id);
    } else {
      setVisible(false);
    }
  }, [top !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (flags.loading || !flags.voiceInboxUiEnabled) return null;
  if (!top) return null;

  return (
    <div
      className={clsx(
        "md:hidden fixed inset-x-0 top-0 z-[70] px-3 pt-[env(safe-area-inset-top,0px)]",
        "transition-transform duration-300 ease-out",
        visible ? "translate-y-0" : "-translate-y-full",
      )}
    >
      <div className="bg-black/80 backdrop-blur-md rounded-b-3xl px-4 py-3 flex items-center gap-3 shadow-2xl">
        {/* Caller info */}
        <div className="flex-1 min-w-0">
          <p className="text-white font-semibold text-sm truncate">
            {formatPhone(top.customerNumber) || top.customerNumber}
          </p>
          <p className="text-white/60 text-[11px]">{t("voice.banner.incomingCall")}</p>
        </div>

        {/* Decline — red circle */}
        <button
          type="button"
          onClick={() => handleDecline(top)}
          disabled={pending !== null}
          aria-label={t("voice.banner.declineButton")}
          className={clsx(
            "w-11 h-11 rounded-full flex items-center justify-center shrink-0 transition",
            pending !== null
              ? "bg-red-300 cursor-not-allowed"
              : "bg-red-500 hover:bg-red-600 active:scale-95",
          )}
        >
          <svg className="w-5 h-5 text-white rotate-[135deg]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
          </svg>
        </button>

        {/* Answer — green circle */}
        <button
          type="button"
          onClick={() => handleAnswer(top)}
          disabled={pending !== null}
          aria-label={t("voice.banner.answerButton")}
          className={clsx(
            "w-11 h-11 rounded-full flex items-center justify-center shrink-0 transition",
            pending !== null
              ? "bg-emerald-300 cursor-not-allowed"
              : "bg-emerald-500 hover:bg-emerald-600 active:scale-95",
          )}
        >
          <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/**
 * @deprecated — kept so existing imports don't break while migrating.
 * Use IncomingCallBannerSidebar + IncomingCallBannerMobile instead.
 */
export function IncomingCallBanner() {
  return null;
}
