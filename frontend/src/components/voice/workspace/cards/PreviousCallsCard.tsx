"use client";

import { useI18n } from "@/context/I18nContext";
import type { VoiceSessionContext } from "@/lib/api";

interface Props {
  context: VoiceSessionContext | null;
  loading: boolean;
}

export function PreviousCallsCard({ context, loading }: Props) {
  const { t } = useI18n();
  // Filter to VOICE channel conversations only - that's the "previous calls"
  // surface; other channels appear in the CRM history card below.
  const previousCalls = (context?.priorConversations || []).filter((c) => c.channel === "VOICE");
  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-50">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-700">{t("voice.workspace.cards.previousCalls.title")}</span>
      </div>
      <div className="px-4 py-3">
        {loading && !context ? (
          <Skeleton lines={2} />
        ) : previousCalls.length === 0 ? (
          <p className="text-xs text-gray-500 italic">{t("voice.workspace.cards.previousCalls.noCalls")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {previousCalls.slice(0, 6).map((c) => (
              <li key={c.id} className="text-[12px] text-gray-700 flex items-start gap-2">
                <span className="text-[10px] text-gray-400 tabular-nums shrink-0 mt-0.5">
                  {c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleDateString() : "-"}
                </span>
                <span className="flex-1 truncate">
                  {c.aiSummary || c.customerName || c.id}
                </span>
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
