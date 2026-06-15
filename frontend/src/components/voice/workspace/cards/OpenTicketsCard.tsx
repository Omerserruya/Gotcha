"use client";

import { useI18n } from "@/context/I18nContext";
import type { CrmOpenIssue } from "@/lib/api-crm";

interface Props {
  /**
   * CRM open issues pulled by CallRightPanel from /api/crm/conversation/:id/context.
   * Same shape as the chat-side panel - single source of truth.
   */
  openIssues?: CrmOpenIssue[];
  loading?: boolean;
}

/**
 * Open issues / open tickets card on the voice workspace right panel.
 *
 * Open issues = incomplete CRM tasks linked to this customer's CRM record.
 * Loaded by the CRM identity service via the adapter's `listTasks` method
 * (vendor-native: Zoho Tasks, HubSpot tasks engagements, Salesforce Task).
 * Surfaced here so a voice agent answering an incoming call sees outstanding
 * commitments (promised callback, refund, pending quote) before they speak.
 */
export function OpenTicketsCard({ openIssues, loading }: Props) {
  const { t } = useI18n();
  const issues = openIssues ?? [];
  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-50 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-700">
          {t("voice.workspace.cards.tickets.title") || "Open issues"}
        </span>
        {issues.length > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">{issues.length}</span>
        )}
      </div>
      <div className="px-4 py-3">
        {loading ? (
          <p className="text-xs text-gray-400">Loading…</p>
        ) : issues.length === 0 ? (
          <p className="text-xs text-gray-500 italic">
            {t("voice.workspace.cards.tickets.placeholder") || "No open issues."}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {issues.map((iss) => (
              <li key={iss.id} className="rounded-md border border-amber-200 bg-amber-50/40 px-2.5 py-2">
                <div className="text-xs font-semibold text-amber-800 truncate">{iss.subject}</div>
                {iss.description && (
                  <div className="text-[11px] text-gray-600 mt-0.5 line-clamp-2">{iss.description}</div>
                )}
                <div className="text-[10px] text-gray-500 mt-1 space-x-2">
                  {iss.status && <span className="font-mono">{iss.status}</span>}
                  {iss.due_at && <span>due: {new Date(iss.due_at).toLocaleDateString()}</span>}
                  {iss.priority && <span>priority: {iss.priority}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
