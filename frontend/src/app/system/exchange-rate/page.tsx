"use client";

/**
 * The rate every Israeli customer's card is actually debited at.
 *
 * The page is built around one uncomfortable fact: a mistyped decimal point
 * here is a 10x charge on real people. So it does three things deliberately.
 *
 * It shows the effect before the cause - a worked example on a real plan price
 * sits next to the rate, because "3.65" means nothing at a glance and "$499
 * becomes ₪1,821.35" means everything.
 *
 * It separates proposing from approving, and refuses to let one person do both.
 *
 * It states plainly when charging is off, rather than leaving an empty state to
 * be interpreted. "No approved rate" is not a blank screen; it is a sentence.
 */

import { useCallback, useEffect, useState } from "react";
import { SystemLayout } from "@/components/SystemLayout";
import { useAuth } from "@/context/AuthContext";

const API = process.env.NEXT_PUBLIC_API_URL || "";

interface Rate {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  source: string;
  version: number;
  status: "DRAFT" | "ACTIVE" | "RETIRED";
  activeFrom: string;
  activeUntil: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
}

interface RatesPayload {
  current: Rate | null;
  chargingEnabled: boolean;
  history: Rate[];
  example: { commercial: string; charge: string } | null;
}

const EXAMPLE_PRICE = "499.00";

