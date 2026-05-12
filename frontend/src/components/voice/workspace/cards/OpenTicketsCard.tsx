"use client";

import { useI18n } from "@/context/I18nContext";

/**
 * Phase 1 placeholder. No tickets endpoint exists yet on the backend; the
 * card stubs gracefully so the right rail layout is stable for the
 * eventual integration.
 */
export function OpenTicketsCard() {
  const { t } = useI18n();
  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-50">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">{t("voice.workspace.cards.tickets.title")}</span>
      </div>
      <div className="px-4 py-3">
        <p className="text-xs text-gray-500 italic">
          {t("voice.workspace.cards.tickets.placeholder")}
        </p>
      </div>
    </div>
  );
}
