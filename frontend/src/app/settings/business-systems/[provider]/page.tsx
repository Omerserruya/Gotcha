"use client";

// Settings-owned provider connection route. The ENTIRE Source-of-Truth connect
// flow (browse → connect → OAuth round-trip → back) stays inside Settings and
// never bounces to the AI Studio marketplace: it reuses the same underlying
// connection rows AI Studio uses (one OAuth per provider, ever), but with a
// Settings back target and the settings_business_systems OAuth flow so the
// callback returns here.

import { useDynamicParam } from "@/lib/useRouteParam";
import { IntegrationDetail } from "@/components/IntegrationDetail";
import { RequirePermission } from "@/components/RequirePermission";

export default function BusinessSystemProviderPage() {
  const provider = useDynamicParam("provider");
  return (
    // Page access needs read; connect/disconnect actions inside are gated on
    // the business-systems permission keys passed below (and re-enforced by
    // the backend routes regardless).
    <RequirePermission perm="business-systems:connections:read" redirectTo="/settings">
      <IntegrationDetail
        slug={provider}
        backHref="/settings/business-systems"
        oauthFlow="settings_business_systems"
        withLayout={false}
        connectPerm="business-systems:connections:connect"
        disconnectPerm="business-systems:connections:manage"
      />
    </RequirePermission>
  );
}
