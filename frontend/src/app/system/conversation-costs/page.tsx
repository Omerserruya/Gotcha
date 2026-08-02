"use client";

// Sysadmin: Conversation Cost - what a conversation ACTUALLY costs.
//
// This is layer A: real credits, real tokens, real provider spend, rolled up per
// conversation across every attributable AI job (replies, employee execution,
// summaries, CRM writeback, sentiment, retrieval, tool selection, voice).
//
// Two things this screen has to be honest about, and states on the page rather
// than only in code:
//
//   1. The global average is WEIGHTED - total usage over total completed
//      conversations. It is NOT the mean of the per-organization averages below
//      it, which would let a five-conversation pilot count as much as a
//      50,000-conversation account.
//   2. The comparison against the public estimate is ADVISORY. Actual usage
//      never updates what customers are shown; only an explicit publish on
//      Plans & Pricing does.
//
// Conversation content is deliberately absent - this is cost attribution, not a
// transcript viewer.

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { SystemLayout } from "@/components/SystemLayout";
import { useAuth } from "@/context/AuthContext";
import clsx from "clsx";
import {
  getConversationCostsByTenant,
  getEstimateVsActual,
  settleConversations,
  backfillConversations,
  type UsageStats,
  type EstimateComparison,
} from "@/lib/api-pricing-admin";

type Days = 7 | 30 | 90 | 365;
type Channel = "" | "CHAT" | "VOICE";

