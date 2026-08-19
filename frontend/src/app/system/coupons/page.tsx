"use client";

/**
 * Coupons: where an operator issues a discount and gives it to a customer.
 *
 * The page is built around one distinction, because getting it wrong is how
 * discounts turn into pricing chaos: a coupon is a DISCOUNT ON A PRICE, not a
 * different price. The plan the customer is on never changes, their contracted
 * price never changes, and when the window closes the charge simply returns to
 * what it always said it was.
 *
 * Two things are therefore always visible when assigning: the exact window
 * ("every charge from today until 19 Aug 2027"), and a worked example of what
 * a real price becomes. A percentage means nothing at a glance; "₪499 → ₪399,
 * every month for 12 months" means everything, and it is the sentence that
 * stops somebody typing 90 when they meant 9.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { SystemLayout } from "@/components/SystemLayout";
import { useAuth } from "@/context/AuthContext";
import {
  listCoupons,
  createCoupon,
  setCouponActive,
  listAssignableTenants,
  assignCouponToTenant,
  listTenantCoupons,
  revokeTenantCoupon,
  type AdminCoupon,
  type TenantCouponAssignment,
} from "@/lib/api-billing";

/** The price the worked example is computed on. Real, and recognisable. */
const EXAMPLE_PRICE = 499;

type Notice = { kind: "ok" | "err"; text: string } | null;

const ERROR_COPY: Record<string, string> = {
  invalid_code: "Code must be 2-32 characters: letters, digits, dash or underscore.",
  name_required: "Give the coupon a name.",
  percent_out_of_range: "A percentage must be a whole number between 1 and 100.",
  amount_required: "Enter an amount greater than zero.",
  currency_required_for_fixed: "A fixed-amount coupon needs a currency.",
  invalid_duration: "Duration must be a whole number of months.",
  unknown_coupon: "That coupon no longer exists.",
  coupon_inactive: "This coupon is disabled. Enable it before assigning.",
  coupon_exhausted: "This coupon has reached its redemption limit.",
  unknown_tenant: "That organization no longer exists.",
  already_assigned: "This organization already has this coupon. Revoke the existing one first.",
};

