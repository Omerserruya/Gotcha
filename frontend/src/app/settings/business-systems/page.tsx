"use client";

// Business Systems - the tenant's Source of Truth home. This is NOT a tool
// marketplace: it connects the business data systems (CRM, Shopify, other
// customer-record systems), elects which one answers "who is this customer?",
// and shows connection/sync health. Operational AI tools for the same
// providers live in AI Studio - both surfaces reuse the SAME underlying
// connection rows (one OAuth per provider, ever).

import { useEffect, useState } from "react";
import Link from "next/link";
import IntegrationsExplorer from "@/components/IntegrationsExplorer";
import CustomerSystemOfRecordCard from "@/components/CustomerSystemOfRecordCard";
import { useI18n } from "@/context/I18nContext";
import { useAuth } from "@/context/AuthContext";
import { getSourceOfTruthStatus, getMarketplaceIntegrations } from "@/lib/api";

interface SotStatus {
  configured: boolean;
  vendor: string | null;
  capabilities: string[];
  unsupported?: string[];
  writesEnabled?: boolean;
}

/**
 * Live status strip for the elected Source of Truth: which system is
 * authoritative, read/write capability, and how many of its tools are
 * exposed to AI employees - all from the SAME connection row AI Studio uses.
 */
function SourceOfTruthStatusPanel() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [status, setStatus] = useState<SotStatus | null>(null);
  const [rows, setRows] = useState<Array<{
    slug: string;
    tenantConnection?: { status?: string } | null;
    catalogTools?: Array<{ tenantTool?: { isEnabled?: boolean } | null }>;
  }>>([]);

  useEffect(() => {
    if (!token) return;
    getSourceOfTruthStatus(token).then((r) => setStatus(r.data)).catch(() => {});
    getMarketplaceIntegrations(token).then((r) => setRows(r.data || [])).catch(() => {});
  }, [token]);

  // The SAME connection row powers AI tools - match it by the elected vendor
  // (catalog slug for Zoho is zoho_crm; the resolver reports "zoho").
  const vendorSlug = status?.vendor === "zoho" ? "zoho_crm" : status?.vendor;
  const electedRow = rows.find((row) => row.slug === vendorSlug && row.tenantConnection);
  const tools = electedRow?.catalogTools || [];
  const toolInfo = electedRow
    ? {
        slug: electedRow.slug,
        connStatus: String(electedRow.tenantConnection?.status || ""),
        enabled: tools.filter((ct) => ct.tenantTool?.isEnabled).length,
        total: tools.length,
      }
    : null;

  if (!status?.configured) return null;
  return (
    <div className="mb-5 rounded-2xl border border-emerald-100 bg-emerald-50/40 px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <div>
          <span className="text-gray-500">{t("settings.businessSystems.sotLabel")}: </span>
          <span className="font-semibold capitalize text-gray-900">{status.vendor}</span>
        </div>
        <div>
          <span className="text-gray-500">{t("settings.businessSystems.writeback")}: </span>
          <span className={status.writesEnabled ? "font-medium text-emerald-700" : "font-medium text-gray-500"}>
            {status.writesEnabled ? t("settings.businessSystems.enabled") : t("settings.businessSystems.readOnly")}
          </span>
        </div>
        {toolInfo && (
          <div>
            <span className="text-gray-500">{t("settings.businessSystems.aiTools")}: </span>
            <span className="font-medium text-gray-900">
              {t("settings.businessSystems.toolsEnabled").replace("{enabled}", String(toolInfo.enabled)).replace("{total}", String(toolInfo.total))}
            </span>
            <Link
              href={`/ai-studio/marketplace/${toolInfo.slug}`}
              className="ms-2 text-xs font-medium text-primary-600 hover:text-primary-700"
            >
              {t("settings.businessSystems.manageTools")}
            </Link>
          </div>
        )}
        {toolInfo && toolInfo.connStatus !== "CONNECTED" && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
            {t("settings.businessSystems.connectionAttention")}
          </span>
        )}
      </div>
    </div>
  );
}

export default function BusinessSystemsPage() {
  const { t } = useI18n();
  return (
    <IntegrationsExplorer
      title={t("settings.businessSystems.title")}
      subtitle={t("settings.businessSystems.subtitle")}
      restrictToCategory="CRM"
      // Keep the whole connect flow inside Settings - cards open the
      // Settings-owned provider route, never the AI Studio marketplace.
      detailHref={(slug) => `/settings/business-systems/${slug}`}
      // Which connected system answers "who is this customer?" is an
      // account-level decision, so it lives here - never duplicated in the
      // AI Studio marketplace (which only exposes operational tools).
      beforeContent={
        <>
          <SourceOfTruthStatusPanel />
          <CustomerSystemOfRecordCard />
        </>
      }
    />
  );
}
