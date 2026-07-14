"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import {
  getSubscription,
  getPlans,
  changePlan,
  cancelSubscription,
  resumeSubscription,
  migratePlan,
  getBalance,
  getPackages,
  buyCredits,
  getAutoPurchase,
  setAutoPurchase,
  getPaymentMethods,
  addPaymentMethod,
  removePaymentMethod,
  getInvoices,
  type Subscription,
  type Plan,
  type Balance,
  type CreditPackage,
  type AutoPurchasePolicy,
  type PaymentMethod,
  type Invoice,
} from "@/lib/api-billing";

const STATUS_STYLES: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  TRIALING: "bg-blue-100 text-blue-800",
  PAST_DUE: "bg-amber-100 text-amber-800",
  SUSPENDED: "bg-red-100 text-red-800",
  CANCELED: "bg-gray-200 text-gray-700",
  GRANDFATHERED: "bg-purple-100 text-purple-800",
  PENDING: "bg-gray-100 text-gray-600",
  PAUSED: "bg-gray-100 text-gray-600",
};

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

export default function BillingSettingsPage() {
  const { token } = useAuth();
  const [sub, setSub] = useState<Subscription | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [packages, setPackages] = useState<CreditPackage[]>([]);
  const [policy, setPolicy] = useState<AutoPurchasePolicy | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [s, p, b, pk, ap, pm, inv] = await Promise.all([
        getSubscription(token),
        getPlans(token),
        getBalance(token).catch(() => null),
        getPackages(token),
        getAutoPurchase(token).catch(() => ({ policy: null })),
        getPaymentMethods(token).catch(() => ({ paymentMethods: [] })),
        getInvoices(token).catch(() => ({ invoices: [] })),
      ]);
      setSub(s.subscription);
      setPlans(p.plans);
      setBalance(b);
      setPackages(pk.packages);
      setPolicy(ap.policy);
      setMethods(pm.paymentMethods);
      setInvoices(inv.invoices);
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? "Failed to load billing" });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    reload();
  }, [reload]);

  const run = async (key: string, fn: () => Promise<unknown>, okText: string) => {
    if (!token) return;
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: "ok", text: okText });
      await reload();
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? "Action failed" });
    } finally {
      setBusy(null);
    }
  };

  // iCount PayPage: in production this opens the hosted page and returns a token.
  // Dev/mock accepts a token directly so the flow is testable end-to-end.
  const addCard = async () => {
    const paypageUrl = process.env.NEXT_PUBLIC_ICOUNT_PAYPAGE_URL;
    if (paypageUrl) {
      window.open(paypageUrl, "icount-paypage", "width=480,height=640");
      // A production integration listens for the page's postMessage with the token.
      return;
    }
    const pageToken = window.prompt("Enter PayPage token (dev/mock):", "pt_dev");
    if (!pageToken) return;
    await run("add-card", () => addPaymentMethod(token!, pageToken), "Payment method saved");
  };

  if (loading) return <div className="p-8 text-gray-500">Loading billing…</div>;

  const isGrandfathered = sub?.planKey === "grandfathered" || sub?.status === "GRANDFATHERED";
  const currency = (balance && "ILS") || "ILS";
  const fmt = (n: number) => Math.round(n).toLocaleString();

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Billing &amp; Subscription</h1>
      </div>

      {msg && (
        <div className={`rounded-md px-4 py-2 text-sm ${msg.kind === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
          {msg.text}
        </div>
      )}

      {/* ── Subscription ── */}
      <Section
        title="Current subscription"
        action={sub && <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_STYLES[sub.status] ?? "bg-gray-100"}`}>{sub.status}</span>}
      >
        {!sub ? (
          <p className="text-gray-500">No subscription yet.</p>
        ) : (
          <div className="space-y-2 text-sm text-gray-700">
            <div>Plan: <span className="font-medium">{plans.find((p) => p.key === sub.planKey)?.name ?? sub.planKey}</span></div>
            {sub.trialEndsAt && <div>Trial ends: {new Date(sub.trialEndsAt).toLocaleDateString()}</div>}
            {sub.currentPeriodEnd && <div>Renews: {new Date(sub.currentPeriodEnd).toLocaleDateString()}</div>}
            {sub.cancelAtPeriodEnd && <div className="text-amber-700">Cancels at period end.</div>}
            {isGrandfathered && <div className="text-purple-700">Legacy plan - choose a paid plan below to migrate (one-way).</div>}
            <div className="pt-2">
              {sub.cancelAtPeriodEnd ? (
                <button disabled={busy !== null} onClick={() => run("resume", () => resumeSubscription(token!), "Subscription resumed")}
                  className="rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
                  Resume subscription
                </button>
              ) : (
                !isGrandfathered && sub.status !== "CANCELED" && (
                  <button disabled={busy !== null} onClick={() => { if (confirm("Cancel at the end of the current period?")) run("cancel", () => cancelSubscription(token!), "Cancellation scheduled"); }}
                    className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">
                    Cancel subscription
                  </button>
                )
              )}
            </div>
          </div>
        )}
      </Section>

      {/* ── AI Units balance ── */}
      <Section title="AI Units">
        {!balance ? (
          <p className="text-gray-500">No balance data.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-md bg-blue-50 p-4">
              <div className="text-xs uppercase text-blue-700">Included this month</div>
              <div className="text-2xl font-bold text-blue-900">{fmt(balance.includedRemaining)}</div>
              <div className="text-xs text-blue-700">of {fmt(balance.includedAllowance)} · resets at renewal</div>
            </div>
            <div className="rounded-md bg-emerald-50 p-4">
              <div className="text-xs uppercase text-emerald-700">Purchased (never expires)</div>
              <div className="text-2xl font-bold text-emerald-900">{fmt(balance.purchasedRemaining)}</div>
              <div className="text-xs text-emerald-700">used after monthly units</div>
            </div>
          </div>
        )}
      </Section>

      {/* ── Plans ── */}
      <Section title="Plans">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {plans.filter((p) => p.key !== "grandfathered").map((p) => {
            const current = sub?.planKey === p.key;
            return (
              <div key={p.id} className={`rounded-lg border p-4 ${current ? "border-blue-500 ring-1 ring-blue-500" : "border-gray-200"}`}>
                <div className="font-semibold text-gray-900">{p.name}</div>
                <div className="mt-1 text-2xl font-bold text-gray-900">{p.salesOnly ? "Custom" : `₪${p.basePrice ?? "-"}`}</div>
                <div className="text-xs text-gray-500">{p.salesOnly ? "Contact sales" : "/ month"}</div>
                <div className="mt-2 text-sm text-gray-600">{fmt(p.includedAiUnits)} AI Units / mo</div>
                <div className="mt-3">
                  {current ? (
                    <span className="text-xs font-medium text-blue-600">Current plan</span>
                  ) : p.salesOnly ? (
                    <a href="mailto:sales@gotcha.co.il" className="text-xs font-medium text-blue-600 hover:underline">Contact sales</a>
                  ) : (
                    <button disabled={busy !== null}
                      onClick={() => run(`plan-${p.key}`, () => (isGrandfathered ? migratePlan(token!, p.key) : changePlan(token!, p.key)), isGrandfathered ? `Migrated to ${p.name}` : `Plan change to ${p.name} applied`)}
                      className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                      {isGrandfathered ? "Choose plan" : "Switch"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-gray-400">Upgrades apply immediately (prorated). Downgrades take effect at the next renewal.</p>
      </Section>

      {/* ── Buy AI Units ── */}
      <Section title="Buy AI Units">
        <div className="grid gap-3 sm:grid-cols-3">
          {packages.map((pk) => (
            <div key={pk.id} className="rounded-lg border border-gray-200 p-4">
              <div className="font-semibold text-gray-900">{fmt(pk.units)} Units</div>
              <div className="text-lg font-bold text-gray-900">₪{pk.price}</div>
              <button disabled={busy !== null}
                onClick={() => run(`buy-${pk.key}`, async () => { const r = await buyCredits(token!, pk.key); if (!r.success) throw new Error(r.failureCode || "purchase_failed"); }, `${fmt(pk.units)} Units added`)}
                className="mt-2 w-full rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                Buy
              </button>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Auto-purchase ── */}
      <Section title="Auto-purchase">
        <AutoPurchaseForm token={token!} policy={policy} packages={packages} busy={busy !== null}
          onSave={(p) => run("autopurchase", () => setAutoPurchase(token!, p), "Auto-purchase updated")} />
      </Section>

      {/* ── Payment methods ── */}
      <Section title="Payment method" action={
        <button disabled={busy !== null} onClick={addCard}
          className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50">
          {methods.length ? "Replace card" : "Add card"}
        </button>
      }>
        {methods.length === 0 ? (
          <p className="text-sm text-gray-500">No card on file. Cards are stored securely by iCount; GOTCHA never sees your card number.</p>
        ) : (
          <ul className="space-y-2">
            {methods.map((m) => (
              <li key={m.id} className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2 text-sm">
                <span>{(m.brand ?? "card").toUpperCase()} •••• {m.last4} {m.expMonth && `(${m.expMonth}/${m.expYear})`} {m.isDefault && <span className="ml-2 text-xs text-blue-600">default</span>}</span>
                <button disabled={busy !== null} onClick={() => run(`rm-${m.id}`, () => removePaymentMethod(token!, m.id), "Card removed")}
                  className="text-xs text-red-600 hover:underline">Remove</button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ── Invoices ── */}
      <Section title="Invoices &amp; payments">
        {invoices.length === 0 ? (
          <p className="text-sm text-gray-500">No invoices yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-gray-500">
                <th className="py-2">Date</th><th>Type</th><th>Amount</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-t border-gray-100">
                  <td className="py-2">{new Date(inv.createdAt).toLocaleDateString()}</td>
                  <td>{inv.type.replace(/_/g, " ").toLowerCase()}</td>
                  <td>₪{inv.amount}</td>
                  <td>{inv.status}</td>
                  <td className="text-right">{inv.providerPdfUrl && <a href={inv.providerPdfUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">PDF</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

function AutoPurchaseForm({
  token, policy, packages, busy, onSave,
}: {
  token: string;
  policy: AutoPurchasePolicy | null;
  packages: CreditPackage[];
  busy: boolean;
  onSave: (p: Partial<AutoPurchasePolicy>) => void;
}) {
  const [enabled, setEnabled] = useState(policy?.enabled ?? false);
  const [thresholdPct, setThresholdPct] = useState(policy?.thresholdPct ?? 10);
  const [packageKey, setPackageKey] = useState(policy?.packageKey ?? (packages[0]?.key ?? ""));
  const [maxMonthlySpend, setMaxMonthlySpend] = useState(policy?.maxMonthlySpend ?? "1000");

  useEffect(() => {
    if (policy) {
      setEnabled(policy.enabled);
      setThresholdPct(policy.thresholdPct);
      setPackageKey(policy.packageKey ?? packages[0]?.key ?? "");
      setMaxMonthlySpend(policy.maxMonthlySpend ?? "1000");
    }
  }, [policy, packages]);

  return (
    <div className="space-y-3 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Automatically buy more AI Units when running low</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="text-xs text-gray-500">Trigger at remaining %</span>
          <input type="number" min={1} max={50} value={thresholdPct} onChange={(e) => setThresholdPct(Number(e.target.value))}
            className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1" />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Package</span>
          <select value={packageKey} onChange={(e) => setPackageKey(e.target.value)} className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1">
            {packages.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Max monthly spend (₪)</span>
          <input type="number" min={0} value={maxMonthlySpend} onChange={(e) => setMaxMonthlySpend(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1" />
        </label>
      </div>
      <button disabled={busy} onClick={() => onSave({ enabled, thresholdPct, packageKey, maxMonthlySpend })}
        className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
        Save auto-purchase
      </button>
    </div>
  );
}