function explain(err: unknown): string {
  const code = (err as { message?: string })?.message ?? "";
  return ERROR_COPY[code] || "Something went wrong. Nothing was changed.";
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function CouponsPage() {
  const { token } = useAuth();
  const [coupons, setCoupons] = useState<AdminCoupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      setCoupons((await listCoupons(token)).coupons);
    } catch (err) {
      setNotice({ kind: "err", text: explain(err) });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <SystemLayout>
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <header>
          <h1 className="text-2xl font-semibold text-gray-900">Coupons</h1>
          <p className="mt-1 text-sm text-gray-600">
            A coupon discounts what a customer is charged. It does not change their plan or their contracted
            price - when the window closes, the charge returns to the plan price on its own.
          </p>
        </header>

        {notice && (
          <div
            className={`rounded-lg px-4 py-2 text-sm ${
              notice.kind === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"
            }`}
          >
            {notice.text}
          </div>
        )}

        <CreateCoupon
          token={token}
          busy={busy}
          setBusy={setBusy}
          onDone={(text) => {
            setNotice({ kind: "ok", text });
            reload();
          }}
          onError={(text) => setNotice({ kind: "err", text })}
        />

        <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 font-semibold text-gray-900">Issued coupons</h2>
          {loading ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : coupons.length === 0 ? (
            <p className="text-sm text-gray-500">No coupons yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                    <th className="pb-2">Code</th>
                    <th className="pb-2">Discount</th>
                    <th className="pb-2">Default window</th>
                    <th className="pb-2">Given to</th>
                    <th className="pb-2">State</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {coupons.map((c) => (
                    <tr key={c.id} className={c.active ? "" : "opacity-60"}>
                      <td className="py-2">
                        <div className="font-mono text-gray-900">{c.code}</div>
                        <div className="text-xs text-gray-500">{c.nameEn}</div>
                      </td>
                      <td className="py-2 text-gray-900">{c.label}</td>
                      <td className="py-2 text-gray-700">
                        {c.defaultDurationMonths ? `${c.defaultDurationMonths} months` : "Until revoked"}
                      </td>
                      <td className="py-2 text-gray-700">
                        {c.assignmentCount} org{c.assignmentCount === 1 ? "" : "s"}
                        {c.maxRedemptions != null && (
                          <span className="text-gray-400"> / {c.maxRedemptions} max</span>
                        )}
                      </td>
                      <td className="py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            c.active ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {c.active ? "Active" : "Disabled"}
                        </span>
                      </td>
                      <td className="py-2 text-end">
                        <button
                          disabled={busy}
                          onClick={async () => {
                            if (!token) return;
                            setBusy(true);
                            try {
                              await setCouponActive(token, c.id, !c.active);
                              // Disabling stops NEW assignments and stops live
                              // ones discounting - said plainly, because it is
                              // a money change, not a tidy-up.
                              setNotice({
                                kind: "ok",
                                text: c.active
                                  ? `${c.code} disabled. It stops discounting immediately, everywhere it is assigned.`
                                  : `${c.code} enabled.`,
                              });
                              reload();
                            } catch (err) {
                              setNotice({ kind: "err", text: explain(err) });
                            } finally {
                              setBusy(false);
                            }
                          }}
                          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                        >
                          {c.active ? "Disable" : "Enable"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <AssignCoupon
          token={token}
          coupons={coupons.filter((c) => c.active)}
          busy={busy}
          setBusy={setBusy}
          onDone={(text) => {
            setNotice({ kind: "ok", text });
            reload();
          }}
          onError={(text) => setNotice({ kind: "err", text })}
        />
      </div>
    </SystemLayout>
  );
}

function CreateCoupon({
  token,
  busy,
  setBusy,
  onDone,
  onError,
}: {
  token: string | null;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDone: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [code, setCode] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [nameHe, setNameHe] = useState("");
  const [discountType, setDiscountType] = useState<"PERCENT" | "FIXED">("PERCENT");
  const [percentOff, setPercentOff] = useState("20");
  const [amountOff, setAmountOff] = useState("50.00");
  const [currency, setCurrency] = useState("ILS");
  const [durationMonths, setDurationMonths] = useState("12");
  const [maxRedemptions, setMaxRedemptions] = useState("");
  const [note, setNote] = useState("");

  // The whole point of this line: turn an abstract discount into money.
  const example = useMemo(() => {
    if (discountType === "PERCENT") {
      const pct = Number(percentOff);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
      const off = Math.round(EXAMPLE_PRICE * pct) / 100;
      return `₪${EXAMPLE_PRICE} → ₪${(EXAMPLE_PRICE - off).toFixed(2)} (₪${off.toFixed(2)} off)`;
    }
    const amt = Number(amountOff);
    if (!Number.isFinite(amt) || amt <= 0) return null;
    if (currency !== "ILS") return `A ${currency} coupon only discounts charges made in ${currency}.`;
    return `₪${EXAMPLE_PRICE} → ₪${Math.max(0, EXAMPLE_PRICE - amt).toFixed(2)} (₪${amt.toFixed(2)} off)`;
  }, [discountType, percentOff, amountOff, currency]);

  const input = "w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm";

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="mb-3 font-semibold text-gray-900">Create a coupon</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Code *</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="LAUNCH20"
            className={`${input} font-mono`}
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-xs font-medium text-gray-600">Name (English) *</span>
          <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="Launch discount" className={input} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Name (Hebrew)</span>
          <input value={nameHe} onChange={(e) => setNameHe(e.target.value)} placeholder="הנחת השקה" className={input} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Discount type *</span>
          <select value={discountType} onChange={(e) => setDiscountType(e.target.value as "PERCENT" | "FIXED")} className={input}>
            <option value="PERCENT">Percentage</option>
            <option value="FIXED">Fixed amount</option>
          </select>
        </label>
        {discountType === "PERCENT" ? (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600">Percent off *</span>
            <input value={percentOff} onChange={(e) => setPercentOff(e.target.value)} inputMode="numeric" className={input} />
          </label>
        ) : (
          <>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">Amount off *</span>
              <input value={amountOff} onChange={(e) => setAmountOff(e.target.value)} inputMode="decimal" className={input} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">Currency *</span>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} className={input}>
                <option value="ILS">ILS</option>
                <option value="USD">USD</option>
              </select>
            </label>
          </>
        )}
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Default duration (months)</span>
          <input
            value={durationMonths}
            onChange={(e) => setDurationMonths(e.target.value)}
            inputMode="numeric"
            placeholder="Leave empty for no end date"
            className={input}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Max organizations</span>
          <input
            value={maxRedemptions}
            onChange={(e) => setMaxRedemptions(e.target.value)}
            inputMode="numeric"
            placeholder="Unlimited"
            className={input}
          />
        </label>
        <label className="block sm:col-span-3">
          <span className="mb-1 block text-xs font-medium text-gray-600">Internal note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Never shown to the customer" className={input} />
        </label>
      </div>

      {example && (
        <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
          On a ₪{EXAMPLE_PRICE}/month plan: <strong>{example}</strong>
          {durationMonths ? `, every month for ${durationMonths} months.` : ", every month until revoked."}
        </p>
      )}

      <button
        disabled={busy || !code || !nameEn}
        onClick={async () => {
          if (!token) return;
          setBusy(true);
          try {
            await createCoupon(token, {
              code,
              nameEn,
              nameHe: nameHe || null,
              discountType,
              percentOff: discountType === "PERCENT" ? Number(percentOff) : null,
              amountOff: discountType === "FIXED" ? amountOff : null,
              currency: discountType === "FIXED" ? currency : null,
              defaultDurationMonths: durationMonths ? Number(durationMonths) : null,
              maxRedemptions: maxRedemptions ? Number(maxRedemptions) : null,
              internalNote: note || null,
            });
            setCode("");
            setNameEn("");
            setNameHe("");
            setNote("");
            onDone("Coupon created.");
          } catch (err) {
            onError(explain(err));
          } finally {
            setBusy(false);
          }
        }}
        className="mt-4 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
      >
        Create coupon
      </button>
    </section>
  );
}

function AssignCoupon({
  token,
  coupons,
  busy,
  setBusy,
  onDone,
  onError,
}: {
  token: string | null;
  coupons: AdminCoupon[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDone: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [tenants, setTenants] = useState<Array<{ id: string; name: string; slug: string }>>([]);
  const [tenantId, setTenantId] = useState("");
  const [couponId, setCouponId] = useState("");
  const [durationMonths, setDurationMonths] = useState("");
  const [note, setNote] = useState("");
  const [assignments, setAssignments] = useState<TenantCouponAssignment[]>([]);

  useEffect(() => {
    if (!token) return;
    listAssignableTenants(token)
      .then((r) => setTenants(r.tenants))
      .catch(() => setTenants([]));
  }, [token]);

  const loadAssignments = useCallback(
    async (id: string) => {
      if (!token || !id) {
        setAssignments([]);
        return;
      }
      try {
        setAssignments((await listTenantCoupons(token, id)).assignments);
      } catch {
        setAssignments([]);
      }
    },
    [token],
  );

  useEffect(() => {
    loadAssignments(tenantId);
  }, [tenantId, loadAssignments]);

  const coupon = coupons.find((c) => c.id === couponId) ?? null;
  const months = durationMonths ? Number(durationMonths) : coupon?.defaultDurationMonths ?? null;
  const windowText = months
    ? `every charge from today for ${months} months`
    : "every charge from today until you revoke it";

  const input = "w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm";

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="mb-3 font-semibold text-gray-900">Give a coupon to an organization</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Organization *</span>
          <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} className={input}>
            <option value="">—</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Coupon *</span>
          <select value={couponId} onChange={(e) => setCouponId(e.target.value)} className={input}>
            <option value="">—</option>
            {coupons.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Duration (months)</span>
          <input
            value={durationMonths}
            onChange={(e) => setDurationMonths(e.target.value)}
            inputMode="numeric"
            placeholder={coupon?.defaultDurationMonths ? String(coupon.defaultDurationMonths) : "No end date"}
            className={input}
          />
        </label>
        <label className="block sm:col-span-3">
          <span className="mb-1 block text-xs font-medium text-gray-600">Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this organization gets it" className={input} />
        </label>
      </div>

      {coupon && (
        <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
          <strong>{coupon.label}</strong>, applied to {windowText}. Their plan and contracted price do not change.
        </p>
      )}

      <button
        disabled={busy || !tenantId || !couponId}
        onClick={async () => {
          if (!token) return;
          setBusy(true);
          try {
            await assignCouponToTenant(token, tenantId, {
              couponId,
              durationMonths: durationMonths ? Number(durationMonths) : null,
              note: note || null,
            });
            setNote("");
            onDone("Coupon assigned. It applies from the next charge.");
            loadAssignments(tenantId);
          } catch (err) {
            onError(explain(err));
          } finally {
            setBusy(false);
          }
        }}
        className="mt-4 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
      >
        Assign coupon
      </button>

      {tenantId && (
        <div className="mt-5 border-t border-gray-100 pt-4">
          <h3 className="mb-2 text-sm font-semibold text-gray-900">This organization&apos;s coupons</h3>
          {assignments.length === 0 ? (
            <p className="text-sm text-gray-500">None yet.</p>
          ) : (
            <ul className="space-y-2">
              {assignments.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 px-3 py-2 text-sm">
                  <span className="font-mono text-gray-900">{a.code}</span>
                  <span className="text-gray-700">{a.label}</span>
                  <span className="text-gray-500">
                    {fmtDate(a.startsAt)} → {a.endsAt ? fmtDate(a.endsAt) : "no end date"}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      a.live ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {a.live ? "Discounting now" : a.status.toLowerCase()}
                  </span>
                  {a.status === "ACTIVE" && (
                    <button
                      disabled={busy}
                      onClick={async () => {
                        if (!token) return;
                        setBusy(true);
                        try {
                          await revokeTenantCoupon(token, a.id);
                          onDone(`${a.code} revoked. The next charge is the full plan price.`);
                          loadAssignments(tenantId);
                        } catch (err) {
                          onError(explain(err));
                        } finally {
                          setBusy(false);
                        }
                      }}
                      className="ms-auto rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                    >
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
