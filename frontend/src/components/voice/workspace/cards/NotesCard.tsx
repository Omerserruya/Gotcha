"use client";

import { useI18n } from "@/context/I18nContext";

/**
 * Phase 1 placeholder for CRM notes. The backend doesn't yet expose a
 * unified notes API; we surface a graceful stub so the workspace shows
 * the slot in the rail without misleading the agent.
 */
export function NotesCard() {
  const { t } = useI18n();
  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-50">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">{t("voice.workspace.cards.notes.title")}</span>
      </div>
      <div className="px-4 py-3">
        <p className="text-xs text-gray-500 italic">
          {t("voice.workspace.cards.notes.placeholder")}
        </p>
      </div>
    </div>
  );
}
