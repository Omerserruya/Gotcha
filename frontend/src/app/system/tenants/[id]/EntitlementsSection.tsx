"use client";

/**
 * Entitlements, credits & POC — the special-tenant admin surface.
 *
 * Feature LICENSING (what this tenant's contract allows) — distinct from the
 * raw feature flags: toggling a domain here writes a TenantEntitlement
 * OVERRIDE, which materializes into the permission resolver, so the tenant's
 * workspace UI hides/shows that area within ~30s (permission cache TTL).
 *
 * POC provisioning creates a REAL enforced subscription with no card: the
 * operator sets the credit budget (drives the 80/100% alerts + hard block at
 * zero) plus the feature set and an optional expiry.
 */
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import {
  getSystemTenantEntitlements,
  updateSystemTenantEntitlement,
  setupSystemTenantPoc,
  grantSystemTenantCredits,
  type LicenseDomainRow,
  type TenantBillingSummary,
} from "@/lib/api";

interface Props {
  tenantId: string;
  onMessage: (msg: string, type?: "success" | "error") => void;
}

const DOMAIN_LABEL: Record<string, string> = {
  conversation: "Conversations & inbox",
  customer: "Customers",
  crm: "CRM",
  ai: "AI employees & studio",
  approvals: "Approvals",
  integrations: "Integrations",
  channels: "Channels",
  analytics: "Analytics & dashboard",
  settings: "Settings",
};

