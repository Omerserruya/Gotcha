"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { useVoiceCall } from "@/context/VoiceCallContext";
import { useVoiceSessions } from "@/contexts/VoiceSessionsContext";
import { getContacts, getTenantSettings } from "@/lib/api";
import { normalizeE164 } from "@/lib/phone";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

interface Contact {
  id: string;
  displayName?: string;
  externalId?: string;
  phone?: string;
  channel?: string;
}

/**
 * Outbound dialer.
 *
 * This page is intentionally thin — it only collects the destination + notes,
 * places the call via VoiceCallContext.placeCall, and then routes the user to
 * the unified /voice/[sessionId] workspace as soon as the VoiceCallSession
 * row exists. That workspace renders the same transcript stage + copilot
 * panel for both inbound and outbound calls; the old PhoneCallUI here has
 * been removed to keep the two paths from diverging.
 *
 * The session row is created by voice-copilot when Twilio POSTs to
 * /api/voice-copilot/twiml/outbound (a moment after placeCall returns), and
 * arrives in VoiceSessionsContext via the `voice.session.created` socket
 * event. We watch `allLive` for our pending conversationId and navigate
 * once we see it.
 */
export default function OutboundCallPage() {
  const { token } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const { placeCall, state, isReady } = useVoiceCall();
  const { allLive } = useVoiceSessions();

  const [phoneInput, setPhoneInput] = useState("");
  const [notes, setNotes] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Contact[]>([]);
  const [selected, setSelected] = useState<Contact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [pendingConversationId, setPendingConversationId] = useState<string | null>(null);
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

  // Once the VoiceCallSession row exists (voice.session.created arrived),
  // hand the user off to the unified /voice/[sessionId] workspace.
  useEffect(() => {
    if (!pendingConversationId) return;
    const match = allLive.find((s) => s.conversationId === pendingConversationId);
    if (match) {
      setPendingConversationId(null);
      router.replace(`/voice/${match.id}`);
    }
  }, [pendingConversationId, allLive, router]);

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
      setPendingConversationId(conversationId);
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
      setPendingConversationId(null);
      setError(err instanceof Error ? err.message : t("outbound.call.errFailed"));
    } finally {
      setPlacing(false);
    }
  }

  return (
    <div className="max-w-xl mx-auto px-3 md:px-0">
      <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-6 shadow-subtle">
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
              <span className="text-xs text-gray-500 tabular-nums">{normalized}</span>
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
