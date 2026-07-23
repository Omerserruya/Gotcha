"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  listToolPermissions,
  updateToolPermission,
  type ToolPermissionRow,
} from "@/lib/gotcha-api";

type KindFilter = "action" | "integration" | "system" | "all";

/**
 * Tool permissions matrix - moved into AI Studio's Skills tab (view=permissions).
 * Same behavior as the former /settings/tools page, minus the page chrome.
 */
export default function ToolPermissionsPanel() {
  const { token } = useAuth();
  const { t } = useI18n();

  const KIND_LABEL: Record<ToolPermissionRow["kind"], string> = {
    action: t("settings.tools.kindAction"),
    integration: t("settings.tools.kindIntegration"),
    system: t("settings.tools.kindSystem"),
  };

  const CATEGORY_LABEL: Record<string, string> = {
    messaging: t("settings.tools.catMessaging"),
    crm: t("settings.tools.catCrm"),
    broadcast: t("settings.tools.catCampaign"),
    workflow: t("settings.tools.catWorkflow"),
    identity: t("settings.tools.catIdentity"),
    memory: t("settings.tools.catMemory"),
    knowledge: t("settings.tools.catKnowledge"),
    meta: t("settings.tools.catMeta"),
  };

  const [rows, setRows] = useState<ToolPermissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>("action");
  const [savingTool, setSavingTool] = useState<string | null>(null);

  async function load() {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await listToolPermissions(token);
      setRows(res.data ?? []);
    } catch (e: any) {
      setError(e?.message ?? t("settings.tools.errorLoad"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const filtered = useMemo(() => {
    if (kindFilter === "all") return rows;
    return rows.filter((r) => r.kind === kindFilter);
  }, [rows, kindFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, ToolPermissionRow[]>();
    for (const r of filtered) {
      const key = r.category;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  async function patchTool(
    row: ToolPermissionRow,
    patch: Partial<Pick<ToolPermissionRow, "enabled" | "requiresApproval">>,
  ) {
    if (!token) return;
    setSavingTool(row.toolName);
    const previous = rows;
    setRows((rs) =>
      rs.map((r) =>
        r.toolName === row.toolName ? { ...r, ...patch, isDefault: false } : r,
      ),
    );
    try {
      await updateToolPermission(token, row.toolName, patch);
    } catch (e: any) {
      setRows(previous);
      setError(e?.message ?? t("settings.tools.errorSave"));
    } finally {
      setSavingTool(null);
    }
  }

  if (!token) return null;

  const counts = {
    action: rows.filter((r) => r.kind === "action").length,
    integration: rows.filter((r) => r.kind === "integration").length,
    system: rows.filter((r) => r.kind === "system").length,
    all: rows.length,
  };

  return (
    <div>
      <header className="mb-5">
        <h2 className="text-lg font-semibold text-gray-900">{t("settings.tools.title")}</h2>
        <p className="text-sm text-gray-400 mt-0.5">{t("settings.tools.subtitle")}</p>
      </header>

      <div className="flex items-center gap-1 border-b border-gray-200 mb-4">
        {(["action", "integration", "system", "all"] as KindFilter[]).map((k) => (
          <button
            key={k}
            onClick={() => setKindFilter(k)}
            className={clsx(
              "px-4 py-2 text-sm font-medium -mb-px border-b-2 transition",
              kindFilter === k
                ? "text-violet-700 border-violet-600"
                : "text-gray-500 border-transparent hover:text-gray-700",
            )}
          >
            {t(`settings.tools.filter.${k}`)} ({counts[k]})
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-3 px-4 py-2 text-sm bg-red-50 border border-red-200 text-red-700 rounded-lg">
          {error}
        </div>
      )}

      {loading && rows.length === 0 && (
        <div className="text-sm text-gray-500 py-8 text-center">{t("settings.tools.loading")}</div>
      )}

      <div className="space-y-5">
        {grouped.map(([category, list]) => (
          <section key={category}>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-2">
              {CATEGORY_LABEL[category] ?? category}
            </h3>
            <div className="bg-white rounded-xl shadow-subtle border border-gray-100 overflow-hidden">
              {list.map((row, i) => (
                <div
                  key={row.toolName}
                  className={clsx(
                    "px-4 py-3 flex items-start gap-4",
                    i > 0 && "border-t border-gray-100",
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <code className="text-sm font-mono text-gray-900">{row.toolName}</code>
                      <KindChip kind={row.kind} label={KIND_LABEL[row.kind]} />
                      {row.isDefault && (
                        <span className="text-[10px] text-gray-400 italic">{t("settings.tools.default")}</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500">{row.description}</p>
                  </div>
                  <div className="flex items-center gap-6 shrink-0 pt-0.5">
                    <ToggleLabel
                      label={t("settings.tools.enabled")}
                      checked={row.enabled}
                      disabled={savingTool === row.toolName}
                      onChange={(v) => patchTool(row, { enabled: v })}
                    />
                    <ToggleLabel
                      label={t("settings.tools.hitl")}
                      hint={t("settings.tools.hitlHint")}
                      checked={row.requiresApproval}
                      disabled={!row.enabled || savingTool === row.toolName}
                      onChange={(v) => patchTool(row, { requiresApproval: v })}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
        {!loading && filtered.length === 0 && (
          <div className="bg-white rounded-xl shadow-subtle p-10 text-center text-sm text-gray-500">
            {t("settings.tools.empty")}
          </div>
        )}
      </div>
    </div>
  );
}

function KindChip({ kind, label }: { kind: ToolPermissionRow["kind"]; label: string }) {
  const style =
    kind === "action"
      ? "bg-violet-50 text-violet-700 border-violet-100"
      : kind === "integration"
      ? "bg-blue-50 text-blue-700 border-blue-100"
      : "bg-gray-50 text-gray-600 border-gray-200";
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 border rounded ${style}`}>
      {label}
    </span>
  );
}

function ToggleLabel({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        title={hint}
        className={clsx(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-violet-600" : "bg-gray-200",
          disabled && "opacity-40 cursor-not-allowed",
        )}
      >
        <span
          className={clsx(
            "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all",
            checked ? "left-[18px]" : "left-0.5",
          )}
        />
      </button>
      <span className="text-[10px] text-gray-500 mt-1">{label}</span>
    </div>
  );
}
