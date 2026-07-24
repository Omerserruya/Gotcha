"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useDynamicParam } from "@/lib/useRouteParam";
import { AppLayout } from "@/components/AppLayout";
import { FlowEditor } from "@/components/chatbot/FlowEditor";
import { aiStudioHref, normalizeAiStudioTab } from "@/lib/ai-studio-tabs";

export default function FlowBuilderPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const flowId = useDynamicParam();

  // Deterministic Back: a process editor belongs to the Processes tab. An
  // explicit ?returnTab= overrides (e.g. opened from Overview), else default
  // to Processes - never a bare /ai-studio that would fall through to Overview
  // without tab context.
  const rt = searchParams.get("returnTab");
  const returnTab = rt ? normalizeAiStudioTab(rt) : "processes";

  return (
    <AppLayout>
      <FlowEditor
        flowId={flowId}
        onBack={() => router.push(aiStudioHref(returnTab))}
        onCreated={(id) => router.replace(`/ai-studio/flows/${id}`)}
      />
    </AppLayout>
  );
}
