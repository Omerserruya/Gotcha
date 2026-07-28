"use client";

/**
 * Sysadmin paid-tenant billing UI.
 *
 * Two operator-facing ideas, kept deliberately distinct because they need
 * different actions:
 *
 *   Pending payment      billing setup is done; we are waiting for the customer
 *                        -> Resend payment link
 *   Billing setup incomplete
 *                        billing setup never finished; the customer has nothing
 *                        -> Repair billing setup
 *
 * Collapsing them into one "not paid yet" state would leave an operator
 * resending a link that does not exist.
 *
 * No commercial figure is computed here. The summary is whatever the server
 * quoted, so what the operator approves is exactly what provisioning freezes.
 */

import { useEffect, useState } from "react";
import {
  getProvisionablePlans,
  getProvisioningQuote,
  getPocFeatureDomains,
  assignPaidPlan,
  type ProvisionablePlan,
  type ProvisioningQuote,
  type ProvisioningStatus,
} from "@/lib/api-system-billing";

/**
 * Two ways to create an organization, and no third.
 *
 * "No billing" used to be the default here, which made the path of least
 * resistance the one that produced a tenant with full access and no commercial
 * record. An evaluation is a fine reason not to charge someone; skipping the
 * question is not, so the question can no longer be skipped.
 */
export type BillingMode = "PAID_PLAN" | "POC";

export interface BillingSelection {
  mode: BillingMode;
  planVersionId: string;
  chatVolumeOptionKey: string | null;
  voiceVolumeOptionKey: string | null;
  commercialNote: string;
  /** POC. Credits are a budget the operator gives away, not a price. */
  pocCredits: string;
  /** ISO date (yyyy-mm-dd) from a date input. */
  pocExpiresAt: string;
  pocFeatureAreas: string[];
}

export const EMPTY_BILLING: BillingSelection = {
  mode: "PAID_PLAN",
  planVersionId: "",
  chatVolumeOptionKey: null,
  voiceVolumeOptionKey: null,
  commercialNote: "",
  pocCredits: "",
  pocExpiresAt: "",
  pocFeatureAreas: [],
};

/** Whether the operator has said enough for the chosen mode to be submitted. */
export function billingSelectionComplete(v: BillingSelection, quoted: boolean): boolean {
  if (v.mode === "PAID_PLAN") return !!v.planVersionId && quoted;
  return (
    Number(v.pocCredits) > 0 &&
    !!v.pocExpiresAt &&
    new Date(v.pocExpiresAt).getTime() > Date.now() &&
    v.pocFeatureAreas.length > 0
  );
}

