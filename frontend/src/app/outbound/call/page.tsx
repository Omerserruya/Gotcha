"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { useVoiceCall } from "@/context/VoiceCallContext";
import { useVoiceSessions } from "@/contexts/VoiceSessionsContext";
import { useVoiceFlags } from "@/lib/use-voice-flags";
import {
  getConversations,
  getSotCustomerDetail,
  listVoiceChannels,
  getTenantSettings,
  searchSotCustomers,
  type SotCustomer,
} from "@/lib/api";
import { normalizeE164 } from "@/lib/phone";
import { ChannelBadge } from "@/components/conversations/ChannelBadge";
import { track } from "@/lib/analytics";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

/**
 * Outbound call page.
 *
 * One clear flow: pick WHO to call (enter a number / search the source of
 * truth / pick a recent conversation), review the selected destination, start
 * the call. The page stays thin - VoiceCallContext places the call through
 * the server gate (permission → phone-channel validation → destination
 * validation → provider), and the user is handed to the unified
 * /voice/[sessionId] workspace once the session row exists. The visible call
 * state comes from the provider's own events (never just the button click).
 */

type Mode = "number" | "search" | "recent";

interface Destination {
  /** E.164 number the call will go to. */
  phone: string;
  /** Human name when the destination is a known identity. */
  name: string | null;
  /** Where the identity came from: "manual" | vendor slug | channel type. */
  source: string;
  /** Extra verified numbers for this identity, when it has several. */
  altPhones?: string[];
  /** Short context line (last conversation time, stage, ...). */
  context?: string | null;
}

interface RecentItem {
  key: string;
  name: string | null;
  phone: string;
  channel: string;
  lastAt: string | null;
}

// Mask all but the country prefix and the last two digits: +9725•••••41.
// Display-only - the full number appears after explicit selection.
function maskPhone(p: string): string {
  if (p.length <= 6) return p;
  return p.slice(0, 4) + "•".repeat(Math.max(2, p.length - 6)) + p.slice(-2);
}

