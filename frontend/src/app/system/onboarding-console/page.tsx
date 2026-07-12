"use client";

// System Admin — Onboarding Console. One row per tenant: every milestone,
// derived progress, health, and the Next Recommended Action. Operational
// visibility ("who is stuck, where, what's done, what's left") + per-row
// Reset Onboarding and Send Nudge.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "@/context/AuthContext";
import { SystemLayout } from "@/components/SystemLayout";
import { getOnboardingConsole, resetTenantOnboarding, sendTenantNudge, type OnboardingConsoleRow } from "@/lib/api";

type SortKey = "company" | "createdAt" | "progressPct" | "lastActivity" | "health";
const HEALTH_ORDER: Record<string, number> = { stuck: 0, at_risk: 1, on_track: 2, activated: 3 };

export default function OnboardingConsolePage() {
  const { token } = useAuth();
  const [rows, setRows] = useState<OnboardingConsoleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [healthFilter, setHealthFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);

  const flash = (text: string, kind: "ok" | "err" = "ok") => { setMsg({ text, kind }); setTimeout(() => setMsg(null), 4000); };

  const fetchRows = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getOnboardingConsole(token);
      setRows(res.data.rows || []);
    } catch (e) {
      console.error("console load failed", e);
      flash("Failed to load console", "err");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  const view = useMemo(() => {
    let r = rows;
    const q = search.trim().toLowerCase();
    if (q) r = r.filter((x) => x.company.toLowerCase().includes(q) || x.slug.toLowerCase().includes(q) || x.nextRecommendedAction.toLowerCase().includes(q));
    if (healthFilter !== "all") r = r.filter((x) => x.health === healthFilter);
    const dir = sortDir === "asc" ? 1 : -1;
    return [...r].sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortKey) {
        case "company": av = a.company.toLowerCase(); bv = b.company.toLowerCase(); break;
        case "progressPct": av = a.progressPct; bv = b.progressPct; break;
        case "health": av = HEALTH_ORDER[a.health] ?? 9; bv = HEALTH_ORDER[b.health] ?? 9; break;
        case "lastActivity": av = new Date(a.lastActivity).getTime(); bv = new Date(b.lastActivity).getTime(); break;
        default: av = new Date(a.createdAt).getTime(); bv = new Date(b.createdAt).getTime();
      }
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }, [rows, search, healthFilter, sortKey, sortDir]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "company" ? "asc" : "desc"); }
  }

  async function doNudge(tenantId: string) {
    if (!token) return;
    setBusy(tenantId);
    try {
      const res = await sendTenantNudge(token, tenantId);
      const o = res.data;
      flash(o.outcome === "sent" ? `Nudge sent (${o.reason})` : `Nudge ${o.outcome}${o.reason ? ` — ${o.reason}` : ""}`, o.outcome === "sent" ? "ok" : "err");
      fetchRows();
    } catch (e: any) { flash(e?.message || "Nudge failed", "err"); }
    finally { setBusy(null); }
  }

  async function doReset(row: OnboardingConsoleRow) {
    if (!token) return;
    if (!window.confirm(`Reset onboarding for "${row.company}"?\n\nThis removes its discovery, business profile, goal, AI employee, departments and onboarding progress, and returns it to a brand-new state. Users and connected systems are preserved.`)) return;
    setBusy(row.tenantId);
    try {
      const res = await resetTenantOnboarding(token, row.tenantId);
      const removed = res.data.removed || {};
      const n = Object.values(removed).reduce((a, b) => a + (b as number), 0);
      flash(`Reset "${row.company}" — ${n} artifacts removed`, "ok");
      fetchRows();
    } catch (e: any) { flash(e?.message || "Reset failed", "err"); }
    finally { setBusy(null); }
  }

  const counts = useMemo(() => ({
    total: rows.length,
    stuck: rows.filter((r) => r.health === "stuck").length,
    atRisk: rows.filter((r) => r.health === "at_risk").length,
    activated: rows.filter((r) => r.health === "activated").length,
  }), [rows]);

  return (
    <SystemLayout>
      <div className="p-6 space-y-5">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Onboarding Console</h1>
            <p className="text-sm text-gray-500 mt-1">Every tenant's onboarding progress — who's stuck, where, and what's next.</p>
          </div>
          <div className="flex gap-2 text-xs">
            <Stat label="Tenants" value={counts.total} />
            <Stat label="Stuck" value={counts.stuck} tone="err" />
            <Stat label="At risk" value={counts.atRisk} tone="warn" />
            <Stat label="Activated" value={counts.activated} tone="ok" />
          </div>
        </div>

        {msg && <div className={"p-3 rounded-xl text-sm " + (msg.kind === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600")}>{msg.text}</div>}

        <div className="flex items-center gap-3 flex-wrap">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search company, slug, or next action…"
            className="flex-1 min-w-[220px] px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-primary-200" />
          <div className="flex gap-1">
            {["all", "stuck", "at_risk", "on_track", "activated"].map((h) => (
              <button key={h} onClick={() => setHealthFilter(h)}
                className={"px-3 py-1.5 rounded-lg text-xs font-medium transition " + (healthFilter === h ? "bg-gray-900 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50")}>
                {h === "all" ? "All" : h.replace("_", " ")}
              </button>
            ))}
          </div>
          <button onClick={fetchRows} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-gray-200 text-gray-600 hover:bg-gray-50">Refresh</button>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm min-w-[1500px]">
            <thead>
              <tr className="text-left text-xs text-gray-400 uppercase tracking-wide border-b border-gray-100">
                <Th onClick={() => toggleSort("company")} active={sortKey === "company"} dir={sortDir}>Company</Th>
                <Th onClick={() => toggleSort("createdAt")} active={sortKey === "createdAt"} dir={sortDir}>Created</Th>
                <th className="px-3 py-2.5">Stage</th>
                <th className="px-2 py-2.5 text-center">Disc.</th>
                <th className="px-2 py-2.5 text-center">Review</th>
                <th className="px-2 py-2.5 text-center">Goal</th>
                <th className="px-2 py-2.5 text-center">CRM</th>
                <th className="px-2 py-2.5 text-center">Chan.</th>
                <th className="px-2 py-2.5 text-center">Integr.</th>
                <th className="px-2 py-2.5 text-center">Know.</th>
                <th className="px-2 py-2.5 text-center">Employee</th>
                <Th onClick={() => toggleSort("lastActivity")} active={sortKey === "lastActivity"} dir={sortDir}>Last activity</Th>
                <th className="px-3 py-2.5">Last nudge</th>
                <Th onClick={() => toggleSort("progressPct")} active={sortKey === "progressPct"} dir={sortDir}>Progress</Th>
                <Th onClick={() => toggleSort("health")} active={sortKey === "health"} dir={sortDir}>Health</Th>
                <th className="px-3 py-2.5">Next action</th>
                <th className="px-3 py-2.5">CSM</th>
                <th className="px-3 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={18} className="px-3 py-10 text-center text-gray-400">Loading…</td></tr>
              ) : view.length === 0 ? (
                <tr><td colSpan={18} className="px-3 py-10 text-center text-gray-400">No tenants match.</td></tr>
              ) : view.map((r) => (
                <tr key={r.tenantId} className="border-b border-gray-50 hover:bg-gray-50/60">
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-gray-900">{r.company}</div>
                    <div className="text-[11px] text-gray-400">{r.slug}</div>
                  </td>
                  <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{rel(r.createdAt)}</td>
                  <td className="px-3 py-2.5"><span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 capitalize">{r.currentStage.replace("_", " ")}</span></td>
                  <td className="px-2 py-2.5 text-center"><Check ok={r.discoveryComplete} /></td>
                  <td className="px-2 py-2.5 text-center"><Check ok={r.reviewComplete} /></td>
                  <td className="px-2 py-2.5 text-center"><Check ok={r.goalSelected} /></td>
                  <td className="px-2 py-2.5 text-center">{r.crmConnected ? <span className="text-[11px] text-emerald-600" title={r.crmSlug || ""}>✓ {r.crmSlug}</span> : <Check ok={false} />}</td>
                  <td className="px-2 py-2.5 text-center text-gray-600">{r.channelsConnected || <span className="text-gray-300">0</span>}</td>
                  <td className="px-2 py-2.5 text-center text-gray-600">{r.integrationsConnected || <span className="text-gray-300">0</span>}</td>
                  <td className="px-2 py-2.5 text-center text-[11px] text-gray-500 capitalize">{r.knowledgeStatus}</td>
                  <td className="px-2 py-2.5 text-center">{r.aiEmployeeCreated ? <span className="text-[11px] text-emerald-600" title={r.aiEmployeeName || ""}>✓</span> : <Check ok={false} />}</td>
                  <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{rel(r.lastActivity)}</td>
                  <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{r.lastNudgeSentAt ? rel(r.lastNudgeSentAt) : <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2.5"><Progress pct={r.progressPct} /></td>
                  <td className="px-3 py-2.5"><Health h={r.health} /></td>
                  <td className="px-3 py-2.5"><span className="text-xs font-medium text-gray-700">{r.nextRecommendedAction}</span></td>
                  <td className="px-3 py-2.5 text-gray-400 text-xs">{r.assignedCsm || "—"}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1.5">
                      <button disabled={busy === r.tenantId} onClick={() => doNudge(r.tenantId)}
                        className="px-2.5 py-1 rounded-lg text-xs font-medium bg-primary-50 text-primary-600 hover:bg-primary-100 disabled:opacity-50">Nudge</button>
                      <button disabled={busy === r.tenantId} onClick={() => doReset(r)}
                        className="px-2.5 py-1 rounded-lg text-xs font-medium bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-50">Reset</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </SystemLayout>
  );
}

function Th({ children, onClick, active, dir }: { children: ReactNode; onClick: () => void; active: boolean; dir: "asc" | "desc" }) {
  return (
    <th className="px-3 py-2.5 cursor-pointer select-none hover:text-gray-600" onClick={onClick}>
      <span className="inline-flex items-center gap-1">{children}{active && <span>{dir === "asc" ? "▲" : "▼"}</span>}</span>
    </th>
  );
}

function Check({ ok }: { ok: boolean }) {
  return ok ? <span className="text-emerald-500 font-bold">✓</span> : <span className="text-gray-300">·</span>;
}

function Progress({ pct }: { pct: number }) {
  const color = pct >= 100 ? "bg-emerald-500" : pct >= 50 ? "bg-primary-500" : "bg-amber-400";
  return (
    <div className="flex items-center gap-2 min-w-[90px]">
      <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden"><div className={"h-full rounded-full " + color} style={{ width: `${pct}%` }} /></div>
      <span className="text-[11px] text-gray-500 w-8 text-right">{pct}%</span>
    </div>
  );
}

function Health({ h }: { h: string }) {
  const map: Record<string, string> = {
    activated: "bg-emerald-50 text-emerald-600",
    on_track: "bg-sky-50 text-sky-600",
    at_risk: "bg-amber-50 text-amber-600",
    stuck: "bg-red-50 text-red-600",
  };
  return <span className={"text-[11px] px-2 py-0.5 rounded-full font-medium capitalize " + (map[h] || "bg-gray-100 text-gray-500")}>{h.replace("_", " ")}</span>;
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" | "err" }) {
  const c = tone === "err" ? "text-red-600" : tone === "warn" ? "text-amber-600" : tone === "ok" ? "text-emerald-600" : "text-gray-900";
  return <div className="px-3 py-1.5 rounded-xl bg-white border border-gray-200"><span className={"font-bold " + c}>{value}</span> <span className="text-gray-400">{label}</span></div>;
}

function rel(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
