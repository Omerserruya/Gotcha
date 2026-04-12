"use client";

import { useRouter } from "next/navigation";
import { AppLayout } from "@/components/AppLayout";
import { MainPlaybookEditor } from "@/components/mainPlaybook/MainPlaybookEditor";

export default function MainPlaybookPage() {
  const router = useRouter();

  return (
    <AppLayout>
      <MainPlaybookEditor onBack={() => router.push("/ai-studio")} />
    </AppLayout>
  );
}