/** The billing section of the create-tenant form. */
export function BillingSection({
  token,
  value,
  onChange,
  onQuote,
}: {
  token: string;
  value: BillingSelection;
  onChange: (v: BillingSelection) => void;
  onQuote: (q: ProvisioningQuote | null) => void;
}) {
  const [plans, setPlans] = useState<ProvisionablePlan[]>([]);
  const [quote, setQuote] = useState<ProvisioningQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (value.mode !== "PAID_PLAN" || plans.length) return;
    getProvisionablePlans(token)
      .then(setPlans)
      .catch(() => setQuoteError("Could not load plans. Check platform billing permissions."));
  }, [value.mode, token, plans.length]);

  const plan = plans.find((p) => p.id === value.planVersionId) ?? null;

  // The server is the only source of the total. Re-quoted on every change so a
  // stale figure can never be the one the operator approves.
  useEffect(() => {
    if (value.mode !== "PAID_PLAN" || !value.planVersionId) {
      setQuote(null);
      onQuote(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setQuoteError(null);
    getProvisioningQuote(token, {
      planVersionId: value.planVersionId,
      chatVolumeOptionKey: value.chatVolumeOptionKey,
      voiceVolumeOptionKey: value.voiceVolumeOptionKey,
    })
      .then((q) => {
        if (cancelled) return;
        setQuote(q);
        onQuote(q);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setQuote(null);
        onQuote(null);
        setQuoteError(friendlyQuoteError(e?.code));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.mode, value.planVersionId, value.chatVolumeOptionKey, value.voiceVolumeOptionKey, token]);

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-gray-900">Billing type</h3>
        <span className="text-[11px] text-gray-500">
          Every organization has a plan. Trials, custom plans and manual contracts have their own flows.
        </span>
      </div>

      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Billing type">
        {(["PAID_PLAN", "POC"] as BillingMode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={value.mode === m}
            onClick={() => onChange({ ...EMPTY_BILLING, mode: m })}
            className={`rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 ${
              value.mode === m
                ? "border-gray-900 bg-gray-900 text-white"
                : "border-gray-200 bg-white text-gray-700 hover:border-gray-400"
            }`}
          >
            {m === "PAID_PLAN" ? "Paid plan" : "POC"}
          </button>
        ))}
      </div>

      {value.mode === "POC" && <PocSection token={token} value={value} onChange={onChange} />}

      {value.mode === "PAID_PLAN" && (
        <div className="mt-4 space-y-3">
          <Field label="Plan">
            <select
              value={value.planVersionId}
              onChange={(e) =>
                onChange({ ...value, planVersionId: e.target.value, chatVolumeOptionKey: null, voiceVolumeOptionKey: null })
              }
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-200"
              required
            >
              <option value="">Select a plan</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          {plan?.chatVolumeEnabled && plan.chatOptions.length > 0 && (
            <Field label="Chat conversations per business day">
              <VolumeSelect
                options={plan.chatOptions}
                value={value.chatVolumeOptionKey}
                onChange={(k) => onChange({ ...value, chatVolumeOptionKey: k })}
              />
            </Field>
          )}

          {plan?.voiceVolumeEnabled && plan.voiceOptions.length > 0 && (
            <Field label="Voice calls per business day">
              <VolumeSelect
                options={plan.voiceOptions}
                value={value.voiceVolumeOptionKey}
                onChange={(k) => onChange({ ...value, voiceVolumeOptionKey: k })}
              />
            </Field>
          )}

          <Field label="Internal note (optional)">
            <input
              value={value.commercialNote}
              onChange={(e) => onChange({ ...value, commercialNote: e.target.value })}
              placeholder="Not shown to the customer"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-200"
            />
          </Field>

          {quoteError && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{quoteError}</p>
          )}

          {loading && <p className="text-[12.5px] text-gray-500">Calculating…</p>}

          {quote && !loading && <CommercialSummary quote={quote} />}
        </div>
      )}
    </div>
  );
}

/**
 * The POC form: budget, expiry, feature areas, note.
 *
 * Every field is required except the note. A POC with no expiry is not an
 * evaluation, and a POC with no feature areas would silently mean "all of
 * them", because license semantics treat an absent row as allowed.
 */
function PocSection({
  token,
  value,
  onChange,
}: {
  token: string;
  value: BillingSelection;
  onChange: (v: BillingSelection) => void;
}) {
  const [domains, setDomains] = useState<string[]>([]);
  const [domainError, setDomainError] = useState(false);

  useEffect(() => {
    getPocFeatureDomains(token)
      .then(setDomains)
      .catch(() => setDomainError(true));
  }, [token]);

  const toggle = (d: string) => {
    const next = value.pocFeatureAreas.includes(d)
      ? value.pocFeatureAreas.filter((x) => x !== d)
      : [...value.pocFeatureAreas, d];
    onChange({ ...value, pocFeatureAreas: next });
  };

  const expiryInPast = !!value.pocExpiresAt && new Date(value.pocExpiresAt).getTime() <= Date.now();

  return (
    <div className="mt-4 space-y-3">
      <Field label="Credit budget">
        <input
          type="number"
          min={1}
          value={value.pocCredits}
          onChange={(e) => onChange({ ...value, pocCredits: e.target.value })}
          placeholder="e.g. 5000"
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-200"
          required
        />
      </Field>

      <Field label="Expires on">
        <input
          type="date"
          value={value.pocExpiresAt}
          onChange={(e) => onChange({ ...value, pocExpiresAt: e.target.value })}
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-200"
          required
        />
      </Field>
      {expiryInPast && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">
          The expiry has to be in the future.
        </p>
      )}

      <div>
        <span className="mb-1 block text-xs font-medium text-gray-600">Feature areas</span>
        {domainError ? (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">
            Could not load the feature areas. Reload before provisioning a POC.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {domains.map((d) => {
              const on = value.pocFeatureAreas.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(d)}
                  className={`rounded-lg border px-2.5 py-1 text-[12px] font-medium capitalize transition-colors ${
                    on
                      ? "border-gray-900 bg-gray-900 text-white"
                      : "border-gray-200 bg-white text-gray-600 hover:border-gray-400"
                  }`}
                >
                  {d.replace(/_/g, " ")}
                </button>
              );
            })}
          </div>
        )}
        <p className="mt-1.5 text-[11.5px] text-gray-500">
          Anything not selected is switched off for this organization, not merely left unmentioned.
        </p>
      </div>

      <Field label="Internal note (optional)">
        <input
          value={value.commercialNote}
          onChange={(e) => onChange({ ...value, commercialNote: e.target.value })}
          placeholder="Not shown to the customer"
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-200"
        />
      </Field>

      <p className="rounded-lg bg-emerald-50 px-3 py-2 text-[12px] leading-[1.55] text-emerald-900">
        No charge and no renewal. No card is collected, nothing is billed, and the POC will not roll
        over - access stops when the credit budget runs out or the expiry passes, whichever comes first.
      </p>
    </div>
  );
}

