"use client";

// Route entry for the AI Studio marketplace: /integrations/:slug. The reusable
// IntegrationDetail component lives in components/ (a route page.tsx may only
// export a default + Next reserved fields). Uses the component defaults
// (marketplace back + AppLayout chrome, no special OAuth flow).

import { useDynamicParam } from "@/lib/useRouteParam";
import { IntegrationDetail } from "@/components/IntegrationDetail";

export default function IntegrationDetailPage() {
  const slug = useDynamicParam("slug");
  return <IntegrationDetail slug={slug} />;
}
