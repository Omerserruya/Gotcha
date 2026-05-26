"use client";

import { useI18n } from "@/context/I18nContext";
import type { VoiceSessionContext } from "@/lib/api";

interface Props {
  context: VoiceSessionContext | null;
  loading: boolean;
}

// Channel → badge color. Mirrors the inbox ChannelBadge palette so the
// agent's visual mapping is consistent across the app.
const CHANNEL_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  VOICE: { bg: "bg-rose-50", text: "text-rose-700", label: "Voice" },
  WHATSAPP: { bg: "bg-emerald-50", text: "text-emerald-700", label: "WhatsApp" },
  MESSENGER: { bg: "bg-blue-50", text: "text-blue-700", label: "Messenger" },
  INSTAGRAM: { bg: "bg-pink-50", text: "text-pink-700", label: "Instagram" },
  TELEGRAM: { bg: "bg-sky-50", text: "text-sky-700", label: "Telegram" },
  SLACK: { bg: "bg-purple-50", text: "text-purple-700", label: "Slack" },
  EMAIL: { bg: "bg-amber-50", text: "text-amber-700", label: "Email" },
  SMS: { bg: "bg-indigo-50", text: "text-indigo-700", label: "SMS" },
};

function channelStyle(channel: string): { bg: string; text: string; label: string } {
  return CHANNEL_STYLE[channel] ?? { bg: "bg-gray-100", text: "text-gray-700", label: channel };
}

export function CrmHistoryCard({ context, loading }: Props) {
  const { t } = useI18n();
  // Cross-platform history — every prior conversation across every channel,
  // sorted by most-recent first. The separate PreviousCallsCard used to
  // duplicate voice history here; the History tab now unifies them so an
  // agent can scan a single timeline with channel badges instead of jumping
  // between cards.
  const history = (context?.priorConversations || [])
    .slice()
    .sort((a, b) => {
      const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bt - at;
    });
  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-50">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-700">{t("voice.workspace.cards.crmHistory.title")}</span>
      </div>
      <div className="px-4 py-3">
        {loading && !context ? (
          <Skeleton lines={3} />
        ) : history.length === 0 ? (
          <p className="text-xs text-gray-500 italic">{t("voice.workspace.cards.crmHistory.noHistory")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {history.slice(0, 12).map((c) => {
              const style = channelStyle(c.channel);
              return (
                <li key={c.id} className="text-[12px] text-gray-700">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${style.bg} ${style.text}`}>
                      {style.label}
                    </span>
                    <span className="text-[10px] text-gray-400 tabular-nums shrink-0">
                      {c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleDateString() : "—"}
                    </span>
                  </div>
                  {c.aiSummary && (
                    <p className="text-gray-600 leading-snug mt-0.5 line-clamp-3">{c.aiSummary}</p>
                  )}
                </li>
              );
            })}
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
