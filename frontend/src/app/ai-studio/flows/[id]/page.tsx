"use client";

import { useRouter, useParams } from "next/navigation";
import { AppLayout } from "@/components/AppLayout";
import { FlowEditor } from "@/components/chatbot/FlowEditor";

export default function FlowBuilderPage() {
  const router = useRouter();
  const params = useParams();
  const flowId = params.id as string;

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
