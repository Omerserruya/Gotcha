"use client";

import { useI18n } from "@/context/I18nContext";
import type { VoiceSessionContext } from "@/lib/api";

interface Props {
  context: VoiceSessionContext | null;
  loading: boolean;
}

export function CustomerContextCard({ context, loading }: Props) {
  const { t } = useI18n();
  const contact = context?.contact;
  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-50">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-700">{t("voice.workspace.cards.customer.title")}</span>
      </div>
      <div className="px-4 py-3">
        {loading && !contact ? (
          <Skeleton lines={3} />
        ) : !contact ? (
          <p className="text-xs text-gray-500 italic">{t("voice.workspace.cards.customer.noContact")}</p>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-gray-900">
              {contact.displayName || contact.externalId || t("voice.workspace.cards.customer.unnamed")}
            </span>
            {contact.phone && (
              <span className="text-[12px] text-gray-600 tabular-nums">{contact.phone}</span>
            )}
            {contact.email && (
              <span className="text-[12px] text-gray-600">{contact.email}</span>
            )}
            {contact.tags && contact.tags.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap mt-1.5">
                {contact.tags.slice(0, 6).map((t) => (
                  <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-md bg-gray-100 text-gray-600">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
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
