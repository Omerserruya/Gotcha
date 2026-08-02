"use client";

// "Your Business" is retired as a product area - everything it displayed is
// now Knowledge Base content the AI employee can actually retrieve. Redirect
// straight to Knowledge rather than hopping through /settings/business, so an
// old deep link costs one navigation instead of two.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function BusinessPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/ai-studio/knowledge"); }, [router]);
  return null;
}
