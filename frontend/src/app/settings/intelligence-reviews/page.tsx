"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function IntelligenceReviewsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/settings/intelligence?tab=review");
  }, [router]);
  return null;
}
