"use client";

// "Your Business" moved to Settings → Business (the main sidebar slot went to
// Getting Started). This stub keeps every old deep link working.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function BusinessPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/settings/business"); }, [router]);
  return null;
}
