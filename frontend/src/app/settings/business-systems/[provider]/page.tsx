"use client";

// Settings-owned provider connection route. The ENTIRE Source-of-Truth connect
// flow (browse → connect → OAuth round-trip → back) stays inside Settings and
// never bounces to the AI Studio marketplace: it reuses the same underlying
// connection rows AI Studio uses (one OAuth per provider, ever), but with a
// Settings back target and the settings_business_systems OAuth flow so the
// callback returns here.

import { useDynamicParam } from "@/lib/useRouteParam";
import { IntegrationDetail } from "@/components/IntegrationDetail";

export default function BusinessSystemProviderPage() {
  const provider = useDynamicParam("provider");
  return (
    <IntegrationDetail
      slug={provider}
      backHref="/settings/business-systems"
      oauthFlow="settings_business_systems"
      withLayout={false}
    />
  );
}