function fmtUnits(n: number | undefined | null): string {
  if (n == null) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function EntitlementsSection({ tenantId, onMessage }: Props) {
  const { token } = useAuth();
  const [domains, setDomains] = useState<LicenseDomainRow[] | null>(null);
  const [billing, setBilling] = useState<TenantBillingSummary | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  // Credit top-up
  const [topupUnits, setTopupUnits] = useState("");
  const [topupBusy, setTopupBusy] = useState(false);

  // POC form
  const [pocOpen, setPocOpen] = useState(false);
  const [pocCredits, setPocCredits] = useState("500");
  const [pocExpiry, setPocExpiry] = useState("");
  const [pocFeatures, setPocFeatures] = useState<Set<string>>(new Set());
  const [pocBusy, setPocBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getSystemTenantEntitlements(token, tenantId);
      setDomains(res.data.domains);
      setBilling(res.data.billing);
      setPocFeatures(new Set(res.data.domains.filter((d) => d.enabled).map((d) => d.key)));
    } catch {
      onMessage("Failed to load entitlements", "error");
    }
  }, [token, tenantId, onMessage]);

  useEffect(() => { load(); }, [load]);

  async function toggleDomain(row: LicenseDomainRow) {
    if (!token) return;
    setPendingKey(row.key);
    try {
      await updateSystemTenantEntitlement(token, tenantId, row.key, !row.enabled);
      setDomains((prev) => (prev || []).map((d) => (d.key === row.key ? { ...d, enabled: !row.enabled, source: "OVERRIDE" } : d)));
      onMessage(`${DOMAIN_LABEL[row.key] || row.key} ${row.enabled ? "disabled" : "enabled"} — workspace UI updates within ~30s`);
    } catch (e: any) {
      onMessage(e?.message || "Failed to update entitlement", "error");
    } finally {
      setPendingKey(null);
    }
  }

  async function topup() {
    const units = Number(topupUnits);
    if (!token || !Number.isFinite(units) || units <= 0) return;
    setTopupBusy(true);
    try {
      const res = await grantSystemTenantCredits(token, tenantId, units);
      setBilling((b) => (b ? { ...b, balance: res.data.balance ?? b.balance } : b));
      setTopupUnits("");
      onMessage(`Granted ${fmtUnits(units)} credits`);
    } catch (e: any) {
      onMessage(e?.message || "Credit grant failed", "error");
    } finally {
      setTopupBusy(false);
    }
  }

  async function provisionPoc() {
    const credits = Number(pocCredits);
    if (!token || !Number.isFinite(credits) || credits <= 0) { onMessage("Set a positive credit budget", "error"); return; }
    setPocBusy(true);
    try {
      await setupSystemTenantPoc(token, tenantId, {
        credits,
        expiresAt: pocExpiry ? new Date(`${pocExpiry}T23:59:59`).toISOString() : undefined,
        features: Array.from(pocFeatures),
      });
      onMessage(`POC provisioned: ${fmtUnits(credits)} credits${pocExpiry ? `, expires ${pocExpiry}` : ""}, ${pocFeatures.size} feature areas`);
      setPocOpen(false);
      await load();
    } catch (e: any) {
      onMessage(e?.message || "POC setup failed", "error");
    } finally {
      setPocBusy(false);
    }
  }

  const bal = billing?.balance;
  const sub = billing?.subscription;
  const allowance = Number(bal?.includedAllowance ?? 0);
  const total = Number(bal?.total ?? 0);
  const consumedPct = allowance > 0 ? Math.min(100, Math.max(0, Math.round((1 - total / allowance) * 100))) : null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-gray-900">Entitlements & credits</h2>
          <p className="text-xs text-gray-500 mt-0.5">Licensed feature areas (hide/show in the tenant workspace) · AI credit wallet · POC provisioning.</p>
        </div>
        <button
          onClick={() => setPocOpen((v) => !v)}
          className={clsx("text-xs font-semibold px-3 py-1.5 rounded-lg border transition", pocOpen ? "border-primary-300 bg-primary-50 text-primary-700" : "border-gray-200 text-gray-600 hover:border-primary-300")}
        >
          {pocOpen ? "Close POC setup" : "Set up as POC"}
        </button>
      </div>

      {/* Billing snapshot */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="rounded-lg bg-gray-50 border border-gray-100 p-3">
          <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Plan / status</p>
          <p className="text-sm font-semibold text-gray-800 mt-1">{sub ? `${sub.planKey} · ${sub.status}` : "no subscription"}</p>
          {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub.enforcementEnabled ? "credits enforced" : "enforcement off"}{sub.currentPeriodEnd ? ` · until ${String(sub.currentPeriodEnd).slice(0, 10)}` : ""}</p>}
        </div>
        <div className="rounded-lg bg-gray-50 border border-gray-100 p-3">
          <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Balance</p>
          <p className="text-sm font-semibold text-gray-800 mt-1">{fmtUnits(total)} units</p>
          <p className="text-[10px] text-gray-400 mt-0.5">incl {fmtUnits(bal?.includedRemaining)} · purchased {fmtUnits(bal?.purchasedRemaining)}</p>
        </div>
        <div className="rounded-lg bg-gray-50 border border-gray-100 p-3">
          <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Budget used</p>
          <p className={clsx("text-sm font-semibold mt-1", consumedPct == null ? "text-gray-400" : consumedPct >= 100 ? "text-red-600" : consumedPct >= 80 ? "text-amber-600" : "text-gray-800")}>
            {consumedPct == null ? "—" : `${consumedPct}%`}
          </p>
          <p className="text-[10px] text-gray-400 mt-0.5">of {fmtUnits(allowance)} allowance</p>
        </div>
        <div className="rounded-lg bg-gray-50 border border-gray-100 p-3">
          <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Grant credits</p>
          <div className="flex gap-1 mt-1">
            <input value={topupUnits} onChange={(e) => setTopupUnits(e.target.value)} placeholder="500" inputMode="numeric"
              className="w-full min-w-0 px-2 py-1 text-sm bg-white border border-gray-200 rounded-md outline-none focus:ring-1 focus:ring-primary-300" />
            <button onClick={topup} disabled={topupBusy || !Number(topupUnits)} className="text-xs font-semibold px-2.5 rounded-md bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-40">
              {topupBusy ? "…" : "+"}
            </button>
          </div>
        </div>
      </div>
      {billing?.error && <p className="text-xs text-amber-600">Billing service: {billing.error}</p>}

      {/* POC form */}
      {pocOpen && (
        <div className="rounded-xl border border-primary-200 bg-primary-50/40 p-4 space-y-3">
          <p className="text-sm font-semibold text-gray-800">POC / pilot — free, no card, credits enforced</p>
          <div className="grid md:grid-cols-2 gap-3">
            <label className="block text-xs text-gray-600">
              Credit budget (AI units)
              <input value={pocCredits} onChange={(e) => setPocCredits(e.target.value)} inputMode="numeric"
                className="mt-1 w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-primary-300" />
            </label>
            <label className="block text-xs text-gray-600">
              Expires (optional — access revokes after)
              <input type="date" value={pocExpiry} onChange={(e) => setPocExpiry(e.target.value)}
                className="mt-1 w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-primary-300" />
            </label>
          </div>
          <div>
            <p className="text-xs text-gray-600 mb-1.5">Feature areas included</p>
            <div className="flex flex-wrap gap-1.5">
              {(domains || []).map((d) => {
                const on = pocFeatures.has(d.key);
                return (
                  <button key={d.key} onClick={() => setPocFeatures((prev) => { const n = new Set(prev); if (n.has(d.key)) n.delete(d.key); else n.add(d.key); return n; })}
                    className={clsx("text-xs px-2.5 py-1 rounded-full border transition", on ? "bg-primary-500 border-primary-500 text-white" : "bg-white border-gray-200 text-gray-500 hover:border-primary-300")}>
                    {DOMAIN_LABEL[d.key] || d.key}
                  </button>
                );
              })}
            </div>
          </div>
          <button onClick={provisionPoc} disabled={pocBusy}
            className="px-4 py-2 text-sm font-semibold rounded-lg bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50">
            {pocBusy ? "Provisioning…" : "Provision POC"}
          </button>
          <p className="text-[11px] text-gray-500">Creates an enforced subscription (no charges, no dunning). At 80% budget the owner is alerted; at 100% AI pauses. On expiry the POC is canceled and its features lock.</p>
        </div>
      )}

      {/* Licensed feature domains */}
      {domains === null ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : (
        <div className="grid md:grid-cols-3 gap-2">
          {domains.map((d) => (
            <div key={d.key} className="flex items-center justify-between gap-2 rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{DOMAIN_LABEL[d.key] || d.key}</p>
                <p className="text-[10px] text-gray-400">
                  {d.source ? `${d.source.toLowerCase()}${d.expiresAt ? ` · until ${String(d.expiresAt).slice(0, 10)}` : ""}` : "default (allowed)"}
                </p>
              </div>
              <button onClick={() => toggleDomain(d)} disabled={pendingKey === d.key} aria-pressed={d.enabled}
                className={clsx("relative w-9 h-5 rounded-full transition shrink-0", d.enabled ? "bg-primary-500" : "bg-gray-300", pendingKey === d.key && "opacity-50")}>
                <span className={clsx("absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all", d.enabled ? "left-[18px]" : "left-0.5")} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
