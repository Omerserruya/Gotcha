"use client";

/**
 * What the WhatsApp history import learned about THIS customer, shown to the
 * human handling the chat.
 *
 * The import produced a summary and durable facts per customer, and until this
 * card existed only the AI could see them: the memory went into the bot prompt
 * and nowhere else. An owner who had just imported thousands of conversations
 * opened a chat and saw nothing, which reads as "the import did nothing".
 *
 * Labelled as learned-from-history rather than presented as fact. Everything
 * here was inferred by a model from old conversations - good context to open
 * with, not something to state back to the customer as certain.
 */

import { useEffect, useState } from "react";
import { getImportedCustomerContext, type ImportedCustomerContext } from "@/lib/api";

export function ImportedHistoryCard({
  customerExternalId,
  token,
  t,
}: {
  customerExternalId: string | null | undefined;
  token: string | null;
  t: (k: string, vars?: Record<string, string>) => string;
}) {
  const [context, setContext] = useState<ImportedCustomerContext | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!token || !customerExternalId) {
      setContext(null);
      return;
    }
    getImportedCustomerContext(token, customerExternalId)
      .then((r) => {
        if (!cancelled) setContext(r.context);
      })
      // Context is an enhancement: a failure shows nothing rather than an error
      // an agent can do nothing about mid-conversation.
      .catch(() => {
        if (!cancelled) setContext(null);
      });
    return () => {
      cancelled = true;
    };
  }, [token, customerExternalId]);

  if (!context || (!context.summary && context.facts.length === 0)) return null;

  const facts = expanded ? context.facts : context.facts.slice(0, 3);

  return (
    <div className="rounded-xl border border-violet-100 bg-violet-50/40 p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700">
          {t("conversations.importedHistory.badge")}
        </span>
        {context.messageCount != null && context.messageCount > 0 && (
          <span className="text-[10px] text-gray-500">
            {t("conversations.importedHistory.fromMessages").replace("{n}", String(context.messageCount))}
          </span>
        )}
      </div>

      {context.summary && <p className="text-xs leading-relaxed text-gray-700">{context.summary}</p>}

      {facts.length > 0 && (
        <ul className="mt-2 space-y-1">
          {facts.map((f, i) => (
            <li key={i} className="flex gap-1.5 text-xs text-gray-700">
              <span className="text-violet-400">·</span>
              <span>{f.text}</span>
            </li>
          ))}
        </ul>
      )}

      {context.facts.length > 3 && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-[11px] font-medium text-violet-700 hover:text-violet-800"
        >
          {expanded
            ? t("conversations.importedHistory.showLess")
            : t("conversations.importedHistory.showMore").replace("{n}", String(context.facts.length - 3))}
        </button>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-gray-500">
        {t("conversations.importedHistory.disclaimer")}
      </p>
    </div>
  );
}