/** Server-computed figures only. */
function CommercialSummary({ quote }: { quote: ProvisioningQuote }) {
  const symbol = quote.currency === "ILS" ? "₪" : "$";
  const fmt = (v: string) => `${symbol}${Number(v).toLocaleString("en-US")}`;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <dl className="space-y-1.5 text-[13px]">
        <Row label="Plan" value={quote.planName} />
        <Row label="Base price" value={`${fmt(quote.basePrice)} / ${intervalLabel(quote.billingInterval)}`} />
        {/* Numeric compare: the API returns "499" and "499.00" for the same
            amount, so a string compare showed a redundant identical row. */}
        {Number(quote.totalAmount) !== Number(quote.basePrice) && (
          <Row label="With selected volume" value={fmt(quote.totalAmount)} />
        )}
        <Row label="Recurring total" value={`${fmt(quote.totalAmount)} ${quote.currency}`} strong />
        <Row label="Included credits" value={quote.includedCredits.toLocaleString()} />
        {quote.estimatedChatsMonthly > 0 && (
          <Row label="Estimated conversations" value={`~${quote.estimatedChatsMonthly.toLocaleString()} a month`} />
        )}
        {quote.estimatedCallsMonthly > 0 && (
          <Row label="Estimated calls" value={`~${quote.estimatedCallsMonthly.toLocaleString()} a month`} />
        )}
        <Row label="Tenant state after creation" value="Pending payment" />
      </dl>

      {!quote.chargeableToday && (
        // Honest, restrained, and names no provider or endpoint.
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[12px] leading-[1.55] text-amber-900">
          Payment activation is not yet enabled for this currency. The tenant will be created in
          Pending payment status.
        </p>
      )}
    </div>
  );
}

function VolumeSelect({
  options, value, onChange,
}: {
  options: { key: string; dailyVolume: number; additionalPrice: string }[];
  value: string | null;
  onChange: (k: string | null) => void;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-200"
    >
      <option value="">Plan default</option>
      {options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.dailyVolume} a day
        </option>
      ))}
    </select>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      {children}
    </label>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-gray-500">{label}</dt>
      <dd className={`tabular-nums ${strong ? "font-semibold text-gray-900" : "text-gray-800"}`}>{value}</dd>
    </div>
  );
}

/** "MONTHLY" is an enum, not operator copy. */
function intervalLabel(interval: string): string {
  return interval === "MONTHLY" ? "month" : interval === "ANNUAL" ? "year" : interval.toLowerCase();
}

function friendlyQuoteError(code?: string): string {
  switch (code) {
    case "plan_version_not_active":
    case "plan_version_not_found":
      return "That plan is no longer available. Choose another.";
    case "volume_option_invalid":
    case "volume_option_not_enabled":
      return "That volume option is not valid for the selected plan.";
    default:
      return "Could not calculate the plan summary. Try again.";
  }
}

