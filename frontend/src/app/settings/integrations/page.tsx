"use client";

import IntegrationsExplorer from "@/components/IntegrationsExplorer";

/**
 * Settings → Integrations. Locked to category=CRM (plus any integration
 * flagged `canActAsCrm`, e.g. Shopify, which a tenant can elect as their CRM
 * source of truth) — the full marketplace (payments, e-commerce, calendars,
 * custom APIs, etc.) lives at /integrations. This surface is intentionally
 * narrow: settings is where
 * an admin connects the CRM that audiences, broadcasts, and the
 * `escalate_to_human` flow read from. Both surfaces read/write the same
 * tenant_integrations rows so connecting here also reflects in the
 * marketplace immediately.
 */
export default function SettingsIntegrationsPage() {
  return (
    <IntegrationsExplorer
      title="CRM Integrations"
      subtitle="Connect your CRM (Zoho, HubSpot, Salesforce, Monday) — or use Shopify as your source of truth. The platform's audience builder, broadcasts, and AI handoffs read from the connected CRM."
      restrictToCategory="CRM"
    />
  );
}