export default function ExchangeRatePage() {
  const { token } = useAuth();
  const [data, setData] = useState<RatesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authed = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init?.headers ?? {}),
        },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "request_failed");
      return body;
    },
    [token],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const body = await authed("/api/admin/billing/exchange-rates");
      setData(body.data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [authed]);

  useEffect(() => {
    if (token) load();
  }, [token, load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(humanError((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const preview = previewOf(draft);

  return (
    <SystemLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Exchange rate</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-gray-500">
            Plans are priced in dollars and charged in shekels. This is the rate used to convert
            them. It is entered by hand and never fetched, so a change here is always a decision
            somebody made.
          </p>
        </header>

        {loading ? (
          <div className="h-32 animate-pulse rounded-2xl bg-gray-100 motion-reduce:animate-none" />
        ) : (
          <>
            <CurrentRate data={data} />

            <section className="mt-8 rounded-2xl border border-gray-200 p-5">
              <h2 className="text-sm font-semibold text-gray-900">Propose a new rate</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-gray-500">
                Proposing does not change anything. A second administrator has to approve it before
                any card is charged at this rate.
              </p>

              <div className="mt-4 flex flex-wrap items-end gap-4">
                <label className="block">
                  <span className="mb-1.5 block text-[12px] font-medium text-gray-700">
                    Shekels per dollar
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="3.65"
                    dir="ltr"
                    className="w-40 rounded-xl border border-gray-300 px-3 py-2 text-[15px] tabular-nums text-gray-900 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
                  />
                </label>

                {/* The effect, next to the cause. "3.65" reads as nothing; the
                    converted price reads as a decision. */}
                <div className="rounded-xl bg-gray-50 px-4 py-2.5">
                  <p className="text-[11px] uppercase tracking-wide text-gray-500">A ${EXAMPLE_PRICE} plan</p>
                  <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-gray-900" dir="ltr">
                    {preview ? `₪${preview}` : "—"}
                  </p>
                </div>

                <button
                  type="button"
                  disabled={busy || !preview}
                  onClick={() =>
                    act(async () => {
                      await authed("/api/admin/billing/exchange-rates", {
                        method: "POST",
                        body: JSON.stringify({ rate: draft.trim() }),
                      });
                      setDraft("");
                    })
                  }
                  className="rounded-xl bg-gray-900 px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Propose
                </button>
              </div>

              {error && (
                <p role="alert" className="mt-3 text-[13px] text-red-600">
                  {error}
                </p>
              )}
            </section>

            <History rows={data?.history ?? []} busy={busy} onApprove={(id) =>
              act(() => authed(`/api/admin/billing/exchange-rates/${id}/approve`, { method: "POST" }))
            } onRetire={(id) =>
              act(() => authed(`/api/admin/billing/exchange-rates/${id}/retire`, { method: "POST" }))
            } />
          </>
        )}
      </div>
    </SystemLayout>
  );
}

function CurrentRate({ data }: { data: RatesPayload | null }) {
  if (!data?.current) {
    // Stated, not implied. An empty panel would read as "still loading".
    return (
      <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
        <h2 className="text-sm font-semibold text-amber-900">No approved rate - charging is off</h2>
        <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-amber-800">
          Customers cannot pay and renewals will not run until a rate is approved below. Nothing
          falls back to an estimate: without an approved rate there is no defensible number to
          charge, so the platform refuses rather than guessing.
        </p>
      </section>
    );
  }

  const r = data.current;
  return (
    <section className="rounded-2xl border border-gray-200 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">In effect now</h2>
          <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-gray-900" dir="ltr">
            {Number(r.rate).toFixed(4)}
          </p>
          <p className="mt-1 text-[12.5px] text-gray-500">
            shekels per dollar · version {r.version}
          </p>
        </div>
        {data.example && (
          <div className="rounded-xl bg-gray-50 px-4 py-3">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">Worked example</p>
            <p className="mt-1 text-[15px] tabular-nums text-gray-900" dir="ltr">
              {data.example.commercial} → <span className="font-semibold">{data.example.charge}</span>
            </p>
          </div>
        )}
      </div>
      <dl className="mt-5 grid gap-x-8 gap-y-2 border-t border-gray-100 pt-4 text-[13px] sm:grid-cols-2">
        <Row label="Approved by" value={r.approvedBy ?? "—"} />
        <Row label="Approved at" value={r.approvedAt ? new Date(r.approvedAt).toLocaleString() : "—"} />
        <Row label="Proposed by" value={r.createdBy ?? "—"} />
        <Row label="In effect from" value={new Date(r.activeFrom).toLocaleString()} />
      </dl>
    </section>
  );
}

function History({
  rows,
  busy,
  onApprove,
  onRetire,
}: {
  rows: Rate[];
  busy: boolean;
  onApprove: (id: string) => void;
  onRetire: (id: string) => void;
}) {
  if (!rows.length) return null;
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold text-gray-900">History</h2>
      {/* Scrolls inside itself so the page never scrolls sideways. */}
      <div className="overflow-x-auto rounded-2xl border border-gray-200">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="border-b border-gray-100 bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Version</th>
              <th className="px-4 py-2.5 font-medium">Rate</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Proposed by</th>
              <th className="px-4 py-2.5 font-medium">Approved by</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2.5 tabular-nums text-gray-500">{r.version}</td>
                <td className="px-4 py-2.5 font-medium tabular-nums text-gray-900" dir="ltr">
                  {Number(r.rate).toFixed(4)}
                </td>
                <td className="px-4 py-2.5">
                  <StatusPill status={r.status} />
                </td>
                <td className="px-4 py-2.5 text-gray-500">{r.createdBy ?? "—"}</td>
                <td className="px-4 py-2.5 text-gray-500">{r.approvedBy ?? "—"}</td>
                <td className="px-4 py-2.5 text-right">
                  {r.status === "DRAFT" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onApprove(r.id)}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-[12.5px] font-medium text-gray-900 transition-colors hover:border-gray-900 disabled:opacity-50"
                    >
                      Approve
                    </button>
                  )}
                  {r.status === "ACTIVE" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onRetire(r.id)}
                      className="rounded-lg border border-red-200 px-3 py-1.5 text-[12.5px] font-medium text-red-700 transition-colors hover:border-red-500 disabled:opacity-50"
                    >
                      Retire
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-gray-500">
        Retiring a rate without approving another stops all charging. That is intentional - it is
        the lever for stopping payments when a number turns out to be wrong.
      </p>
    </section>
  );
}

function StatusPill({ status }: { status: Rate["status"] }) {
  const style =
    status === "ACTIVE"
      ? "bg-emerald-50 text-emerald-700"
      : status === "DRAFT"
        ? "bg-amber-50 text-amber-700"
        : "bg-gray-100 text-gray-600";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${style}`}>
      {status.toLowerCase()}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 sm:justify-start sm:gap-2">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-gray-900">{value}</dd>
    </div>
  );
}

/**
 * Convert for display only.
 *
 * Deliberately mirrors the server's half-up rounding, and is only ever a
 * preview - the figure that gets charged is computed and frozen server-side.
 */
function previewOf(raw: string): string | null {
  const rate = Number(raw);
  if (!raw.trim() || !isFinite(rate) || rate <= 0 || rate >= 1000) return null;
  const cents = Math.round(Number(EXAMPLE_PRICE) * rate * 100);
  return (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function humanError(code: string): string {
  switch (code) {
    case "approver_must_differ_from_creator":
      return "A rate has to be approved by someone other than the person who proposed it.";
    case "rate_implausible":
      return "That rate looks like a typo. Check the decimal point.";
    case "rate_must_be_positive":
      return "A rate has to be a positive number.";
    case "forbidden":
      return "You do not have permission to change the exchange rate.";
    default:
      return "That did not work. Nothing was changed.";
  }
}
