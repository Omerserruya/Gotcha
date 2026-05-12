"use client";

import { useI18n } from "@/context/I18nContext";
import type { VoiceSessionContext } from "@/lib/api";

interface Props {
  context: VoiceSessionContext | null;
  loading: boolean;
}

export function CrmHistoryCard({ context, loading }: Props) {
  const { t } = useI18n();
  // Surface every channel's prior summaries, but de-prioritise VOICE since
  // that's already in PreviousCallsCard. Falls back to customerName when
  // aiSummary isn't populated yet.
  const history = (context?.priorConversations || []).filter((c) => c.channel !== "VOICE");
  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-50">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">{t("voice.workspace.cards.crmHistory.title")}</span>
      </div>
      <div className="px-4 py-3">
        {loading && !context ? (
          <Skeleton lines={3} />
        ) : history.length === 0 ? (
          <p className="text-xs text-gray-500 italic">{t("voice.workspace.cards.crmHistory.noHistory")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {history.slice(0, 8).map((c) => (
              <li key={c.id} className="text-[12px] text-gray-700">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-gray-800">{c.channel}</span>
                  <span className="text-[10px] text-gray-400 tabular-nums shrink-0">
                    {c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleDateString() : "—"}
                  </span>
                </div>
                {c.aiSummary && (
                  <p className="text-gray-600 leading-snug mt-0.5 line-clamp-3">{c.aiSummary}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Skeleton({ lines }: { lines: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-2.5 bg-gray-100 rounded animate-pulse" style={{ width: `${60 + ((i * 17) % 30)}%` }} />
      ))}
    </div>
  );
}
