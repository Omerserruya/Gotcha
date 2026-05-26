"use client";

/**
 * AI-generated customer brief card — voice-workspace edition.
 *
 * Mirrors the chat-side AISummaryCard (see components/conversations/CRMPanel.tsx)
 * so the same persistent cross-conversation brief that the chat agent sees is
 * also visible to the rep during a live call. Reads the persisted row from
 * `customer_briefs` via POST /api/customer-summary; the backend lazily
 * generates inline if nothing is on disk yet.
 *
 * The brief is refreshed automatically by:
 *   - post-chat subscriber on chat close
 *   - voice-postcall worker on call hangup
 * The rep can also force a refresh from the card's ↻ button.
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { fetchCustomerSummary, type CustomerSummary } from "@/lib/api-crm";

interface Props {
  conversationId: string | null;
}

export function CustomerBriefCard({ conversationId }: Props) {
  const { token } = useAuth();
  const { locale, t } = useI18n();
  const [summary, setSummary] = useState<CustomerSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (opts: { refresh?: boolean } = {}) => {
    if (!token || !conversationId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCustomerSummary(token, conversationId, { ...opts, locale });
      setSummary(data);
    } catch (err: any) {
      setError(err?.message || t("callRightPanel.brief.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, conversationId, locale, t]);

  useEffect(() => {
    setSummary(null);
    load();
  }, [load]);

  if (!conversationId) return null;

  const tone = typeof summary?.meta?.tone === "string" ? (summary.meta.tone as string) : null;
  const mood = typeof summary?.meta?.mood === "string" ? (summary.meta.mood as string) : null;
  const recommendedBehaviors = Array.isArray(summary?.meta?.recommended_behaviors)
    ? (summary!.meta!.recommended_behaviors as string[])
    : [];
  const channels = Array.isArray(summary?.meta?.channels)
    ? (summary!.meta!.channels as string[])
    : [];
  const convCount = typeof summary?.meta?.conversation_count === "number"
    ? (summary!.meta!.conversation_count as number)
    : null;

  return (
    <div className="relative rounded-xl p-[1.5px] bg-gradient-to-br from-violet-500 via-purple-500 to-pink-500 shadow-sm">
      <div className="rounded-[11px] bg-white p-3">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex w-5 h-5 rounded-md bg-gradient-to-br from-violet-500 to-purple-600 items-center justify-center">
              <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
            </span>
            <div className="flex flex-col">
              <span className="text-[11px] font-bold uppercase tracking-wide bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent">
                {t("crmPanel.brief.title")}
              </span>
              <span className="text-[9px] text-gray-400 -mt-0.5">
                {channels.length > 1
                  ? t("crmPanel.brief.acrossN", { count: String(channels.length) })
                  : t("crmPanel.brief.across")}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => load({ refresh: true })}
            disabled={loading}
            className="text-[10px] text-violet-500 hover:text-violet-700 disabled:opacity-40 transition"
            title={t("crmPanel.brief.refresh")}
          >
            {loading ? "…" : "↻"}
          </button>
        </div>

        {error && <div className="text-[11px] text-rose-600">{error}</div>}
        {!error && loading && !summary && (
          <div className="text-[11px] text-gray-400 italic">{t("crmPanel.brief.generating")}</div>
        )}
        {!error && summary && (
          <>
            <p className="text-xs text-gray-800 leading-relaxed whitespace-pre-wrap">
              {summary.summary}
            </p>

            {(mood || tone) && (
              <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                {mood && (
                  <span className="px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-100">
                    <span className="font-semibold mr-1">{t("crmPanel.brief.mood")}:</span>{mood}
                  </span>
                )}
                {tone && (
                  <span className="px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
                    <span className="font-semibold mr-1">{t("crmPanel.brief.tone")}:</span>{tone}
                  </span>
                )}
              </div>
            )}

            {summary.signals && summary.signals.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {summary.signals.map((s, i) => (
                  <span
                    key={i}
                    className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-100"
                  >
                    {s}
                  </span>
                ))}
              </div>
            )}

            {recommendedBehaviors.length > 0 && (
              <div className="mt-2 pt-2 border-t border-gray-100">
                <div className="text-[9px] uppercase tracking-wide text-gray-500 mb-1">{t("crmPanel.brief.howToTreat")}</div>
                <ul className="space-y-0.5">
                  {recommendedBehaviors.map((b, i) => (
                    <li key={i} className="text-[11px] text-gray-700 flex items-start gap-1">
                      <span className="text-emerald-500 mt-0.5">✓</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-1.5 text-[9px] text-gray-400 flex items-center justify-between">
              <span>
                {summary.cached ? t("crmPanel.brief.saved") : t("crmPanel.brief.fresh")} · {new Date(summary.generated_at).toLocaleString()}
              </span>
              {convCount != null && convCount > 0 && (
                <span>
                  {convCount === 1
                    ? t("crmPanel.brief.priorConv", { count: String(convCount) })
                    : t("crmPanel.brief.priorConvs", { count: String(convCount) })}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
