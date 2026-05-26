"use client";

/**
 * Funnel list — admin landing page for pipeline funnels.
 *
 * Per-tenant (with optional per-department scope). Clicking a row
 * navigates to /settings/funnels/[id] where the per-stage copilot
 * editor lives.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  listFunnels,
  createFunnel,
  activateFunnel,
  deleteFunnel,
  type FunnelRow,
} from "@/lib/api-funnel";
import clsx from "clsx";

export default function FunnelsListPage() {
  const { token, user } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const [rows, setRows] = useState<FunnelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newFunnelId, setNewFunnelId] = useState("");

  async function refresh() {
    if (!token) return;
    setLoading(true);
    try {
      const r = await listFunnels(token);
      setRows(r.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("funnels.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function handleCreate() {
    if (!token) return;
    const id = newFunnelId.trim();
    if (!id) {
      setError(t("funnels.idRequired"));
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const r = await createFunnel(token, {
        funnelId: id,
        stages: [
          { id: "new", label: "New", baseStage: "initial" },
          { id: "qualified", label: "Qualified", baseStage: "exploration" },
          { id: "closed", label: "Closed", baseStage: "decision" },
        ],
        transitions: [],
      });
      router.push(`/settings/funnels/${r.data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("funnels.createFailed"));
    } finally {
      setCreating(false);
    }
  }

  async function handleActivate(row: FunnelRow) {
    if (!token) return;
    await activateFunnel(token, row.id);
    await refresh();
  }

  async function handleDelete(row: FunnelRow) {
    if (!token) return;
    if (!confirm(t("funnels.deleteConfirm", { id: row.funnelId }))) return;
    await deleteFunnel(token, row.id);
    await refresh();
  }

  if (user?.role !== "ADMIN") {
    return (
      <div className="max-w-3xl mx-auto p-6 text-sm text-gray-500">
        {t("funnels.adminOnly")}
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t("funnels.title")}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {t("funnels.subtitle")}
          </p>
        </div>
      </header>

      <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4">
        <h2 className="text-sm font-semibold text-gray-900 mb-2">{t("funnels.createTitle")}</h2>
        <p className="text-xs text-gray-500 mb-3">
          {t("funnels.createSubtitle")}
        </p>
        <form
          onSubmit={(e) => { e.preventDefault(); handleCreate(); }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={newFunnelId}
            onChange={(e) => setNewFunnelId(e.target.value)}
            placeholder={t("funnels.createPlaceholder")}
            disabled={creating}
            autoFocus
            className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300"
          />
          <button
            type="submit"
            disabled={creating}
            className={clsx(
              "inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg transition",
              creating
                ? "bg-indigo-300 text-white cursor-wait"
                : "bg-indigo-600 text-white hover:bg-indigo-700 cursor-pointer shadow-sm",
            )}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            {creating ? t("funnels.creating") : t("funnels.createButton")}
          </button>
        </form>
      </div>

      {error && (
        <div className="mb-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-10 text-center text-sm text-gray-400">{t("funnels.loading")}</div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-10 text-center">
          <p className="text-sm text-gray-700 font-medium mb-1">{t("funnels.emptyTitle")}</p>
          <p className="text-xs text-gray-500">
            {t("funnels.emptyBody")}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li
              key={r.id}
              className={clsx(
                "rounded-2xl bg-white border p-4 flex items-center justify-between gap-3",
                r.isActive ? "border-indigo-200" : "border-gray-200",
              )}
            >
              <Link href={`/settings/funnels/${r.id}`} className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-semibold text-gray-900 truncate">
                    {r.funnelId}
                  </span>
                  {r.isActive && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100 uppercase tracking-wider">
                      {t("funnels.active")}
                    </span>
                  )}
                  {r.departmentId && (
                    <span className="text-[10px] text-gray-500 font-mono">dept:{r.departmentId}</span>
                  )}
                  {!r.departmentId && (
                    <span className="text-[10px] text-gray-400">{t("funnels.tenantDefault")}</span>
                  )}
                </div>
                <div className="text-[11px] text-gray-500">
                  {t("funnels.stagesCount", { n: String(r.stages.length) })} · {t("funnels.transitionsCount", { n: String(r.transitions.length) })}
                </div>
              </Link>
              <div className="flex items-center gap-1.5 shrink-0">
                {!r.isActive && (
                  <button
                    type="button"
                    onClick={() => handleActivate(r)}
                    className="text-[11px] px-2.5 py-1 rounded-md bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100 hover:bg-indigo-100"
                  >
                    {t("funnels.activate")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleDelete(r)}
                  className="text-[11px] px-2.5 py-1 rounded-md text-rose-700 hover:bg-rose-50"
                >
                  {t("funnels.delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
