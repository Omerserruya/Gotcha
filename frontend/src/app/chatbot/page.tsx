"use client";

import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getChatbotFlows, createChatbotFlow, getChannelConfig } from "@/lib/api";
import { FlowEditor } from "@/components/chatbot/FlowEditor";
import clsx from "clsx";

type ChannelTab = {
  value: string | null;
  label: string;
  color: string;
  bgActive: string;
  bgHover: string;
  borderActive: string;
  icon: React.ReactNode;
};

const CHANNEL_TABS: ChannelTab[] = [
  {
    value: null,
    label: "Universal",
    color: "text-gray-700",
    bgActive: "bg-white",
    bgHover: "hover:bg-gray-100",
    borderActive: "border-gray-300",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
      </svg>
    ),
  },
  {
    value: "WHATSAPP",
    label: "WhatsApp",
    color: "text-green-700",
    bgActive: "bg-green-50",
    bgHover: "hover:bg-green-50/60",
    borderActive: "border-green-400",
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
      </svg>
    ),
  },
  {
    value: "MESSENGER",
    label: "Messenger",
    color: "text-blue-700",
    bgActive: "bg-blue-50",
    bgHover: "hover:bg-blue-50/60",
    borderActive: "border-blue-400",
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 0C5.373 0 0 4.974 0 11.111c0 3.498 1.744 6.614 4.469 8.654V24l4.088-2.242c1.092.301 2.246.464 3.443.464 6.627 0 12-4.974 12-11.111S18.627 0 12 0zm1.191 14.963l-3.055-3.26-5.963 3.26L10.732 8.2l3.131 3.26 5.886-3.26-6.558 6.763z" />
      </svg>
    ),
  },
];

export default function ChatbotPage() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [flowId, setFlowId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [botFlowMode, setBotFlowMode] = useState<string>("UNIFIED");
  const [activeTab, setActiveTab] = useState<string | null>(null); // null = universal

  const loadFlowForChannel = useCallback(async (channel: string | null) => {
    if (!token) return;
    setLoading(true);
    setFlowId(null);
    try {
      const flows = await getChatbotFlows(token, channel);
      if (flows.length > 0) {
        setFlowId(flows[0].id);
      } else {
        // Auto-create flow for this channel scope
        const name = channel ? `${channel} Flow` : "Chatbot Flow";
        const flow = await createChatbotFlow(token, {
          name,
          description: "",
          channel,
          nodes: [{ id: "start-1", type: "start", data: {} }],
          edges: [],
        });
        setFlowId(flow.id);
      }
    } catch (err) {
      console.error("Failed to load chatbot flow:", err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Load bot flow mode config
  useEffect(() => {
    if (!token) return;
    async function loadConfig() {
      try {
        const configRes = await getChannelConfig(token!);
        const mode = configRes.data?.botFlowMode || "UNIFIED";
        setBotFlowMode(mode);
      } catch {
        // Default to UNIFIED
      }
    }
    loadConfig();
  }, [token]);

  // Load flow when tab or mode changes
  useEffect(() => {
    if (!token) return;
    if (botFlowMode === "UNIFIED") {
      // In unified mode, always load the universal flow (channel=null)
      loadFlowForChannel(null);
    } else {
      loadFlowForChannel(activeTab);
    }
  }, [token, botFlowMode, activeTab, loadFlowForChannel]);

  function handleTabChange(channel: string | null) {
    setActiveTab(channel);
  }

  return (
    <AppLayout>
      {/* Channel tabs - only shown in PER_CHANNEL mode */}
      {botFlowMode === "PER_CHANNEL" && (
        <div className="bg-gradient-to-b from-gray-100 to-gray-50 border-b border-gray-200 px-4 pt-3 pb-0">
          <div className="flex items-end gap-1">
            {CHANNEL_TABS.map((tab) => {
              const isActive = activeTab === tab.value;
              return (
                <button
                  key={tab.value ?? "universal"}
                  onClick={() => handleTabChange(tab.value)}
                  className={clsx(
                    "relative flex items-center gap-2.5 px-5 py-2.5 text-sm font-semibold transition-all",
                    "rounded-t-2xl border border-b-0",
                    isActive
                      ? `${tab.bgActive} ${tab.color} ${tab.borderActive} shadow-sm -mb-px z-10`
                      : `bg-transparent border-transparent text-gray-400 ${tab.bgHover} hover:text-gray-600`
                  )}
                >
                  {/* Channel logo */}
                  <span className={clsx(
                    "flex items-center justify-center w-7 h-7 rounded-lg transition-all",
                    isActive
                      ? tab.value === "WHATSAPP" ? "bg-green-100 text-green-600"
                        : tab.value === "MESSENGER" ? "bg-blue-100 text-blue-600"
                        : "bg-gray-200 text-gray-600"
                      : "bg-gray-200/60 text-gray-400"
                  )}>
                    {tab.icon}
                  </span>
                  <span>{tab.label}</span>
                  {/* Active dot indicator */}
                  {isActive && (
                    <span className={clsx(
                      "w-1.5 h-1.5 rounded-full",
                      tab.value === "WHATSAPP" ? "bg-green-500"
                        : tab.value === "MESSENGER" ? "bg-blue-500"
                        : "bg-gray-500"
                    )} />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-screen">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
            <span className="text-sm text-gray-400">{t("common.loading")}</span>
          </div>
        </div>
      ) : flowId ? (
        <FlowEditor flowId={flowId} key={flowId} />
      ) : (
        <div className="flex items-center justify-center h-screen">
          <p className="text-sm text-gray-400">{t("common.error")}</p>
        </div>
      )}
    </AppLayout>
  );
}