function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  return n.toFixed(digits).replace(/\.0$/, "");
}
function usd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export default function ConversationCostsPage() {
  const { token } = useAuth();
  const [days, setDays] = useState<Days>(30);
  const [channel, setChannel] = useState<Channel>("");
  const [global, setGlobal] = useState<UsageStats | null>(null);
  const [tenants, setTenants] = useState<Array<{ tenantId: string; name: string; stats: UsageStats }>>([]);
  const [note, setNote] = useState("");
  const [comparison, setComparison] = useState<{ chat: EstimateComparison; voice: EstimateComparison; guarantee: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    const from = new Date(Date.now() - days * 86_400_000).toISOString();
    const query: Record<string, string> = { from, ...(channel ? { type: channel } : {}) };
    try {
      const [byTenant, cmp] = await Promise.all([
        getConversationCostsByTenant(token, query),
        getEstimateVsActual(token, { from }),
      ]);
      setGlobal(byTenant.global);
      setTenants(byTenant.tenants);
      setNote(byTenant.note);
      setComparison(cmp);
    } catch (e: any) {
      setMsg(e?.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [token, days, channel]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setMsg(null);
    try {
      setMsg(await fn());
      await load();
    } catch (e: any) {
      setMsg(e?.message ?? "Failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <SystemLayout>
      <div className="h-screen overflow-y-auto p-6">
        <header className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Conversation Cost</h1>
            <p className="mt-0.5 max-w-2xl text-sm text-gray-400">
              What a conversation actually consumes, end to end. Internal only - never exposed through a tenant API.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as Channel)}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-gray-400"
            >
              <option value="">Chat and voice</option>
              <option value="CHAT">Chat only</option>
              <option value="VOICE">Voice only</option>
            </select>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value) as Days)}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-gray-400"
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last year</option>
            </select>
          </div>
        </header>

        {msg && <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-700">{msg}</div>}

        {loading ? (
          <div className="grid gap-3 md:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-gray-50" />)}
          </div>
        ) : (
          <div className="space-y-8">
            {/* ── Weighted global averages ── */}
            <section>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2 className="text-lg font-semibold text-gray-900">Platform average</h2>
                <p className="text-xs text-gray-400">Weighted: total usage / total completed conversations</p>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
                <Card label="Completed conversations" value={global ? global.conversations.toLocaleString() : "0"} highlight />
                <Card label="Avg credits" value={global ? fmt(global.avgCreditsPerConversation, 2) : "-"} sub="per conversation" />
                <Card label="Avg tokens" value={global ? fmt(global.avgTokensPerConversation, 0) : "-"} sub="per conversation" />
                <Card label="Avg model cost" value={global ? usd(global.avgModelCostPerConversation) : "-"} sub="per conversation" />
                <Card label="Total credits" value={global ? fmt(global.totalCredits, 0) : "-"} />
                <Card label="Total model cost" value={global ? usd(global.totalModelCostUsd) : "-"} />
              </div>

              {/* Distribution: the average alone hides the tail that actually
                  determines whether a commercial assumption survives. */}
              {global && global.conversations > 0 && (
                <div className="mt-3 rounded-2xl border border-gray-200 bg-white p-5">
                  <h3 className="text-sm font-semibold text-gray-900">Credits per conversation - distribution</h3>
                  <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-7">
                    <Metric label="Min" value={fmt(global.minCredits, 2)} />
                    <Metric label="Median" value={fmt(global.medianCredits, 2)} />
                    <Metric label="P75" value={fmt(global.p75Credits, 2)} />
                    <Metric label="P90" value={fmt(global.p90Credits, 2)} />
                    <Metric label="P95" value={fmt(global.p95Credits, 2)} />
                    <Metric label="Max" value={fmt(global.maxCredits, 2)} />
                    <Metric label="Std dev" value={fmt(global.stdDevCredits, 2)} />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 border-t border-gray-100 pt-3 sm:grid-cols-4">
                    <Metric label="Avg input tokens" value={fmt(global.avgInputTokensPerConversation, 0)} />
                    <Metric label="Avg output tokens" value={fmt(global.avgOutputTokensPerConversation, 0)} />
                    <Metric label="Total input" value={fmt(global.totalInputTokens, 0)} />
                    <Metric label="Total output" value={fmt(global.totalOutputTokens, 0)} />
                  </div>
                </div>
              )}
            </section>

            {/* ── Estimate vs actual ── */}
            {comparison && (
              <section>
                <h2 className="mb-3 text-lg font-semibold text-gray-900">Public estimate vs actual</h2>
                <div className="grid gap-3 md:grid-cols-2">
                  <ComparisonCard c={comparison.chat} title="Chat" unit="credits per conversation" />
                  <ComparisonCard c={comparison.voice} title="Voice" unit="credits per call" />
                </div>
                <div className="mt-3 rounded-xl border border-blue-200 bg-blue-50 p-3">
                  <p className="text-xs leading-relaxed text-blue-800">{comparison.guarantee}</p>
                  <Link href="/system/plans" className="mt-1.5 inline-flex text-xs font-medium text-blue-900 hover:underline">
                    Publish a new estimate on Plans &amp; Pricing →
                  </Link>
                </div>
              </section>
            )}

            {/* ── Per organization ── */}
            <section>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-lg font-semibold text-gray-900">By organization</h2>
                <div className="flex gap-2">
                  <button
                    disabled={busy !== null}
                    onClick={() => run("settle", async () => {
                      const r = await settleConversations(token!);
                      return `Settled ${r.settled}, discovered ${r.discovered}.`;
                    })}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                  >
                    {busy === "settle" ? "Settling…" : "Settle now"}
                  </button>
                  <button
                    disabled={busy !== null}
                    onClick={() => run("backfill", async () => {
                      const r = await backfillConversations(token!, 500);
                      return `Backfilled ${r.processed} conversations, linked ${r.linkedEvents} usage events.`;
                    })}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                  >
                    {busy === "backfill" ? "Backfilling…" : "Backfill"}
                  </button>
                </div>
              </div>

              {tenants.length === 0 ? (
                <p className="rounded-2xl border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-400">
                  No finalized conversations in this window. Conversations are counted once their settlement window has
                  elapsed, so post-close summaries are included rather than under-counted.
                </p>
              ) : (
                <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[46rem] text-sm">
                      <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-400">
                        <tr>
                          <th className="px-4 py-2.5 text-start">Organization</th>
                          <th className="px-4 py-2.5 text-end">Conversations</th>
                          <th className="px-4 py-2.5 text-end">Avg credits</th>
                          <th className="px-4 py-2.5 text-end">Median</th>
                          <th className="px-4 py-2.5 text-end">P90</th>
                          <th className="px-4 py-2.5 text-end">Avg tokens</th>
                          <th className="px-4 py-2.5 text-end">Avg cost</th>
                          <th className="px-4 py-2.5 text-end">Total cost</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {tenants.map((t) => (
                          <tr key={t.tenantId}>
                            <td className="px-4 py-2.5">
                              <span className="font-medium text-gray-800">{t.name}</span>
                              <span className="block font-mono text-[10px] text-gray-400">{t.tenantId}</span>
                            </td>
                            <td className="px-4 py-2.5 text-end tabular-nums" dir="ltr">{t.stats.conversations.toLocaleString()}</td>
                            <td className="px-4 py-2.5 text-end font-semibold tabular-nums text-gray-900" dir="ltr">
                              {fmt(t.stats.avgCreditsPerConversation, 2)}
                            </td>
                            <td className="px-4 py-2.5 text-end tabular-nums text-gray-600" dir="ltr">{fmt(t.stats.medianCredits, 2)}</td>
                            <td className="px-4 py-2.5 text-end tabular-nums text-gray-600" dir="ltr">{fmt(t.stats.p90Credits, 2)}</td>
                            <td className="px-4 py-2.5 text-end tabular-nums text-gray-600" dir="ltr">{fmt(t.stats.avgTokensPerConversation, 0)}</td>
                            <td className="px-4 py-2.5 text-end tabular-nums text-gray-600" dir="ltr">{usd(t.stats.avgModelCostPerConversation)}</td>
                            <td className="px-4 py-2.5 text-end tabular-nums text-gray-700" dir="ltr">{usd(t.stats.totalModelCostUsd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {note && <p className="mt-2 px-1 text-[11px] text-gray-400">{note}</p>}
            </section>
          </div>
        )}
      </div>
    </SystemLayout>
  );
}

function Card({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className={clsx("rounded-2xl border p-4", highlight ? "border-gray-900 bg-gray-900" : "border-gray-200 bg-white")}>
      <p className={clsx("text-[10px] font-medium uppercase tracking-wider", highlight ? "text-white/60" : "text-gray-400")}>
        {label}
      </p>
      <p className={clsx("mt-1 text-xl font-bold tabular-nums", highlight ? "text-white" : "text-gray-900")} dir="ltr">
        {value}
      </p>
      {sub && <p className={clsx("mt-0.5 text-[10px]", highlight ? "text-white/50" : "text-gray-400")}>{sub}</p>}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-gray-50 p-2.5">
      <p className="text-[9px] uppercase tracking-wider text-gray-400">{label}</p>
      <p className="font-mono text-sm font-bold text-gray-900" dir="ltr">{value}</p>
    </div>
  );
}

function ComparisonCard({ c, title, unit }: { c: EstimateComparison; title: string; unit: string }) {
  const hasData = c.conversations > 0 && c.differencePct != null;
  const over = (c.differencePct ?? 0) > 0;
  return (
    <div className={clsx("rounded-2xl border p-5", c.warn ? "border-amber-300 bg-amber-50" : "border-gray-200 bg-white")}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold text-gray-900">{title}</h3>
        {c.warn && (
          <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[11px] font-medium text-amber-900">
            diverging
          </span>
        )}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-gray-400">Configured</p>
          <p className="text-lg font-bold tabular-nums text-gray-900" dir="ltr">{c.configuredPublicEstimate}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-gray-400">Actual</p>
          <p className="text-lg font-bold tabular-nums text-gray-900" dir="ltr">
            {hasData ? c.actualAverage.toFixed(2) : "-"}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-gray-400">Difference</p>
          <p
            className={clsx("text-lg font-bold tabular-nums", !hasData ? "text-gray-300" : over ? "text-red-700" : "text-emerald-700")}
            dir="ltr"
          >
            {hasData ? `${over ? "+" : ""}${c.differencePct!.toFixed(1)}%` : "-"}
          </p>
        </div>
      </div>
      <p className="mt-3 text-[11px] text-gray-500">
        {unit} · {c.conversations.toLocaleString()} completed
      </p>
      {/* The contract, on the card itself. */}
      <p className="mt-1 text-[11px] text-gray-400">
        Advisory only - auto-applied: {String(c.autoApplied)}
      </p>
    </div>
  );
}
