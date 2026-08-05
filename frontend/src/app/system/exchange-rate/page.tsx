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
 * It separates proposing from approving, and refuses to let one person do both -
 * for OVERRIDES. The ordinary daily rate is fetched from the Bank of Israel and
 * needs no approval at all, because asking two people to sign off on the central
 * bank's own published number is ceremony, not control: it approves everything,
 * every day, and so checks nothing.
 *
 * It states plainly when charging is off, rather than leaving an empty state to
 * be interpreted. "No approved rate" is not a blank screen; it is a sentence.
 */

import { useCallback, useEffect, useState } from "react";
import { SystemLayout } from "@/components/SystemLayout";
import { useAuth } from "@/context/AuthContext";
import {
  CurrentRate,
  Enforcement,
  Reconciliations,
  type AffectedTenant,
  type EnforcementPreview,
  type RatesPayload,
  type Reconciliation,
  type Rate,
} from "@/components/system/BillingOversight";

const API = process.env.NEXT_PUBLIC_API_URL || "";

const EXAMPLE_PRICE = "499.00";

export default function ExchangeRatePage() {
  const { token } = useAuth();
  const [data, setData] = useState<RatesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Reconciliation[]>([]);
  const [enforcement, setEnforcement] = useState<EnforcementPreview | null>(null);
  const [fx, setFx] = useState<FxStatus | null>(null);

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
    // Separate call: a failure to load unresolved charges must not blank out
    // the rate itself, which is the reason most people open this page.
    try {
      const rec = await authed("/api/admin/billing/reconciliations");
      setPending(rec.data ?? []);
    } catch {
      setPending([]);
    }
    try {
      const enf = await authed("/api/admin/billing/enforcement-preview");
      setEnforcement(enf.data ?? null);
    } catch {
      setEnforcement(null);
    }
    try {
      const s = await authed("/api/admin/billing/fx-status");
      setFx(s.data ?? null);
    } catch {
      // Unknown, not "broken". The feed panel says so rather than showing a
      // healthy-looking default for a state nobody established.
      setFx(null);
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
            them. It comes from the Bank of Israel&apos;s official representative rate and is
            fetched automatically. Overriding it by hand is possible, and takes two people.
          </p>
        </header>

        {loading ? (
          <div className="h-32 animate-pulse rounded-2xl bg-gray-100 motion-reduce:animate-none" />
        ) : (
          <>
            <OfficialFeed fx={fx} busy={busy} onRefresh={() => act(() => authed("/api/admin/billing/fx-refresh", { method: "POST" }))} />

            <CurrentRate data={data} />

            <section className="mt-8 rounded-2xl border border-gray-200 p-5">
              <h2 className="text-sm font-semibold text-gray-900">Override the official rate</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-gray-500">
                Only for when the official rate cannot be used. Proposing does not change anything:
                a second administrator has to approve it before any card is charged at this rate,
                and an override expires on its own so a temporary decision does not become
                permanent by being forgotten.
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

                {/* Required, and required for a reason: an override with nothing
                    stated is indistinguishable from a mistake six months later,
                    when someone is trying to work out why a customer was charged
                    at a number the central bank never published. */}
                <label className="block min-w-[16rem] flex-1">
                  <span className="mb-1.5 block text-[12px] font-medium text-gray-700">
                    Why this override is needed
                  </span>
                  <input
                    type="text"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Bank of Israel feed unavailable since Tuesday"
                    className="w-full rounded-xl border border-gray-300 px-3 py-2 text-[15px] text-gray-900 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
                  />
                </label>

                {/* The effect, next to the cause. "3.65" reads as nothing; the
                    converted price reads as a decision. */}
                <div className="rounded-xl bg-gray-50 px-4 py-2.5">
                  <p className="text-[11px] uppercase tracking-wide text-gray-500">A ${EXAMPLE_PRICE} plan</p>
                  <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-gray-900" dir="ltr">
                    {preview ? `₪${preview}` : "-"}
                  </p>
                </div>

                <button
                  type="button"
                  disabled={busy || !preview || !reason.trim()}
                  onClick={() =>
                    act(async () => {
                      await authed("/api/admin/billing/exchange-rates", {
                        method: "POST",
                        body: JSON.stringify({ rate: draft.trim(), reason: reason.trim() }),
                      });
                      setDraft("");
                      setReason("");
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

            <Enforcement preview={enforcement} />

            <Reconciliations
              rows={pending}
              busy={busy}
              onSweep={() =>
                act(() => authed("/api/admin/billing/reconciliations/sweep", { method: "POST" }))
              }
            />

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


export type FxStatus = {
  enabled: boolean;
  source: string;
  maxStalenessHours: number;
  charging: boolean;
  current: {
    rate: string;
    origin: string;
    verificationState: string;
    officialDate: string | null;
    retrievedAt: string | null;
    maxUseUntil: string | null;
    overrideReason: string | null;
    ageHours: number | null;
    usable: boolean;
  } | null;
  metrics: {
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastFailureReason: string | null;
    circuitOpenUntil: string | null;
  };
};

/**
 * The official feed, answering the only two questions anyone opens this for:
 * can we charge right now, and how old is the number we would charge at.
 *
 * Both are stated as sentences. A green dot and a timestamp require the reader
 * to work out the implication themselves, and the implication - "every Israeli
 * customer's card is about to be debited at a rate from last Tuesday" - is the
 * part that matters.
 */
function OfficialFeed({
  fx,
  busy,
  onRefresh,
}: {
  fx: FxStatus | null;
  busy: boolean;
  onRefresh: () => void;
}) {
  if (!fx) {
    return (
      <section className="rounded-2xl border border-gray-200 bg-gray-50 p-5">
        <h2 className="text-sm font-semibold text-gray-900">Bank of Israel feed</h2>
        <p className="mt-1 text-[13px] text-gray-500">
          Could not read the feed status. This says nothing about whether charging works - it means
          this panel could not find out.
        </p>
      </section>
    );
  }

  const c = fx.current;
  const stale = c?.ageHours != null && c.ageHours > fx.maxStalenessHours;
  const overridden = c?.origin === "MANUAL_OVERRIDE" || c?.origin === "EMERGENCY_FALLBACK";

  // Charging off is the headline when it is true. Everything else is detail.
  const tone = !fx.charging
    ? "border-red-200 bg-red-50"
    : overridden || stale
      ? "border-amber-200 bg-amber-50"
      : "border-gray-200 bg-white";

  return (
    <section className={`rounded-2xl border p-5 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Bank of Israel feed</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-gray-700">
            {!fx.enabled
              ? "The feed is switched off. Charging needs an approved manual rate."
              : !fx.charging
                ? "No usable rate. Nothing can be charged right now."
                : overridden
                  ? "Charging at a manual override, not the official rate."
                  : "Charging at the official representative rate."}
          </p>
        </div>

        <button
          type="button"
          disabled={busy || !fx.enabled}
          onClick={onRefresh}
          className="rounded-xl border border-gray-300 bg-white px-3.5 py-2 text-[13px] font-medium text-gray-900 transition-colors hover:border-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Fetch now
        </button>
      </div>

      {c && (
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Fact label="Rate" value={Number(c.rate).toFixed(4)} mono />
          <Fact label="Published" value={c.officialDate ? new Date(c.officialDate).toLocaleDateString() : "-"} />
          <Fact
            label="Age"
            value={c.ageHours == null ? "-" : `${c.ageHours}h`}
            // Said plainly rather than colour-coded, because the consequence is
            // that charging stops, not that a badge turns orange.
            note={stale ? `past the ${fx.maxStalenessHours}h limit` : undefined}
          />
          <Fact label="Origin" value={originLabel(c.origin)} note={c.overrideReason ?? undefined} />
        </dl>
      )}

      {fx.metrics.circuitOpenUntil && (
        <p className="mt-3 text-[13px] text-amber-800">
          The feed failed repeatedly and is not being called again until{" "}
          {new Date(fx.metrics.circuitOpenUntil).toLocaleTimeString()}. The stored rate is still
          used until it goes stale.
        </p>
      )}

      {fx.metrics.lastFailureReason && !fx.metrics.circuitOpenUntil && (
        <p className="mt-3 text-[13px] text-gray-500">
          Last failure: {fx.metrics.lastFailureReason}
          {fx.metrics.lastFailureAt ? ` (${new Date(fx.metrics.lastFailureAt).toLocaleString()})` : ""}
        </p>
      )}
    </section>
  );
}

function Fact({ label, value, note, mono }: { label: string; value: string; note?: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className={`mt-0.5 text-[14px] font-medium text-gray-900 ${mono ? "tabular-nums" : ""}`} dir={mono ? "ltr" : undefined}>
        {value}
      </dd>
      {note && <p className="mt-0.5 text-[12px] text-amber-800">{note}</p>}
    </div>
  );
}

function originLabel(origin: string): string {
  switch (origin) {
    case "AUTOMATIC_OFFICIAL":
      return "Official";
    case "MANUAL_OVERRIDE":
      return "Manual override";
    case "EMERGENCY_FALLBACK":
      return "Emergency fallback";
    default:
      return origin;
  }
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
                <td className="px-4 py-2.5 text-gray-500">{r.createdBy ?? "-"}</td>
                <td className="px-4 py-2.5 text-gray-500">{r.approvedBy ?? "-"}</td>
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
