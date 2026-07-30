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
  connectIntegration,
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
  type RiskGroup,
} from "@/lib/tool-availability-client";
import { initIntegrationOAuth } from "@/lib/api";
import { IntegrationSidebar } from "./IntegrationSidebar";
import { IntegrationHeader } from "./IntegrationHeader";
import { availabilityReasonText } from "./ToolAvailabilityReason";
import { ToolCategorySection } from "./ToolCategorySection";
import type { SelectableState } from "./ToolPermissionSegmentedControl";
import { riskLabel } from "../ai-studio/ToolPermissionRow";
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
  const [connectOpen, setConnectOpen] = useState(false);
  // Tool search is separate from integration search on purpose: they filter
  // different lists, and one box doing both is a box that does neither well.
  const [toolSearch, setToolSearch] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [groupApply, setGroupApply] = useState<{ group: RiskGroup; next: SelectableState; count: number } | null>(null);

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
      const res = await getIntegrationDetail(token, id, locale);
      setDetail(res.data);
    } catch (e: any) {
      setDetail(null);
      setSaveError(e?.message || L("Could not load this integration.", "לא ניתן לטעון את האינטגרציה."));
    } finally {
      setLoadingDetail(false);
    }
  }, [token, he, locale]);

  useEffect(() => { void loadSidebar(); }, [loadSidebar]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); }, [selectedId, loadDetail]);
  useEffect(() => { setToolSearch(""); }, [selectedId]);

  const allTools = useMemo(
    () => (detail?.groups ?? []).flatMap((g) => g.tools),
    [detail],
  );

  /** Search filters tools but keeps them inside their category. */
  const visibleGroups = useMemo(() => {
    const q = toolSearch.trim().toLowerCase();
    const groups = detail?.groups ?? [];
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        tools: g.tools.filter(
          (t) =>
            t.displayName.toLowerCase().includes(q) ||
            t.description.toLowerCase().includes(q) ||
            t.name.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.tools.length > 0);
  }, [detail, toolSearch]);

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

  /**
   * Apply one mode to a whole category.
   *
   * Skips unavailable tools and any tool whose risk group forbids the mode, so
   * a bulk action can never quietly loosen something the product does not allow
   * a single row to set.
   */
  function planGroupApply(group: RiskGroup, next: SelectableState) {
    const g = (detail?.groups ?? []).find((x) => x.riskGroup === group);
    if (!g) return [];
    return g.tools.filter((t) => {
      if (t.availability.state === "unavailable") return false;
      if (next === "always_allow" && !mayBeAlwaysAllowed(group)) return false;
      return t.availability.state !== next;
    });
  }

  function requestGroupApply(group: RiskGroup, next: SelectableState) {
    const affected = planGroupApply(group, next);
    if (affected.length === 0) {
      setBulkResult(L("Nothing to change.", "אין מה לשנות."));
      return;
    }
    setGroupApply({ group, next, count: affected.length });
  }

  async function runGroupApply(group: RiskGroup, next: SelectableState) {
    if (!token || !selectedId) return;
    const affected = planGroupApply(group, next);
    setBulkResult(null);
    let ok = 0;
    let failed = 0;
    for (const t of affected) {
      try { await setToolPolicy(token, t.name, next); ok += 1; } catch { failed += 1; }
    }
    await loadDetail(selectedId);
    await loadSidebar();
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

        {/* Not connected yet: there is no policy to show, so do not show an
            empty policy surface. Say what it does, what it would bring, and
            where to connect it. */}
        {detail?.connectable && (
          <div data-testid="integration-connect">
            <IntegrationHeader
              slug={detail.id}
              name={detail.name}
              category={detail.category}
              description={detail.description}
              logoUrl={detail.logoUrl}
              internal={false}
              connected={undefined}
              enabled={0}
              total={detail.catalogToolCount ?? 0}
              he={he}
            />
            <div className="rounded-xl border border-gray-200/80 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <p className="text-[12.5px] text-gray-600 dark:text-gray-300">
                {L(
                  "Not connected. Connect it to choose what its tools are allowed to do.",
                  "לא מחובר. חברו אותו כדי לקבוע מה הכלים שלו רשאים לעשות.",
                )}
              </p>
              {(detail.catalogToolCount ?? 0) > 0 && (
                <p className="mt-1 text-[11.5px] text-gray-400 tabular-nums">
                  {L(
                    `Adds ${detail.catalogToolCount} tools once connected.`,
                    `מוסיף ${detail.catalogToolCount} כלים אחרי החיבור.`,
                  )}
                </p>
              )}
              <button
                type="button"
                onClick={() => setConnectOpen(true)}
                data-testid="integration-connect-cta"
                className="mt-3 inline-flex items-center rounded-lg bg-primary-500 px-3 py-1.5 text-[12.5px] font-medium text-white transition hover:bg-primary-600"
              >
                {L("Connect", "חיבור")}
              </button>
            </div>
          </div>
        )}

        {detail && !detail.connectable && (
          <>
            <IntegrationHeader
              slug={detail.id}
              name={detail.name}
              category={detail.category}
              description={detail.description}
              logoUrl={detail.logoUrl}
              internal={detail.internal}
              connected={detail.connected}
              missingScopes={detail.missingScopes}
              capabilityFresh={detail.capabilityFresh}
              enabled={detail.counts.enabled}
              total={detail.counts.total}
              he={he}
            />

            {/* Tool search + the low-frequency actions, kept off the main axis.
                The four bulk chips used to sit above the fold and competed with
                the per-tool controls for attention; the per-category dropdown is
                now the primary bulk affordance. */}
            <div className="mb-3 flex items-center gap-2">
              <input
                value={toolSearch}
                onChange={(e) => setToolSearch(e.target.value)}
                placeholder={L("Search tools", "חיפוש כלים")}
                aria-label={L("Search tools", "חיפוש כלים")}
                data-testid="tool-search"
                className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] outline-none transition focus:border-primary-300 focus:ring-2 focus:ring-primary-100 dark:border-gray-700 dark:bg-gray-900"
              />
              <div className="relative shrink-0">
                <button
                  type="button"
                  data-testid="more-actions"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen((v) => !v)}
                  className="rounded-lg border border-gray-200 px-2 py-1.5 text-[12px] text-gray-500 transition hover:border-gray-300 hover:text-gray-700 dark:border-gray-700"
                >
                  ⋯
                </button>
                {moreOpen && (
                  <>
                    <div className="fixed inset-0 z-20" onClick={() => setMoreOpen(false)} />
                    <div role="menu" className="absolute end-0 z-30 mt-1 w-52 rounded-xl border border-gray-100 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
                      {(Object.keys(BULK_LABELS) as BulkAction[]).map((a) => (
                        <button
                          key={a}
                          type="button"
                          role="menuitem"
                          data-testid={`bulk-${a}`}
                          onClick={() => { setMoreOpen(false); requestBulk(a); }}
                          className="block w-full px-3 py-1.5 text-start text-[11.5px] text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800"
                        >
                          {BULK_LABELS[a]}
                        </button>
                      ))}
                      <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => { setMoreOpen(false); setShowRaw((v) => !v); }}
                        className="block w-full px-3 py-1.5 text-start text-[11.5px] text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800"
                      >
                        {showRaw ? L("Hide ids", "הסתרת מזהים") : L("Show ids", "הצגת מזהים")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            {bulkResult && (
              <p className="mb-2 rounded-lg bg-gray-50 px-2 py-1 text-[11.5px] text-gray-600" data-testid="bulk-result">{bulkResult}</p>
            )}
            {saveError && (
              <p className="mb-2 rounded-lg bg-rose-50 px-2 py-1 text-[11.5px] text-rose-700" data-testid="save-error">{saveError}</p>
            )}

            {visibleGroups.length === 0 ? (
              <div className="rounded-xl border border-gray-200/80 bg-white p-8 text-center dark:border-gray-700 dark:bg-gray-900" data-testid="no-tools">
                <p className="text-[12.5px] text-gray-500">
                  {toolSearch.trim()
                    ? L("No tools match that.", "אין כלים תואמים.")
                    : L("This integration has no tools to govern.", "לאינטגרציה הזו אין כלים לניהול.")}
                </p>
              </div>
            ) : (
              visibleGroups.map(({ riskGroup, tools }) => (
                <ToolCategorySection
                  key={riskGroup}
                  group={riskGroup}
                  title={riskLabel(riskGroup, he)}
                  he={he}
                  showRawName={showRaw}
                  // Read-only opens by default; a big write group starts closed
                  // so the page does not open 62 rows deep.
                  defaultOpen={riskGroup === "read_only" || tools.length <= 12}
                  tools={tools.map((t) => ({
                    name: t.name,
                    displayName: t.displayName,
                    description: t.description,
                    state: t.availability.state,
                    unavailable: t.availability.state === "unavailable",
                    unavailableReason: availabilityReasonText(t.availability, he) ?? undefined,
                    lockedStates: mayBeAlwaysAllowed(t.riskGroup)
                      ? undefined
                      : { always_allow: L("This group cannot run without approval", "הקבוצה הזו לא יכולה לרוץ ללא אישור") },
                    saving: saving?.tool === t.name,
                  }))}
                  onChangeTool={(row, next) => {
                    const orig = tools.find((x) => x.name === row.name);
                    if (orig) void applyPolicy(orig, next);
                  }}
                  onApplyGroup={(next) => requestGroupApply(riskGroup, next)}
                />
              ))
            )}
          </>
        )}
      </section>

      {connectOpen && detail?.connectable && (
        <ConnectDialog
          detail={detail}
          he={he}
          onCancel={() => setConnectOpen(false)}
          onConnected={async () => {
            setConnectOpen(false);
            // Re-read rather than assume: the integration is only "connected"
            // once the server says so, and its tools appear from that read.
            await loadSidebar();
            if (selectedId) await loadDetail(selectedId);
          }}
        />
      )}

      <ConfirmModal
        isOpen={!!groupApply}
        title={groupApply ? riskLabel(groupApply.group, he) : ""}
        message={
          groupApply
            ? L(
                `This changes ${groupApply.count} tool${groupApply.count === 1 ? "" : "s"} in this group. Tools that cannot take the chosen mode are left alone.`,
                `הפעולה תשנה ${groupApply.count} כלים בקבוצה. כלים שלא יכולים לקבל את המצב הנבחר יישארו כמו שהם.`,
              )
            : ""
        }
        confirmText={L("Apply", "החלה")}
        cancelText={L("Cancel", "ביטול")}
        onConfirm={() => { const g = groupApply; setGroupApply(null); if (g) void runGroupApply(g.group, g.next); }}
        onCancel={() => setGroupApply(null)}
      />

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


/**
 * Start the REAL connection flow without leaving the workspace (spec §3).
 *
 * Two shapes, both existing endpoints - no second OAuth implementation:
 *
 *   OAuth providers      collect any pre-flight field the catalog declares
 *                        (Shopify needs the shop domain), then hand off to
 *                        /oauth/init, which is the only place that knows how
 *                        to build the provider consent URL.
 *   Credential providers render the catalog's declared fields and POST them to
 *                        the same /connect endpoint the marketplace uses.
 *
 * The field list comes from the catalog, never from a hardcoded per-provider
 * form here - that is what let this screen support every provider at once.
 */
function ConnectDialog({
  detail, he, onCancel, onConnected,
}: {
  detail: IntegrationDetail;
  he: boolean;
  onCancel: () => void;
  onConnected: () => void | Promise<void>;
}) {
  const { token } = useAuth();
  const L = (en: string, hebrew: string) => (he ? hebrew : en);
  const fields = detail.authSchema?.fields ?? [];
  const isOAuth = detail.authSchema?.oauth === true || detail.authType === "OAUTH2";
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const missing = fields.filter((f) => f.required && !String(values[f.key] ?? "").trim());

  async function submit() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      if (isOAuth) {
        // The pre-flight fields are query params for init (e.g. shop=...).
        const { url } = await initIntegrationOAuth(token, detail.id, values);
        if (!url) throw new Error(L("Could not start the connection.", "לא ניתן להתחיל את החיבור."));
        // Remember where to come back to, so the callback lands on this screen.
        try { sessionStorage.setItem("integrationReturnTo", "/ai-studio?tab=tools"); } catch { /* private mode */ }
        window.location.href = url;
        return;
      }
      await connectIntegration(token, detail.id, values);
      await onConnected();
    } catch (e: any) {
      // The provider's own reason, kept intact. "Invalid API key" and "this
      // store is on another plan" are different problems for the reader.
      setError(e?.message || L("That did not connect.", "החיבור לא הצליח."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-title"
        data-testid="connect-dialog"
        className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        dir={he ? "rtl" : "ltr"}
      >
        <h3 id="connect-title" className="text-sm font-semibold text-gray-900">
          {L(`Connect ${detail.name}`, `חיבור ${detail.name}`)}
        </h3>

        {isOAuth && (
          <p className="mt-1 text-[11px] text-gray-500" data-testid="connect-oauth-note">
            {L(
              "You will be sent to the provider to approve access, then brought back here.",
              "תועברו לספק לאישור הגישה ותחזרו לכאן.",
            )}
          </p>
        )}

        <div className="mt-3 space-y-2.5">
          {fields.map((f) => (
            <div key={f.key}>
              <label htmlFor={`cf-${f.key}`} className="block text-[11px] font-medium text-gray-600 mb-1">
                {f.label}{f.required && <span className="text-rose-500"> *</span>}
              </label>
              <input
                id={`cf-${f.key}`}
                data-testid={`connect-field-${f.key}`}
                type={f.type === "password" ? "password" : "text"}
                value={values[f.key] ?? ""}
                placeholder={f.placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                dir="ltr"
                className="w-full px-2.5 py-1.5 rounded-lg border border-gray-200 text-xs outline-none focus:border-primary-300 focus:ring-2 focus:ring-primary-100"
              />
              {f.helpText && <p className="mt-1 text-[10px] text-gray-400">{f.helpText}</p>}
            </div>
          ))}
        </div>

        {(detail.authSchema?.scopes?.length ?? 0) > 0 && (
          <p className="mt-3 text-[10px] text-gray-400" data-testid="connect-scopes">
            {L("Requests: ", "מבקש: ")}{detail.authSchema!.scopes!.join(", ")}
          </p>
        )}

        {error && (
          <p className="mt-3 rounded-lg bg-rose-50 px-2 py-1 text-[11px] text-rose-700" data-testid="connect-error">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-lg text-gray-600 hover:bg-gray-100">
            {L("Cancel", "ביטול")}
          </button>
          <button
            data-testid="connect-submit"
            disabled={busy || missing.length > 0}
            onClick={() => void submit()}
            className="text-xs px-3 py-1.5 rounded-lg bg-primary-500 hover:bg-primary-600 text-white disabled:opacity-40"
          >
            {busy ? L("Connecting…", "מתחבר…") : L("Connect", "חיבור")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default IntegrationWorkspace;
