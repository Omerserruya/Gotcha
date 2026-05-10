"use client";

import { AppLayout } from "@/components/AppLayout";
import IntegrationsExplorer from "@/components/IntegrationsExplorer";

/**
 * Top-level integrations marketplace. Renders inside AppLayout (sidebar +
 * chrome). Same data + actions as Settings → Integrations; both surfaces
 * read/write the same tenant_integrations rows.
 */
export default function IntegrationsMarketplacePage() {
  return (
    <AppLayout>
      <IntegrationsExplorer />
    </AppLayout>
  );
}
