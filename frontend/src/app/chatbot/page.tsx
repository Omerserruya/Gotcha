"use client";

import { useState, useEffect } from "react";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getChatbotFlows, createChatbotFlow } from "@/lib/api";
import { FlowEditor } from "@/components/chatbot/FlowEditor";

export default function ChatbotPage() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [flowId, setFlowId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;

    async function loadOrCreateFlow() {
      try {
        const flows = await getChatbotFlows(token!);
        if (flows.length > 0) {
          setFlowId(flows[0].id);
        } else {
          // Auto-create the tenant's single flow
          const flow = await createChatbotFlow(token!, {
            name: "Chatbot Flow",
            description: "",
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
    }

    loadOrCreateFlow();
  }, [token]);

  return (
    <AppLayout>
      {loading ? (
        <div className="flex items-center justify-center h-screen">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
            <span className="text-sm text-gray-400">{t("common.loading")}</span>
          </div>
        </div>
      ) : flowId ? (
        <FlowEditor flowId={flowId} />
      ) : (
        <div className="flex items-center justify-center h-screen">
          <p className="text-sm text-gray-400">{t("common.error")}</p>
        </div>
      )}
    </AppLayout>
  );
}
