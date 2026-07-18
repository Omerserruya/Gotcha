"use client";

import IntegrationsExplorer from "@/components/IntegrationsExplorer";
import CustomerSystemOfRecordCard from "@/components/CustomerSystemOfRecordCard";
import { useI18n } from "@/context/I18nContext";

/**
 * Settings → Integrations. Locked to category=CRM (plus any integration
 * flagged `canActAsCrm`, e.g. Shopify, which a tenant can elect as their CRM
 * source of truth) - the full marketplace (payments, e-commerce, calendars,
 * custom APIs, etc.) lives at /integrations. This surface is intentionally
 * narrow: settings is where
 * an admin connects the CRM that audiences, broadcasts, and the
 * `escalate_to_human` flow read from. Both surfaces read/write the same
 * tenant_integrations rows so connecting here also reflects in the
 * marketplace immediately.
 */
export default function SettingsIntegrationsPage() {
  const { t } = useI18n();
  return (
    <IntegrationsExplorer
      title={t("settings.integrations.crmTitle")}
      subtitle={t("settings.integrations.crmSubtitle")}
      restrictToCategory="CRM"
      // Which connected system answers "who is this customer?" is an
      // account-level decision, so it belongs here rather than on one vendor's
      // marketplace page (where it used to live, as "source of truth").
      beforeContent={<CustomerSystemOfRecordCard />}
    />
  );
}
