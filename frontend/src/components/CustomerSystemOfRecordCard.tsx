"use client";

// Customer system of record picker.
//
// One tenant can have several systems holding customer data at once (a CRM,
// Shopify, a custom DB). Exactly ONE of them answers "who is this customer?" -
// the AI reads identity, history and summaries from it, and writes notes and
// tags back to it. This card is where an admin names that system.
//
// It lives in Settings → Integrations, not in the marketplace: the marketplace
// is for browsing and connecting, while WHICH connected system wins is an
// account-level decision that shouldn't be buried on one vendor's detail page.
//
// Naming: this used to be called "source of truth" on the Shopify page. With
// multiple integrations connected that phrase said nothing about WHAT it was
// the truth for, so it now names the thing it actually decides: the system of
// record for CUSTOMERS.

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { usePermissions } from "@/context/PermissionsContext";
import { getMarketplaceIntegrations, setIntegrationCrmSource, getSourceOfTruthStatus, type SourceOfTruthStatus } from "@/lib/api";
import { logoForIntegration } from "@/lib/integration-logos";

// Integrations that can be elected the customer system of record while not
// being CRM-category. Kept in sync with the server, which today only accepts
// this toggle for shopify (PUT /api/integrations/:slug/crm-source).
const ELECTABLE_NON_CRM = new Set(["shopify"]);

type Row = { slug: string; name: string; category: string; connected: boolean; isRecord: boolean };

export default function CustomerSystemOfRecordCard() {
  const { token } = useAuth();
  const { t } = useI18n();
  // Electing the Source of Truth is its own permission (backend enforces the
  // same key on PUT /:slug/crm-source) - never a role check.
  const { can } = usePermissions();
  const canSelectSot = can("business-systems:sot:select");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  // Backend-resolved election + truthful capability set - what the AI-side
  // resolver ACTUALLY uses, never inferred from local toggle state.
  const [sot, setSot] = useState<SourceOfTruthStatus | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      getSourceOfTruthStatus(token).then((r) => setSot(r.data)).catch(() => setSot(null));
      const res = await getMarketplaceIntegrations(token);
      const list = ((res as any)?.data || []) as any[];
      setRows(
        list
          .filter((i) => ELECTABLE_NON_CRM.has(i.slug))
          .map((i) => ({
            slug: i.slug,
            name: i.name || i.slug,
            category: i.category,
            connected: i.tenantConnection?.status === "CONNECTED",
            isRecord: (i.tenantConnection?.config as any)?.useAsCrm === true,
          })),
      );
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  async function toggle(row: Row) {
    if (!token || saving || !canSelectSot) return;
    const next = !row.isRecord;
    setSaving(row.slug);
    // Optimistic: the server is authoritative, so reload after either outcome.
    setRows((prev) => prev.map((r) => (r.slug === row.slug ? { ...r, isRecord: next } : r)));
    try {
      await setIntegrationCrmSource(token, row.slug, next);
    } catch {
      setRows((prev) => prev.map((r) => (r.slug === row.slug ? { ...r, isRecord: !next } : r)));
    } finally {
      setSaving(null);
      await load();
    }
  }

  // Nothing electable is connected AND no system of record resolved - the CRM
  // the admin connects below becomes the record by default; nothing to show.
  const hasElectable = rows.some((r) => r.connected);
  if (loading || (!hasElectable && !sot?.configured)) return null;

  const CAP_ORDER = [
    "identify_customer", "customer_context", "related_business_context",
    "write_conversation_summary", "write_interaction", "update_customer_fields",
    "create_task", "merge_contacts",
  ];

  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 mb-6">
      <h2 className="font-semibold text-gray-900">{t("settings.integrations.systemOfRecord.title")}</h2>
      <p className="text-sm text-gray-500 mt-1">{t("settings.integrations.systemOfRecord.subtitle")}</p>

      {/* The resolved system of record + what it can genuinely do. Rendered
          from the backend resolver's answer so a toggle that didn't take (or
          an ERROR connection) can never show phantom capabilities. */}
      {sot?.configured && (
        <div className="mt-4 rounded-xl border border-violet-100 bg-violet-50/40 p-3">
          <p className="text-sm text-gray-800">
            <span className="font-medium">{t("settings.integrations.systemOfRecord.currentTitle")}:</span>{" "}
            <span className="font-semibold capitalize">{sot.vendor}</span>
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {CAP_ORDER.map((cap) => {
              const ok = sot.capabilities.includes(cap);
              return (
                <span
                  key={cap}
                  title={ok ? undefined : t("settings.integrations.systemOfRecord.capUnsupported")}
                  className={clsx(
                    "px-2 py-0.5 rounded-full text-[11px] font-medium border",
                    ok ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-50 text-gray-400 border-gray-200 line-through",
                  )}
                >
                  {t(`settings.integrations.systemOfRecord.caps.${cap}`)}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-4 space-y-2">
        {rows.filter((r) => r.connected).map((row) => {
          const logo = logoForIntegration(row.slug);
          return (
            <div key={row.slug} className="flex items-center gap-3 rounded-xl border border-gray-100 bg-gray-50/50 p-3">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logo} alt="" className="w-7 h-7 rounded-lg object-contain shrink-0" />
              ) : (
                <div className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-500 shrink-0">
                  {row.name.charAt(0)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-800 truncate">{row.name}</p>
                {row.isRecord ? (
                  <span className="inline-block mt-0.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-50 text-green-700 border border-green-200">
                    {t("settings.integrations.systemOfRecord.active")}
                  </span>
                ) : (
                  <p className="text-xs text-gray-400">{t("settings.integrations.systemOfRecord.inactiveHint")}</p>
                )}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={row.isRecord}
                aria-label={t("settings.integrations.systemOfRecord.title")}
                disabled={saving === row.slug || !canSelectSot}
                onClick={() => toggle(row)}
                className={clsx(
                  "relative w-12 h-7 rounded-full transition-colors shrink-0 disabled:opacity-50",
                  row.isRecord ? "bg-violet-500" : "bg-gray-200",
                )}
              >
                <span className={clsx(
                  "absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform",
                  row.isRecord && "translate-x-5",
                )} />
              </button>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-gray-400 mt-3">{t("settings.integrations.systemOfRecord.note")}</p>
    </div>
  );
}
