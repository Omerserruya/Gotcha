"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { getVoiceSessionContext, type VoiceSessionContext } from "@/lib/api";
import { CopilotSuggestionsCard } from "./cards/CopilotSuggestionsCard";
import { CustomerContextCard } from "./cards/CustomerContextCard";
import { PreviousCallsCard } from "./cards/PreviousCallsCard";
import { NotesCard } from "./cards/NotesCard";
import { OpenTicketsCard } from "./cards/OpenTicketsCard";
import { CrmHistoryCard } from "./cards/CrmHistoryCard";

interface Props {
  sessionId: string;
  conversationId: string | null;
}

/**
 * Right half of the /voice/[sessionId] workspace. Lazy-loads CRM context
 * once per session id. Cards render their own skeletons while loading.
 */
export function CallRightPanel({ sessionId, conversationId }: Props) {
  const { token } = useAuth();
  const [context, setContext] = useState<VoiceSessionContext | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token || !sessionId) return;
    let cancelled = false;
    setLoading(true);
    getVoiceSessionContext(token, sessionId)
      .then((res) => {
        if (!cancelled) setContext(res.data);
      })
      .catch(() => {
        if (!cancelled) setContext(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, sessionId]);

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50 p-4 flex flex-col gap-3">
      <CopilotSuggestionsCard sessionId={sessionId} conversationId={conversationId} />
      <CustomerContextCard context={context} loading={loading} />
      <PreviousCallsCard context={context} loading={loading} />
      <NotesCard />
      <OpenTicketsCard />
      <CrmHistoryCard context={context} loading={loading} />
    </div>
  );
}
