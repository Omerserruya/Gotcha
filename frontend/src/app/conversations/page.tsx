"use client";

import { useState, useEffect } from "react";
import { useI18n } from "@/context/I18nContext";
import { AppLayout } from "@/components/AppLayout";
import { ConversationList } from "@/components/conversations/ConversationList";
import { ChatPanel } from "@/components/conversations/ChatPanel";

export default function ConversationsPage() {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Handle browser back button: push state when selecting a chat, pop to deselect
  useEffect(() => {
    if (selectedId) {
      window.history.pushState({ chatOpen: true }, "");
    }
  }, [selectedId]);

  useEffect(() => {
    function handlePopState(e: PopStateEvent) {
      if (selectedId) {
        e.preventDefault();
        setSelectedId(null);
      }
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [selectedId]);

  // Notify layout that a chat is open (to hide mobile header/bottom nav)
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("chat:toggle", { detail: { open: !!selectedId } }));
    return () => {
      window.dispatchEvent(new CustomEvent("chat:toggle", { detail: { open: false } }));
    };
  }, [selectedId]);

  return (
    <AppLayout>
      <div className={`flex md:gap-3 md:p-2 ${selectedId ? "h-screen" : "h-[calc(100vh-48px)]"} md:h-[calc(100vh-16px)]`}>
        {/* Conversation list - hidden on mobile when chat is selected */}
        <div className={`w-full md:w-[380px] bg-white flex-shrink-0 md:rounded-2xl md:shadow-subtle md:overflow-hidden ${selectedId ? "hidden md:flex" : "flex"} flex-col`}>
          <ConversationList
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>

        {/* Chat panel */}
        <div className={`flex-1 ${!selectedId ? "hidden md:flex" : "flex"} flex-col bg-white md:rounded-2xl md:shadow-subtle md:overflow-hidden`}>
          {selectedId ? (
            <ChatPanel
              conversationId={selectedId}
              onBack={() => setSelectedId(null)}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center bg-white">
              <div className="text-center text-gray-300">
                <div className="w-20 h-20 bg-gray-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <svg className="w-10 h-10 text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                  </svg>
                </div>
                <p className="text-sm text-gray-400">{t("conversations.selectConversation")}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
