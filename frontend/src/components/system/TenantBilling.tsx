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
  type ProvisionablePlan,
  type ProvisioningQuote,
  type ProvisioningStatus,
} from "@/lib/api-system-billing";

export type BillingMode = "NONE" | "PAID_PLAN";

export interface BillingSelection {
  mode: BillingMode;
  planVersionId: string;
  chatVolumeOptionKey: string | null;
  voiceVolumeOptionKey: string | null;
  commercialNote: string;
}

export const EMPTY_BILLING: BillingSelection = {
  mode: "NONE",
  planVersionId: "",
  chatVolumeOptionKey: null,
  voiceVolumeOptionKey: null,
  commercialNote: "",
};

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
        <h3 className="text-[13px] font-semibold text-gray-900">Billing</h3>
        <span className="text-[11px] text-gray-500">
          Trials, proofs of concept and custom plans have their own flows.
        </span>
      </div>

      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Billing mode">
        {(["NONE", "PAID_PLAN"] as BillingMode[]).map((m) => (
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
            {m === "NONE" ? "No billing" : "Paid plan"}
          </button>
        ))}
      </div>

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
