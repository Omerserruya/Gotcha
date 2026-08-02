"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function PostConversationRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/settings/intelligence?tab=automations");
  }, [router]);
  return null;
}
