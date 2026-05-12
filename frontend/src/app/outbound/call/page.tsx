"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { useVoiceCall, type CommittedUtterance, type CopilotSuggestion } from "@/context/VoiceCallContext";
import { getContacts, getTenantSettings } from "@/lib/api";
import { normalizeE164 } from "@/lib/phone";
import { TranscriptStage } from "@/components/voice/workspace/TranscriptStage";

function formatForDisplay(input: string): string {
  if (!input) return "";
  if (!input.startsWith("+")) return input;
  return input.replace(/(\+\d{1,3})(\d{3})(\d{3})(\d+)/, "$1 $2 $3 $4");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

interface Contact {
  id: string;
  displayName?: string;
  externalId?: string;
  phone?: string;
  channel?: string;
}

export default function OutboundCallPage() {
  const { token, user } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const { placeCall, hangup, toggleMute, isMuted, state, call, elapsedMs, isReady, committedTranscripts, currentUtterance, copilotSuggestions } = useVoiceCall();

  // Post-call navigation: when the call ends and we have a conversationId,
  // route the agent into the chat view so the persisted transcript is visible.
  const prevStateRef = useRef<typeof state>(state);
  useEffect(() => {
    const prev = prevStateRef.current;
    if (prev !== "ended" && state === "ended" && call?.conversationId) {
      const id = call.conversationId;
      const timer = setTimeout(() => router.push(`/conversations?id=${encodeURIComponent(id)}`), 1500);
      prevStateRef.current = state;
      return () => clearTimeout(timer);
    }
    prevStateRef.current = state;
  }, [state, call?.conversationId, router]);

  const [phoneInput, setPhoneInput] = useState("");
  const [notes, setNotes] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Contact[]>([]);
  const [selected, setSelected] = useState<Contact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [defaultCountry, setDefaultCountry] = useState<string>("IL");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!token) return;
    getTenantSettings(token)
      .then((res) => setDefaultCountry(res.data?.defaultCountryCode || "IL"))
      .catch(() => {});
  }, [token]);

  const normalized = normalizeE164(phoneInput, defaultCountry);
  const isActive = state !== "idle";
  const isBusy = isActive || placing;
  const canCall = !!normalized && isReady && !isBusy;

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!query.trim() || !token) {
      setResults([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      try {
        const { data } = await getContacts(token, { q: query.trim(), limit: "8", includeCrm: "1" });
        setResults(data || []);
      } catch {
        setResults([]);
      }
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, token]);

  function pickContact(c: Contact) {
    setSelected(c);
    const phone = c.phone || (c.channel === "WHATSAPP" ? c.externalId : "") || "";
    setPhoneInput(phone);
    setQuery("");
    setResults([]);
  }

  async function handleCall() {
    setError(null);
    if (!normalized) {
      setError(t("outbound.call.errInvalidPhone"));
      return;
    }
    if (!isReady) {
      setError(t("outbound.call.errNotReady"));
      return;
    }
    if (isActive) {
      setError(t("outbound.call.errAlreadyOn"));
      return;
    }
    setPlacing(true);
    try {
      const conversationId = crypto.randomUUID();
      await placeCall(normalized, {
        contactName: selected?.displayName,
        conversationId,
        notes: notes.trim() || undefined,
      });
      if (token) {
        fetch(`${API_URL}/api/ai-assist/voice/start`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            type: "voice_start",
            conversationId,
            context: { phone: normalized, notes: notes.trim() || null, contactName: selected?.displayName ?? null },
          }),
        }).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn("[voice] voice_start dispatch failed:", err);
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("outbound.call.errFailed"));
    } finally {
      setPlacing(false);
    }
  }

  if (isActive && call) {
    return (
      <PhoneCallUI
        call={call}
        state={state}
        elapsedMs={elapsedMs}
        committedTranscripts={committedTranscripts}
        currentUtterance={currentUtterance}
        copilotSuggestions={copilotSuggestions}
        agentName={user?.name || t("outbound.call.you")}
        onHangup={hangup}
        onToggleMute={toggleMute}
        isMuted={isMuted}
      />
    );
  }

  return (
    <div className="max-w-xl">
      <div className="bg-white border border-gray-200 rounded-xl p-5 md:p-6 shadow-subtle">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">{t("outbound.call.title")}</h2>
        <p className="text-sm text-gray-500 mb-5">{t("outbound.call.subtitle")}</p>

        {/* Contact search */}
        <div className="mb-4">
          <label className="block text-xs font-medium text-gray-600 mb-1">{t("outbound.call.searchLabel")}</label>
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(null); }}
            placeholder={t("outbound.call.searchPlaceholder")}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary-400"
            disabled={isBusy}
          />
          {results.length > 0 && (
            <div className="mt-1 border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-64 overflow-auto bg-white">
              {results.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => pickContact(c)}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                >
                  <div className="font-medium text-gray-900">{c.displayName || c.externalId || t("outbound.call.noName")}</div>
                  <div className="text-xs text-gray-500">{c.phone || c.externalId}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Phone number */}
        <div className="mb-4">
          <label className="block text-xs font-medium text-gray-600 mb-1">{t("outbound.call.phone")}</label>
          <div className="flex items-center gap-2">
            <input
              type="tel"
              inputMode="tel"
              value={phoneInput}
              onChange={(e) => { setPhoneInput(e.target.value); setSelected(null); }}
              placeholder="+1 555 123 4567"
              className={clsx(
                "flex-1 rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300",
                phoneInput && !normalized ? "border-red-300 focus:border-red-400" : "border-gray-200 focus:border-primary-400"
              )}
              disabled={isBusy}
            />
            {normalized && (
              <span className="text-xs text-gray-500 tabular-nums">{formatForDisplay(normalized)}</span>
            )}
          </div>
          {phoneInput && !normalized && (
            <p className="text-xs text-red-500 mt-1">{t("outbound.call.errInvalidPhoneHint")}</p>
          )}
          {selected && (
            <p className="text-xs text-gray-500 mt-1">
              {t("outbound.call.selected")}: <span className="font-medium text-gray-700">{selected.displayName || selected.externalId}</span>
            </p>
          )}
        </div>

        {/* Notes */}
        <div className="mb-5">
          <label className="block text-xs font-medium text-gray-600 mb-1">{t("outbound.call.notes")}</label>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("outbound.call.notesPlaceholder")}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary-400 resize-none"
            disabled={isBusy}
          />
        </div>

        {!isReady && (
          <div className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {t("outbound.call.initializing")}
          </div>
        )}
        {error && (
          <div className="mb-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={handleCall}
          disabled={!canCall}
          className={clsx(
            "w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition",
            canCall
              ? "bg-emerald-600 text-white hover:bg-emerald-700"
              : "bg-gray-100 text-gray-400 cursor-not-allowed"
          )}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
          </svg>
          {isBusy ? t("outbound.call.inProgress") : t("outbound.call.call")}
        </button>
      </div>
    </div>
  );
}

