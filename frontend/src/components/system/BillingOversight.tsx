"use client";

/**
 * The read-only panels on the platform billing page.
 *
 * Extracted from the page so they can actually be rendered in a test. They are
 * the surfaces a person looks at before deciding whether money is moving
 * correctly, and until now they had only ever been typechecked - which proves
 * they compile, not that they say anything true when handed real data.
 *
 * All three are display-only. Nothing here mutates; the page owns the actions.
 */

export interface Rate {
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

export interface RatesPayload {
  current: Rate | null;
  chargingEnabled: boolean;
  history: Rate[];
  example: { commercial: string; charge: string } | null;
}

export interface Reconciliation {
  id: string;
  organizationName: string | null;
  purpose: string;
  amount: string;
  currency: string;
  chargeAmount: string | null;
  chargeCurrency: string | null;
  state: string;
  failureCode: string | null;
  reviewReason: string | null;
  candidateCount: number | null;
  createdAt: string;
}

export interface AffectedTenant {
  tenantId: string;
  name: string;
  status: string;
  reason: string;
  recentConversations: number;
  live: boolean;
}

export interface EnforcementPreview {
  mode: string;
  enforcing: boolean;
  affected: AffectedTenant[];
  totals: { tenants: number; live: number; byReason: Record<string, number> };
}

export function CurrentRate({ data }: { data: RatesPayload | null }) {
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
        <Row label="Approved by" value={r.approvedBy ?? "-"} />
        <Row label="Approved at" value={r.approvedAt ? new Date(r.approvedAt).toLocaleString() : "-"} />
        <Row label="Proposed by" value={r.createdBy ?? "-"} />
        <Row label="In effect from" value={new Date(r.activeFrom).toLocaleString()} />
      </dl>
    </section>
  );
}

/**
 * Who stops being served, or would.
 *
 * Enforcement is one environment variable that decides whether unpaid
 * organizations' bots keep answering customers. The point of showing this is
 * that the answer to "how many people does this affect" should be available
 * before the switch is flipped, not discovered from the organizations whose
 * bots went quiet.
 */
export function Enforcement({ preview }: { preview: EnforcementPreview | null }) {
  if (!preview) return null;

  const { enforcing, totals, affected } = preview;
  if (!totals.tenants) {
    return (
      <section className="mt-8 rounded-2xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-900">Service enforcement</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-gray-500">
          Mode <span className="font-medium text-gray-900">{preview.mode}</span>. No organization would
          be refused right now.
        </p>
      </section>
    );
  }

  return (
    <section
      className={`mt-8 rounded-2xl border p-5 ${
        totals.live ? "border-red-200 bg-red-50/40" : "border-gray-200"
      }`}
    >
      <h2 className="text-sm font-semibold text-gray-900">
        {enforcing
          ? `${totals.tenants} organization${totals.tenants === 1 ? "" : "s"} being refused`
          : `${totals.tenants} organization${totals.tenants === 1 ? "" : "s"} would be refused`}
      </h2>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-gray-600">
        Mode is <span className="font-medium text-gray-900">{preview.mode}</span>.{" "}
        {enforcing
          ? "These organizations' AI is not answering their customers."
          : "Switching enforcement to hard would stop their AI answering their customers."}{" "}
        {totals.live > 0 ? (
          <span className="font-medium text-red-700">
            {totals.live} of them {totals.live === 1 ? "is" : "are"} handling live conversations.
          </span>
        ) : (
          "None of them are currently handling conversations."
        )}
      </p>

      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full min-w-[560px] text-left text-[13px]">
          <thead className="border-b border-gray-100 bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Organization</th>
              <th className="px-4 py-2.5 font-medium">Why</th>
              <th className="px-4 py-2.5 font-medium">Conversations (7d)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {affected.slice(0, 25).map((t) => (
              <tr key={t.tenantId} className={t.live ? "bg-red-50/40" : undefined}>
                <td className="px-4 py-2.5 text-gray-900">{t.name}</td>
                <td className="px-4 py-2.5 text-gray-600">{reasonLabel(t.reason)}</td>
                <td className="px-4 py-2.5 tabular-nums text-gray-700">
                  {t.recentConversations || "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {affected.length > 25 && (
        <p className="mt-2 text-[12.5px] text-gray-500">
          Showing the 25 most active of {affected.length}.
        </p>
      )}
    </section>
  );
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case "payment_required": return "Plan never activated - payment not confirmed";
    case "tenant_suspended": return "Organization suspended";
    case "subscription_suspended": return "Subscription suspended";
    case "subscription_canceled": return "Subscription canceled";
    case "units_exhausted": return "Out of credits";
    default: return reason;
  }
}

/**
 * Charges the system could not settle by itself.
 *
 * Read-only by design. Whoever resolves one has to look at the provider's own
 * records first, and what follows is a refund or a manual activation - both of
 * which have their own audited paths. A "mark as paid" button here would be a
 * way to grant a plan on no evidence at all.
 */
export function Reconciliations({
  rows,
  busy,
  onSweep,
}: {
  rows: Reconciliation[];
  busy: boolean;
  onSweep: () => void;
}) {
  if (!rows.length) return null;

  return (
    <section className="mt-8 rounded-2xl border border-amber-200 bg-amber-50/50 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-amber-900">
            {rows.length} charge{rows.length === 1 ? "" : "s"} need a human
          </h2>
          <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-amber-800">
            Each of these was submitted without a clear answer. Until one is settled it is either a
            customer who paid and did not get what they paid for, or one who did not pay and did.
            Check the provider&apos;s records before acting.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onSweep}
          className="rounded-xl border border-amber-300 bg-white px-4 py-2 text-[13px] font-medium text-amber-900 transition-colors hover:border-amber-500 disabled:opacity-50"
        >
          Check again
        </button>
      </div>

      <div className="mt-4 overflow-x-auto rounded-xl border border-amber-200 bg-white">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead className="border-b border-amber-100 text-[11px] uppercase tracking-wide text-amber-700">
            <tr>
              <th className="px-4 py-2.5 font-medium">Organization</th>
              <th className="px-4 py-2.5 font-medium">For</th>
              <th className="px-4 py-2.5 font-medium">Agreed</th>
              <th className="px-4 py-2.5 font-medium">Submitted</th>
              <th className="px-4 py-2.5 font-medium">State</th>
              <th className="px-4 py-2.5 font-medium">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-amber-50">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2.5 text-gray-900">{r.organizationName ?? "-"}</td>
                <td className="px-4 py-2.5 text-gray-500">{r.purpose.toLowerCase().replace(/_/g, " ")}</td>
                <td className="px-4 py-2.5 tabular-nums text-gray-700" dir="ltr">
                  {r.amount} {r.currency}
                </td>
                <td className="px-4 py-2.5 tabular-nums text-gray-900" dir="ltr">
                  {r.chargeAmount ? `${r.chargeAmount} ${r.chargeCurrency ?? ""}` : "-"}
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-gray-700">{describeState(r)}</span>
                </td>
                <td className="px-4 py-2.5 text-gray-500">{new Date(r.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Plain language, because the state name alone does not say what to do. */
function describeState(r: Reconciliation): string {
  if (r.state === "UNKNOWN") return "No answer from the provider";
  if (r.state === "RECONCILIATION_REQUIRED") return "Charged, but with no usable reference";
  if ((r.candidateCount ?? 0) > 1) return `${r.candidateCount} identical transactions - cannot tell which`;
  return r.reviewReason ?? "Needs review";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 sm:justify-start sm:gap-2">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-gray-900">{value}</dd>
    </div>
  );
}