// ── Plan state, everywhere a tenant is shown ────────────────────────────────

export interface PlanAccessView {
  state: string;
  label: string;
  source: string;
  active: boolean;
  planKey: string | null;
  planName?: string | null;
  expiresAt: string | null;
  needsReview: boolean;
  reviewReason?: string | null;
}

/**
 * One badge, always present.
 *
 * The rule this enforces visually: an apparently healthy tenant is never shown
 * with an empty plan field. A missing plan is louder than an active one,
 * because it is the state that needs someone to act.
 */
export function PlanAccessBadge({ access }: { access: PlanAccessView | null | undefined }) {
  if (!access) {
    // The list could not resolve it. Saying nothing here would read as "fine".
    return <span className="text-[11px] text-gray-400">Plan unknown</span>;
  }

  const tone =
    access.state === "MISSING" || access.state === "CONFLICTING"
      ? "bg-red-50 text-red-700 ring-red-200"
      : access.state === "SETUP_INCOMPLETE" || access.state === "EXPIRED"
      ? "bg-orange-50 text-orange-700 ring-orange-200"
      : access.state === "PENDING_PAYMENT"
      ? "bg-amber-50 text-amber-800 ring-amber-200"
      : "bg-green-50 text-green-700 ring-green-200";

  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${tone}`}>
      {access.label}
    </span>
  );
}

/**
 * The remediation surface for an organization that has no plan.
 *
 * Both ways out, on the page where the problem is visible. Neither is applied
 * automatically: assigning a plan to an organization that never chose one would
 * invent a commercial agreement, so the operator picks, and the tenant simply
 * stays blocked until they do.
 */
export function MissingPlanBanner({
  access,
  tenantId,
  token,
  onAssigned,
}: {
  access: PlanAccessView;
  tenantId: string;
  token: string;
  onAssigned: () => void;
}) {
  const [plans, setPlans] = useState<ProvisionablePlan[]>([]);
  const [planId, setPlanId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || !token || plans.length) return;
    getProvisionablePlans(token).then(setPlans).catch(() => setError("Could not load plans."));
  }, [open, token, plans.length]);

  async function assign() {
    if (!token || !planId) return;
    setBusy(true);
    setError(null);
    try {
      await assignPaidPlan(token, tenantId, { planVersionId: planId });
      onAssigned();
    } catch (e: any) {
      setError(
        e?.code === "TENANT_ALREADY_HAS_A_PLAN"
          ? "This organization already holds a plan. Reload the page."
          : "Could not assign the plan. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  const why =
    access.state === "CONFLICTING"
      ? "This organization has more than one active plan. Nothing has been changed automatically - which one is correct is a commercial decision."
      : access.state === "SETUP_INCOMPLETE"
      ? "Plan setup was requested for this organization and never finished. Repair it from the tenants list, or choose a plan below."
      : access.state === "EXPIRED"
      ? "This organization's access has ended. It cannot use the product until it is given a plan."
      : "This organization has no plan. It cannot use the product until it is given one.";

  return (
    <div className="rounded-2xl border border-red-200 bg-red-50/60 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-red-900">{access.label}</h2>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-red-800">{why}</p>
          <p className="mt-1.5 text-[12px] text-red-700/80">
            Authentication, account security and billing repair still work. The inbox, AI, channels and
            everything else does not.
          </p>
        </div>
        {access.state !== "CONFLICTING" && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-[12.5px] font-medium text-red-800 hover:border-red-500"
          >
            {open ? "Cancel" : "Assign a paid plan"}
          </button>
        )}
      </div>

      {open && (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-red-900">Plan</span>
            <select
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm outline-none"
            >
              <option value="">Select a plan</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <button
            onClick={assign}
            disabled={!planId || busy}
            className="rounded-lg bg-gray-900 px-3 py-2 text-[12.5px] font-medium text-white disabled:opacity-40"
          >
            {busy ? "Assigning…" : "Assign and request payment"}
          </button>
          <p className="w-full text-[11.5px] text-red-700/80">
            The organization moves to Pending payment and is emailed a payment link. Nothing is charged
            here, and no access is granted until payment is confirmed. To give access without charging,
            set it up as a POC below instead.
          </p>
        </div>
      )}

      {error && <p className="mt-2 text-[12.5px] text-red-700">{error}</p>}
    </div>
  );
}

// ── Tenant row / detail states ──────────────────────────────────────────────

export type TenantBillingUiState = "ACTIVE" | "PENDING_PAYMENT_READY" | "BILLING_SETUP_INCOMPLETE" | "OTHER";

/**
 * Which operator state a tenant is in.
 *
 * The distinction that matters: a tenant awaiting the CUSTOMER needs a resend;
 * one whose setup never finished needs a repair. Only the provisioning request
 * can tell them apart, so a missing status is treated as incomplete rather than
 * assumed ready.
 */
export function tenantBillingUiState(
  tenantStatus: string,
  provisioning: ProvisioningStatus | null | undefined,
): TenantBillingUiState {
  if (tenantStatus === "ACTIVE") return "ACTIVE";
  if (tenantStatus !== "PENDING_PAYMENT") return "OTHER";
  if (provisioning?.state === "COMPLETED") return "PENDING_PAYMENT_READY";
  return "BILLING_SETUP_INCOMPLETE";
}

export function BillingStatusBadge({ state }: { state: TenantBillingUiState }) {
  if (state === "PENDING_PAYMENT_READY") {
    return (
      <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
        Pending payment
      </span>
    );
  }
  if (state === "BILLING_SETUP_INCOMPLETE") {
    return (
      <span className="inline-flex rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">
        Billing setup incomplete
      </span>
    );
  }
  return null;
}

/** Resend and Repair, never both, with a confirmation for the destructive-sounding one. */
export function TenantBillingActions({
  state,
  provisioning,
  busy,
  onResend,
  onRepair,
}: {
  state: TenantBillingUiState;
  provisioning: ProvisioningStatus | null | undefined;
  busy: boolean;
  onResend: () => void;
  onRepair: () => void;
}) {
  const [confirmRepair, setConfirmRepair] = useState(false);

  if (state === "PENDING_PAYMENT_READY") {
    return (
      <button
        onClick={onResend}
        disabled={busy}
        className="rounded-lg border border-gray-200 px-3 py-1.5 text-[12.5px] font-medium text-gray-700 transition-colors hover:border-gray-400 disabled:opacity-40"
      >
        {busy ? "Sending…" : "Resend payment link"}
      </button>
    );
  }

  if (state !== "BILLING_SETUP_INCOMPLETE") return null;

  // A permanently invalid request cannot be repaired by retrying; the operator
  // must pick a different plan, so offering Repair would be a lie.
  const repairable = provisioning?.canRepair ?? true;

  return (
    <div className="flex flex-col items-end gap-1.5">
      {provisioning?.lastFailureMessage && (
        <p className="max-w-xs text-end text-[11.5px] leading-snug text-red-700">
          {provisioning.lastFailureMessage}
        </p>
      )}
      {repairable ? (
        confirmRepair ? (
          <div className="rounded-lg border border-gray-200 bg-white p-2.5 text-end">
            <p className="mb-2 max-w-[15rem] text-[11.5px] leading-snug text-gray-600">
              This retries billing setup. It does not charge the customer, activate the plan or grant
              credits.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmRepair(false)}
                className="rounded-lg px-2.5 py-1 text-[12px] text-gray-500 hover:text-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setConfirmRepair(false);
                  onRepair();
                }}
                disabled={busy}
                className="rounded-lg bg-gray-900 px-3 py-1 text-[12px] font-medium text-white hover:bg-gray-800 disabled:opacity-40"
              >
                {busy ? "Repairing…" : "Repair setup"}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirmRepair(true)}
            disabled={busy}
            className="rounded-lg border border-red-200 px-3 py-1.5 text-[12.5px] font-medium text-red-700 transition-colors hover:border-red-400 disabled:opacity-40"
          >
            Repair billing setup
          </button>
        )
      ) : (
        <span className="text-[11.5px] text-gray-500">Select a different plan and provision again</span>
      )}
    </div>
  );
}
