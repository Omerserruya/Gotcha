"use client";

/**
 * Integrations & Tools workspace: sidebar + one selected integration.
 *
 * Every state shown here comes from the server, which computes it from the same
 * sources the runtime enforces against. Nothing is optimistic: a policy change
 * re-reads the integration, so what the row says afterwards is what the backend
 * actually stored. If a save fails the row goes back to what it was and says so,
 * rather than leaving a control showing a state that was never persisted.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getIntegrationWorkspace,
  getIntegrationDetail,
  setToolPolicy,
  type IntegrationDetail,
  type WorkspaceSidebar,
  type WorkspaceTool,
} from "@/lib/api-integration-workspace";
import {
  planBulkAction,
  bulkActionNeedsConfirmation,
  mayBeAlwaysAllowed,
  type BulkAction,
  type PermissionState,
} from "@/lib/tool-availability-client";
import { IntegrationSidebar } from "./IntegrationSidebar";
import { ToolPermissionRow, RiskGroupHeading, riskLabel } from "../ai-studio/ToolPermissionRow";
import ConfirmModal from "../ConfirmModal";

type Saving = { tool: string } | null;

export function IntegrationWorkspace() {
  const { token } = useAuth();
  const { locale } = useI18n();
  const he = locale === "he";
  const L = (en: string, hebrew: string) => (he ? hebrew : en);

  const [sidebar, setSidebar] = useState<WorkspaceSidebar | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<IntegrationDetail | null>(null);
  const [search, setSearch] = useState("");
  const [loadingSidebar, setLoadingSidebar] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Saving>(null);
  const [bulk, setBulk] = useState<{ action: BulkAction; count: number } | null>(null);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const loadSidebar = useCallback(async () => {
    if (!token) return;
    setLoadingSidebar(true);
    setError(null);
    try {
      const res = await getIntegrationWorkspace(token);
      setSidebar(res.data);
      // Land on the first connected tool integration - GOTCHA, which is always
      // there - rather than an empty panel.
      setSelectedId((cur) => cur ?? res.data.toolIntegrations.connected[0]?.id ?? null);
    } catch (e: any) {
      // A failure stays a failure. Rendering an empty sidebar would read as
      // "you have no integrations", which is a different statement.
      setError(e?.message || L("Could not load integrations.", "לא ניתן לטעון אינטגרציות."));
    } finally {
      setLoadingSidebar(false);
    }
  }, [token, he]);

  const loadDetail = useCallback(async (id: string) => {
    if (!token) return;
    setLoadingDetail(true);
    setSaveError(null);
    try {
      const res = await getIntegrationDetail(token, id);
      setDetail(res.data);
    } catch (e: any) {
      setDetail(null);
      setSaveError(e?.message || L("Could not load this integration.", "לא ניתן לטעון את האינטגרציה."));
    } finally {
      setLoadingDetail(false);
    }
  }, [token, he]);

  useEffect(() => { void loadSidebar(); }, [loadSidebar]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); }, [selectedId, loadDetail]);

  const allTools = useMemo(
    () => (detail?.groups ?? []).flatMap((g) => g.tools),
    [detail],
  );

  async function applyPolicy(tool: WorkspaceTool, next: Exclude<PermissionState, "unavailable">) {
    if (!token || !selectedId) return;
    setSaving({ tool: tool.name });
    setSaveError(null);
    try {
      await setToolPolicy(token, tool.name, next);
      // Re-read rather than patch locally: the server decides the resulting
      // state (it may provision, or refuse), and the row must show that.
      await loadDetail(selectedId);
      await loadSidebar();
    } catch (e: any) {
      setSaveError(
        e?.message ||
          L("That change did not save. The tool is unchanged.", "השינוי לא נשמר. הכלי לא שונה."),
      );
    } finally {
      setSaving(null);
    }
  }

  async function runBulk(action: BulkAction) {
    if (!token || !selectedId) return;
    const plan = planBulkAction(
      action,
      allTools.map((t) => ({ toolName: t.name, riskGroup: t.riskGroup, state: t.availability.state })),
    );
    if (plan.length === 0) {
      setBulkResult(L("Nothing to change.", "אין מה לשנות."));
      return;
    }
    setBulkResult(null);
    let ok = 0;
    let failed = 0;
    for (const p of plan) {
      try {
        await setToolPolicy(token, p.toolName, p.enabled ? (p.requiresApproval ? "require_approval" : "always_allow") : "disabled");
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    await loadDetail(selectedId);
    await loadSidebar();
    // Report what actually happened, including partial failure.
    setBulkResult(
      failed === 0
        ? L(`${ok} tools updated.`, `${ok} כלים עודכנו.`)
        : L(`${ok} updated, ${failed} failed.`, `${ok} עודכנו, ${failed} נכשלו.`),
    );
  }

  function requestBulk(action: BulkAction) {
    const count = planBulkAction(
      action,
      allTools.map((t) => ({ toolName: t.name, riskGroup: t.riskGroup, state: t.availability.state })),
    ).length;
    if (!bulkActionNeedsConfirmation(action)) { void runBulk(action); return; }
    setBulk({ action, count });
  }

  if (loadingSidebar) {
    return (
      <div className="flex items-center justify-center py-20" data-testid="workspace-loading">
        <div className="w-8 h-8 border-4 border-gray-200 border-t-primary-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-16 text-center" data-testid="workspace-error">
        <p className="text-sm text-gray-600">{error}</p>
        <button
          type="button"
          onClick={() => void loadSidebar()}
          className="mt-3 px-4 py-2 rounded-xl bg-primary-500 hover:bg-primary-600 text-white text-sm font-medium"
        >
          {L("Try again", "נסו שוב")}
        </button>
      </div>
    );
  }

  if (!sidebar) return null;

  const BULK_LABELS: Record<BulkAction, string> = {
    enable_all_read_only: L("Autonomous for all read-only", "אוטונומי לכל הקריאות"),
    require_approval_for_all_writes: L("Approval for all writes", "אישור לכל הכתיבות"),
    disable_all: L("Disable all", "כיבוי הכול"),
    restore_recommended: L("Restore recommended", "שחזור מומלץ"),
  };

  return (
    <div className="flex flex-col md:flex-row gap-4" dir={he ? "rtl" : "ltr"}>
      <IntegrationSidebar
        sidebar={sidebar}
        selectedId={selectedId}
        onSelect={setSelectedId}
        he={he}
        search={search}
        onSearch={setSearch}
      />

      <section className="min-w-0 flex-1">
        {loadingDetail && !detail && (
          <div className="py-16 flex justify-center">
            <div className="w-6 h-6 border-3 border-gray-200 border-t-primary-500 rounded-full animate-spin" />
          </div>
        )}

        {detail && (
          <>
            {/* Selected integration header */}
            <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm mb-3" data-testid="integration-header">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-gray-900">{detail.name}</h2>
                  <p className="mt-0.5 text-xs font-medium text-gray-600 tabular-nums" data-testid="header-tool-count">
                    {L(
                      `${detail.counts.enabled} of ${detail.counts.total} tools enabled`,
                      `${detail.counts.enabled} מתוך ${detail.counts.total} כלים מופעלים`,
                    )}
                  </p>
                  {/* Precise reasons, never collapsed into "not connected". */}
                  {detail.internal ? (
                    <p className="mt-1 text-[11px] text-gray-400">
                      {L("GOTCHA's own system actions. Always available.", "פעולות המערכת של GOTCHA. זמינות תמיד.")}
                    </p>
                  ) : (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <span className={clsx(
                        "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                        detail.connected ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700",
                      )}>
                        {detail.connected ? L("Connected", "מחובר") : L("Disconnected", "מנותק")}
                      </span>
                      {(detail.missingScopes?.length ?? 0) > 0 && (
                        <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700" data-testid="header-missing-scopes">
                          {L("Missing permissions: ", "חסרות הרשאות: ")}{detail.missingScopes!.join(", ")}
                        </span>
                      )}
                      {detail.capabilityFresh === false && (
                        <span className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                          {L("Permission check is stale", "בדיקת ההרשאות לא עדכנית")}
                        </span>
                      )}
                      {detail.counts.unavailable > 0 && (
                        <span className="rounded-md bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700">
                          {L(`${detail.counts.unavailable} unavailable`, `${detail.counts.unavailable} לא זמינים`)}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {(Object.keys(BULK_LABELS) as BulkAction[]).map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => requestBulk(a)}
                      data-testid={`bulk-${a}`}
                      className="rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50 transition"
                    >
                      {BULK_LABELS[a]}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setShowRaw((v) => !v)}
                    className="text-[11px] font-medium text-gray-400 hover:text-gray-600 ms-1"
                  >
                    {showRaw ? L("Hide ids", "הסתרת מזהים") : L("Show ids", "הצגת מזהים")}
                  </button>
                </div>
              </div>

              {bulkResult && (
                <p className="mt-2 rounded-lg bg-gray-50 px-2 py-1 text-[11px] text-gray-600" data-testid="bulk-result">
                  {bulkResult}
                </p>
              )}
              {saveError && (
                <p className="mt-2 rounded-lg bg-rose-50 px-2 py-1 text-[11px] text-rose-700" data-testid="save-error">
                  {saveError}
                </p>
              )}
            </div>

            {/* Tool groups */}
            {detail.groups.length === 0 ? (
              <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center" data-testid="no-tools">
                <p className="text-sm text-gray-500">
                  {L("This integration has no tools to govern.", "לאינטגרציה הזו אין כלים לניהול.")}
                </p>
              </div>
            ) : (
              detail.groups.map((group) => (
                <section key={group.riskGroup} className="mb-2">
                  <RiskGroupHeading group={group.riskGroup} count={group.tools.length} he={he} />
                  <div className="space-y-1.5">
                    {group.tools.map((t) => (
                      <ToolPermissionRow
                        key={t.name}
                        displayName={t.displayName}
                        rawName={t.name}
                        description={t.description}
                        requiredScopes={t.requiredScopes}
                        availability={t.availability}
                        he={he}
                        saving={saving?.tool === t.name}
                        showRawName={showRaw}
                        onChange={(next) => void applyPolicy(t, next)}
                      />
                    ))}
                  </div>
                </section>
              ))
            )}
          </>
        )}
      </section>

      <ConfirmModal
        isOpen={!!bulk}
        title={bulk ? BULK_LABELS[bulk.action] : ""}
        message={
          bulk
            ? bulk.count === 0
              ? L("Nothing would change.", "שום דבר לא ישתנה.")
              : L(
                  `This changes ${bulk.count} tool${bulk.count === 1 ? "" : "s"}. Tools that cannot support the chosen mode are left alone.`,
                  `הפעולה תשנה ${bulk.count} כלים. כלים שלא יכולים לתמוך במצב הנבחר יישארו כמו שהם.`,
                )
            : ""
        }
        confirmText={L("Apply", "החלה")}
        cancelText={L("Cancel", "ביטול")}
        onConfirm={() => { const a = bulk?.action; setBulk(null); if (a) void runBulk(a); }}
        onCancel={() => setBulk(null)}
      />
    </div>
  );
}

export default IntegrationWorkspace;