export default function OutboundCallPage() {
  const { token, user } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const { placeCall, state, isReady } = useVoiceCall();
  const { allLive } = useVoiceSessions();
  const voiceFlags = useVoiceFlags();
  const isAdmin = user?.role === "ADMIN";

  const [mode, setModeState] = useState<Mode>("number");
  const [phoneInput, setPhoneInput] = useState("");
  const [destination, setDestination] = useState<Destination | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [pendingConversationId, setPendingConversationId] = useState<string | null>(null);
  const [defaultCountry, setDefaultCountry] = useState<string>("IL");

  // search mode
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SotCustomer[]>([]);
  const [searchMeta, setSearchMeta] = useState<{ configured: boolean; vendor: string | null; missingScope?: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // recent mode
  const [recent, setRecent] = useState<RecentItem[] | null>(null);

  // Unhealthy-channel detection (ADMIN only - the listing is admin-scoped).
  const [channelBroken, setChannelBroken] = useState(false);

  function setMode(m: Mode) {
    setModeState(m);
    track("outbound_mode_selected", { mode: m });
  }

  useEffect(() => {
    if (!token) return;
    getTenantSettings(token)
      .then((res) => setDefaultCountry(res.data?.defaultCountryCode || "IL"))
      .catch(() => {});
  }, [token]);

  // A phone channel exists but is not ACTIVE → "reconnect", not "connect".
  useEffect(() => {
    if (!token || !isAdmin || voiceFlags.loading || voiceFlags.hasActiveVoiceChannel) return;
    listVoiceChannels(token)
      .then((r) => setChannelBroken((r.data || []).some((c) => String(c.status) !== "ACTIVE")))
      .catch(() => {});
  }, [token, isAdmin, voiceFlags.loading, voiceFlags.hasActiveVoiceChannel]);

  // Source-of-truth search (debounced). Active-tenant scoping and the
  // vendor election happen server-side.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (mode !== "search" || !query.trim() || !token) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const r = await searchSotCustomers(token, query.trim(), 8);
        setResults(r.data || []);
        setSearchMeta(r.meta || null);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, token, mode]);

  // Recent = conversations whose channel identity IS a verified phone number
  // (WhatsApp / voice external ids). Numbers typed inside message bodies are
  // deliberately never offered.
  useEffect(() => {
    if (mode !== "recent" || recent !== null || !token) return;
    getConversations(token, { limit: "30" })
      .then((r) => {
        const seen = new Set<string>();
        const items: RecentItem[] = [];
        for (const c of r.data || []) {
          const e164 = normalizeE164(String(c.customerExternalId || ""), defaultCountry);
          if (!e164 || seen.has(e164)) continue;
          seen.add(e164);
          items.push({
            key: c.id,
            name: c.customerName || null,
            phone: e164,
            channel: c.channel,
            lastAt: c.lastMessageAt || c.updatedAt || null,
          });
          if (items.length >= 8) break;
        }
        setRecent(items);
      })
      .catch(() => setRecent([]));
  }, [mode, recent, token, defaultCountry]);

  const manualNormalized = normalizeE164(phoneInput, defaultCountry);
  const isActive = state !== "idle";
  const isBusy = isActive || placing;

  // The destination the call will actually use.
  const effective: Destination | null = useMemo(() => {
    if (destination) return destination;
    if (mode === "number" && manualNormalized) {
      return { phone: manualNormalized, name: null, source: "manual" };
    }
    return null;
  }, [destination, mode, manualNormalized]);

  const canCall = !!effective && isReady && !isBusy;

  useEffect(() => {
    if (!pendingConversationId) return;
    const match = allLive.find((s) => s.conversationId === pendingConversationId);
    if (match) {
      setPendingConversationId(null);
      router.replace(`/voice/${match.id}`);
    }
  }, [pendingConversationId, allLive, router]);

  // Explicit selection resolves the FULL contact (the list is masked). The
  // agent always picks from the candidate list - even a single result is
  // never auto-selected.
  async function pickCustomer(c: SotCustomer) {
    if (!c.callable || !token || resolvingId) return;
    setError(null);
    setResolvingId(c.id);
    try {
      const r = await getSotCustomerDetail(token, c.id, c.kind);
      const e164 = r.data.phone ? normalizeE164(r.data.phone, defaultCountry) : null;
      if (!e164) {
        setError(t("outbound.call.noCallableNumber"));
        return;
      }
      track("outbound_customer_selected", { vendor: c.vendor, kind: c.kind });
      const spend = c.totalSpent ? `${c.totalSpent}${c.currency ? ` ${c.currency}` : ""}` : null;
      const orders = c.ordersCount != null ? t("outbound.call.ordersCount").replace("{n}", String(c.ordersCount)) : null;
      setDestination({
        phone: e164,
        name: r.data.name || c.name,
        source: c.vendor,
        context: [c.company, orders, spend, r.data.stage].filter(Boolean).join(" · ") || null,
      });
      setQuery("");
      setResults([]);
    } catch {
      setError(t("outbound.call.errFailed"));
    } finally {
      setResolvingId(null);
    }
  }

  function pickRecent(item: RecentItem) {
    track("outbound_recent_selected", { channel: item.channel });
    setDestination({
      phone: item.phone,
      name: item.name,
      source: item.channel,
      context: item.lastAt ? new Date(item.lastAt).toLocaleString() : null,
    });
  }

  async function handleCall() {
    setError(null);
    if (!effective) {
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
      const placeResult = await placeCall(effective.phone, {
        contactName: effective.name || undefined,
        conversationId,
        notes: notes.trim() || undefined,
      });
      track("call_started", { source: effective.source, mode });
      if (placeResult && placeResult.mode === "AGENT_FIRST") {
        if (placeResult.openWorkspace && placeResult.sessionId) {
          router.push(`/voice/${placeResult.sessionId}`);
        } else {
          setError(t("outbound.call.agentFirstDialed"));
        }
        return;
      }
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
            context: { phone: effective.phone, notes: notes.trim() || null, contactName: effective.name },
          }),
        }).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn("[voice] voice_start dispatch failed:", err);
        });
      }
    } catch (err) {
      setPendingConversationId(null);
      track("call_failed", { reason: err instanceof Error ? err.message : "unknown" });
      setError(err instanceof Error ? err.message : t("outbound.call.errFailed"));
    } finally {
      setPlacing(false);
    }
  }

  // ── No usable phone channel: a setup state, never a dead form ──
  if (!voiceFlags.loading && !voiceFlags.hasActiveVoiceChannel) {
    return (
      <div className="max-w-xl mx-auto px-3 md:px-0">
        <div className="bg-white border border-gray-200 rounded-xl p-8 text-center shadow-subtle" data-tour="outbound-dialer">
          <div className={clsx("mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl", channelBroken ? "bg-amber-50" : "bg-gray-100")}>
            <svg className={clsx("h-7 w-7", channelBroken ? "text-amber-400" : "text-gray-300")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900">
            {channelBroken ? t("outbound.call.channelBrokenTitle") : t("outbound.call.noChannelTitle")}
          </h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-gray-500">
            {channelBroken ? t("outbound.call.channelBrokenDesc") : t("outbound.call.noChannelDesc")}
          </p>
          {isAdmin ? (
            <Link
              href="/settings/voice-channels"
              className={clsx(
                "mt-5 inline-flex items-center rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition",
                channelBroken ? "bg-amber-500 hover:bg-amber-600" : "bg-primary-500 hover:bg-primary-600",
              )}
            >
              {channelBroken ? t("outbound.call.reconnectChannelCta") : t("outbound.call.connectChannelCta")}
            </Link>
          ) : (
            <p className="mt-4 text-xs text-gray-400">{t("outbound.call.noChannelAgent")}</p>
          )}
        </div>
      </div>
    );
  }

  const callStateLabel =
    placing ? t("outbound.call.validating")
    : state === "connecting" ? t("outbound.call.connecting")
    : state === "ringing" ? t("outbound.call.ringing")
    : state === "active" ? t("outbound.call.connected")
    : state === "ended" ? t("outbound.call.ended")
    : state === "error" ? t("outbound.call.failed")
    : null;

  return (
    <div className="max-w-xl mx-auto px-3 md:px-0">
      <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-6 shadow-subtle" data-tour="outbound-dialer">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-gray-900">{t("outbound.call.title")}</h2>
          {callStateLabel && (
            <span
              className={clsx(
                "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold",
                state === "active" ? "bg-emerald-50 text-emerald-700"
                : state === "error" ? "bg-red-50 text-red-600"
                : "bg-primary-50 text-primary-700",
              )}
            >
              {callStateLabel}
            </span>
          )}
        </div>
        <p className="text-sm text-gray-500 mb-5">{t("outbound.call.subtitle")}</p>

        {/* ── 1. Who to call: three clear paths ── */}
        <div className="mb-4 grid grid-cols-3 gap-1 rounded-xl bg-gray-100 p-1">
          {(["number", "search", "recent"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              disabled={isBusy}
              className={clsx(
                "rounded-lg px-2 py-1.5 text-xs font-medium transition",
                mode === m ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700",
              )}
            >
              {t(`outbound.call.mode.${m}`)}
            </button>
          ))}
        </div>

        {mode === "number" && (
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1">{t("outbound.call.phone")}</label>
            <div className="flex items-center gap-2">
              <input
                type="tel"
                inputMode="tel"
                dir="ltr"
                value={phoneInput}
                onChange={(e) => { setPhoneInput(e.target.value); setDestination(null); }}
                placeholder="+1 555 123 4567"
                className={clsx(
                  "flex-1 rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300",
                  phoneInput && !manualNormalized ? "border-red-300 focus:border-red-400" : "border-gray-200 focus:border-primary-400",
                )}
                disabled={isBusy}
              />
              {manualNormalized && (
                <span className="text-xs text-gray-500 tabular-nums" dir="ltr">{manualNormalized}</span>
              )}
            </div>
            {phoneInput && !manualNormalized && (
              <p className="text-xs text-red-500 mt-1">{t("outbound.call.errInvalidPhoneHint")}</p>
            )}
          </div>
        )}

        {mode === "search" && (
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1">{t("outbound.call.searchLabel")}</label>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("outbound.call.searchPlaceholder")}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary-400"
              disabled={isBusy}
            />
            {searchMeta && !searchMeta.configured && (
              <p className="mt-2 text-xs text-gray-400">{t("outbound.call.noSourceConfigured")}</p>
            )}
            {searchMeta?.configured && searchMeta.missingScope && query.trim() && (
              <p className="mt-2 text-xs text-amber-600">{t("outbound.call.missingCustomerScope")}</p>
            )}
            {searching && <p className="mt-2 text-xs text-gray-400">{t("outbound.call.searching")}</p>}
            {!searching && query.trim() && searchMeta?.configured && !searchMeta.missingScope && results.length === 0 && (
              <p className="mt-2 text-xs text-gray-400">{t("outbound.call.noSearchResults")}</p>
            )}
            {results.length > 0 && (
              <div className="mt-1 border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-64 overflow-auto bg-white">
                {results.map((c) => (
                  <button
                    key={`${c.vendor}:${c.id}`}
                    type="button"
                    onClick={() => void pickCustomer(c)}
                    disabled={!c.callable || !!resolvingId}
                    className={clsx("w-full text-start px-3 py-2 text-sm", c.callable ? "hover:bg-gray-50" : "opacity-60 cursor-not-allowed")}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium text-gray-900">
                        {c.name || c.emailMasked || t("outbound.call.noName")}
                      </span>
                      {resolvingId === c.id && (
                        <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-primary-200 border-t-primary-500" />
                      )}
                      <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                        {c.vendor}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
                      <span dir="ltr" className="tabular-nums">{c.phoneMasked || t("outbound.call.noCallableNumber")}</span>
                      {c.emailMasked && c.name && <span dir="ltr" className="truncate">{c.emailMasked}</span>}
                      {c.ordersCount != null && (
                        <span className="shrink-0">{t("outbound.call.ordersCount").replace("{n}", String(c.ordersCount))}</span>
                      )}
                      {c.totalSpent && (
                        <span className="shrink-0" dir="ltr">{c.totalSpent}{c.currency ? ` ${c.currency}` : ""}</span>
                      )}
                      {c.company && <span className="truncate">{c.company}</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {mode === "recent" && (
          <div className="mb-4">
            {recent === null ? (
              <p className="py-4 text-center text-xs text-gray-400">{t("outbound.call.searching")}</p>
            ) : recent.length === 0 ? (
              <p className="py-4 text-center text-xs text-gray-400">{t("outbound.call.noRecent")}</p>
            ) : (
              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-64 overflow-auto bg-white">
                {recent.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => pickRecent(item)}
                    disabled={isBusy}
                    className="w-full text-start px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium text-gray-900">
                        {item.name || t("outbound.call.noName")}
                      </span>
                      <ChannelBadge channel={item.channel} size="sm" />
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
                      <span dir="ltr" className="tabular-nums">{maskPhone(item.phone)}</span>
                      {item.lastAt && <span>{new Date(item.lastAt).toLocaleString()}</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── 2. Review the destination ── */}
        {effective && (
          <div className="mb-4 rounded-xl border border-primary-100 bg-primary-50/40 px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-100 text-sm font-bold text-primary-700">
                {(effective.name || "#").charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-900">
                  {effective.name || t("outbound.call.unknownCustomer")}
                </p>
                <p className="text-xs text-gray-500 tabular-nums" dir="ltr">{effective.phone}</p>
                {effective.context && <p className="truncate text-[11px] text-gray-400">{effective.context}</p>}
              </div>
              <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500 ring-1 ring-gray-200">
                {effective.source === "manual" ? t("outbound.call.sourceManual") : effective.source}
              </span>
              {destination && (
                <button
                  type="button"
                  onClick={() => setDestination(null)}
                  disabled={isBusy}
                  className="shrink-0 text-xs font-medium text-gray-400 hover:text-gray-600"
                >
                  {t("outbound.call.clear")}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Notes */}
        <div className="mb-5">
          <label className="block text-xs font-medium text-gray-600 mb-1">{t("outbound.call.notes")}</label>
          <textarea
            rows={2}
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

        {/* ── 3. Start ── */}
        <button
          type="button"
          onClick={handleCall}
          disabled={!canCall}
          className={clsx(
            "w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition",
            canCall
              ? "bg-emerald-600 text-white hover:bg-emerald-700"
              : "bg-gray-100 text-gray-400 cursor-not-allowed",
          )}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
          </svg>
          {isBusy ? t("outbound.call.inProgress") : t("outbound.call.startCall")}
        </button>
      </div>
    </div>
  );
}
