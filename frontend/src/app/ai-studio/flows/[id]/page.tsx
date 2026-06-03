"use client";

import { useRouter } from "next/navigation";
import { useDynamicParam } from "@/lib/useRouteParam";
import { AppLayout } from "@/components/AppLayout";
import { FlowEditor } from "@/components/chatbot/FlowEditor";

export default function FlowBuilderPage() {
  const router = useRouter();
  const flowId = useDynamicParam();

  return (
    <AppLayout>
      <FlowEditor
        flowId={flowId}
        onBack={() => router.push("/ai-studio")}
        onCreated={(id) => router.replace(`/ai-studio/flows/${id}`)}
      />
    </AppLayout>
  );
}