function PhoneCallUI(props: {
  call: { to: string; contactName?: string; conversationId?: string };
  state: string;
  elapsedMs: number;
  committedTranscripts: CommittedUtterance[];
  currentUtterance: { agent: string; customer: string };
  copilotSuggestions: CopilotSuggestion[];
  agentName: string;
  onHangup: () => void;
  onToggleMute: () => void;
  isMuted: boolean;
}) {
  const { call, state, elapsedMs, committedTranscripts, currentUtterance, copilotSuggestions, agentName, onHangup, onToggleMute, isMuted } = props;
  const { t } = useI18n();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Trigger fade-in after mount.
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const stateLabel = {
    connecting: t("outbound.call.connecting"),
    ringing: t("outbound.call.ringing"),
    active: formatDuration(elapsedMs),
    ended: t("outbound.call.ended"),
    error: t("outbound.call.failed"),
  }[state as "connecting" | "ringing" | "active" | "ended" | "error"] || "";

  const isLive = state === "active" || state === "ringing" || state === "connecting";
  const customerName = call.contactName || t("outbound.call.customer");

  return (
    <div
      className={clsx(
        // Lock to viewport so a long transcript scrolls inside the
        // teleprompter pane instead of pushing the controls off-screen.
        "relative h-[100dvh] max-h-[100dvh] w-full flex flex-col text-gray-100 overflow-hidden md:rounded-2xl shadow-subtle transition-opacity duration-500 ease-out",
        mounted ? "opacity-100" : "opacity-0"
      )}
      style={{ background: "linear-gradient(135deg, #05070d 0%, #0f172a 50%, #05070d 100%)" }}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 md:px-10 py-5">
        <div className="flex items-center gap-3">
          <span
            className={clsx(
              "inline-block w-2 h-2 rounded-full",
              state === "active" ? "bg-emerald-400 animate-pulse" : state === "ended" ? "bg-gray-500" : "bg-amber-400"
            )}
          />
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-medium text-gray-100">{customerName}</span>
            <span className="text-xs text-gray-500 tabular-nums">{formatForDisplay(call.to)}</span>
          </div>
        </div>
        <div className="text-sm font-mono tabular-nums text-gray-300">{stateLabel}</div>
      </div>

      {/* Transcript flow (teleprompter) — extracted to TranscriptStage so
          the workspace /voice/[sessionId] page renders the same visual. */}
      <TranscriptStage
        committedTranscripts={committedTranscripts}
        currentUtterance={currentUtterance}
        agentName={agentName}
        customerName={customerName}
        isLive={isLive}
        className="px-6 md:px-16 lg:px-32 pb-32"
      />

      {/* AI Copilot suggestions — fired by ai-service after each customer final
          (debounced 1500ms). Rendered as a stack of hint cards in the upper
          right. Fades in/out per refresh. */}
      <div className="pointer-events-none absolute top-20 right-6 md:right-10 max-w-xs w-72">
        <div className="text-[10px] uppercase tracking-widest text-gray-500 mb-2">{t("outbound.call.copilot")}</div>
        {copilotSuggestions.length === 0 ? (
          <div className="text-xs text-gray-600 italic">{t("outbound.call.copilotListening")}</div>
        ) : (
          <div className="flex flex-col gap-2">
            {copilotSuggestions.map((s, i) => {
              const title = s.title || s.kind || t("outbound.call.suggestion");
              const body = s.body || s.text || "";
              return (
                <div
                  key={s.id || `${i}:${title}`}
                  className="rounded-lg border border-white/10 bg-white/5 backdrop-blur px-3 py-2 text-xs text-gray-100 shadow-subtle"
                >
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-sky-300 mb-0.5">{title}</div>
                  {body && <div className="text-gray-200 leading-snug">{body}</div>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="absolute bottom-0 inset-x-0 py-6 flex items-center justify-center gap-4">
        <button
          type="button"
          onClick={onToggleMute}
          disabled={!isLive}
          className={clsx(
            "w-12 h-12 rounded-full flex items-center justify-center transition ring-1 ring-white/10",
            !isLive && "bg-gray-800 text-gray-500 cursor-not-allowed",
            isLive && isMuted && "bg-white text-gray-900 hover:scale-105",
            isLive && !isMuted && "bg-white/10 text-gray-100 hover:bg-white/20 hover:scale-105"
          )}
          aria-label={isMuted ? t("outbound.call.unmute") : t("outbound.call.mute")}
          title={isMuted ? t("outbound.call.unmuteMic") : t("outbound.call.muteMic")}
        >
          {isMuted ? (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 14a5 5 0 01-5 5m-5-5V9a5 5 0 015-5m0 0a5 5 0 015 5v2m-5 5v3m-4 0h8M3 3l18 18" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m7 7v4m-4 0h8m-4-9a3 3 0 01-3-3V6a3 3 0 116 0v4a3 3 0 01-3 3z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={onHangup}
          disabled={!isLive}
          className={clsx(
            "w-16 h-16 rounded-full flex items-center justify-center transition shadow-2xl ring-1 ring-black/30",
            isLive
              ? "bg-red-600 hover:bg-red-700 text-white hover:scale-105"
              : "bg-gray-700 text-gray-400 cursor-not-allowed"
          )}
          aria-label={t("outbound.call.hangup")}
          style={{ boxShadow: isLive ? "0 0 0 8px rgba(239, 68, 68, 0.15)" : undefined }}
        >
          <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08C.11 12.9 0 12.65 0 12.38s.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71s-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.1-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.51-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
          </svg>
        </button>
      </div>

      {/* Muted pill */}
      {isMuted && (
        <div className="absolute top-5 left-1/2 -translate-x-1/2 text-[11px] uppercase tracking-[0.2em] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-full px-3 py-1">
          {t("outbound.call.micMuted")}
        </div>
      )}
    </div>
  );
}


