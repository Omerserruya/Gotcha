"use client";

import { useEffect, useState } from "react";
import { getSocket } from "@/lib/socket";
import { useI18n } from "@/context/I18nContext";
import { useVoiceCall, type CopilotSuggestion } from "@/context/VoiceCallContext";

interface Props {
  sessionId: string;
  conversationId: string | null;
}

/**
 * Live co-pilot suggestions for the workspace right rail. Subscribes to
 * `voice.copilot.suggestions` AND `voice.frame.updated` (the new Phase-3
 * intelligence event). Falls back to whatever the VoiceCallContext has
 * already cached when the agent placed the call locally.
 */
export function CopilotSuggestionsCard({ conversationId }: Props) {
  const voice = useVoiceCall();
  const { t } = useI18n();
  const [suggestions, setSuggestions] = useState<CopilotSuggestion[]>(voice.copilotSuggestions);

  // Reseed when the underlying VoiceCallContext changes (it already filters
  // by activeConversationIdRef so we trust its output for self-placed calls).
  useEffect(() => {
    if (voice.copilotSuggestions.length > 0) {
      setSuggestions(voice.copilotSuggestions);
    }
  }, [voice.copilotSuggestions]);

  useEffect(() => {
    if (!conversationId) return;
    const socket = getSocket();
    if (!socket) return;

    const onSuggestions = (data: unknown) => {
      const d = data as { conversationId?: string; suggestions?: CopilotSuggestion[] };
      if (!d || d.conversationId !== conversationId) return;
      if (!Array.isArray(d.suggestions)) return;
      setSuggestions(d.suggestions.slice(0, 5));
    };

    const onFrame = (data: unknown) => {
      const d = data as { frame?: { conversationId?: string; suggestedActions?: Array<{ text: string; rationale?: string; urgency: string }> } };
      const frame = d?.frame;
      if (!frame || frame.conversationId !== conversationId) return;
      const actions = frame.suggestedActions || [];
      if (actions.length === 0) {
        setSuggestions([]);
        return;
      }
      setSuggestions(
        actions.slice(0, 5).map((a, i) => ({
          id: `frame:${i}`,
          title: a.urgency === "high" ? "Act now" : a.urgency === "medium" ? "Consider" : "Hint",
          body: a.text,
          text: a.rationale || a.text,
          kind: a.urgency,
          confidence: 1,
        })),
      );
    };

    socket.on("voice.copilot.suggestions", onSuggestions);
    socket.on("voice.frame.updated", onFrame);
    return () => {
      socket.off("voice.copilot.suggestions", onSuggestions);
      socket.off("voice.frame.updated", onFrame);
    };
  }, [conversationId]);

  return (
    <Card title={t("voice.workspace.cards.copilot.title")} accent="violet">
      {suggestions.length === 0 ? (
        <p className="text-xs text-gray-500 italic">
          {t("voice.workspace.cards.copilot.listening")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {suggestions.map((s, i) => {
            const title = s.title || s.kind || "Suggestion";
            const body = s.body || s.text || "";
            return (
              <div
                key={s.id || `${i}:${title}`}
                className="rounded-lg ring-1 ring-violet-100 bg-violet-50/60 px-3 py-2"
              >
                <div className="text-[10px] font-semibold uppercase tracking-wider text-violet-700 mb-0.5">{title}</div>
                {body && <div className="text-[12px] text-gray-700 leading-snug">{body}</div>}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function Card({ title, accent, children }: { title: string; accent?: "violet" | "gray"; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 flex items-center gap-2 border-b border-gray-50">
        <span className={accent === "violet" ? "text-violet-600" : "text-gray-500"}>
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><circle cx="10" cy="10" r="4" /></svg>
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">{title}</span>
      </div>
      <div className="px-4 py-3">{children}</div>
    </div>
  );
}
