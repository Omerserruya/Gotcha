"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function IntelligenceFieldsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/settings/intelligence?tab=fields");
  }, [router]);
  return null;
}
