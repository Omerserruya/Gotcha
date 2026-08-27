"use client";

/**
 * One organization's coupons, on its own sysadmin page.
 *
 * The full coupon surface lives at /system/coupons; this is the same data
 * where an operator actually needs it - looking at the customer who just
 * asked "why was I charged that". So it answers exactly two questions: what
 * is discounting their money right now, and until when.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import {
  listTenantCoupons,
  listCoupons,
  assignCouponToTenant,
  revokeTenantCoupon,
  type TenantCouponAssignment,
  type AdminCoupon,
} from "@/lib/api-billing";

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

export function TenantCoupons({ tenantId }: { tenantId: string }) {
  const { token } = useAuth();
  const [assignments, setAssignments] = useState<TenantCouponAssignment[]>([]);
  const [coupons, setCoupons] = useState<AdminCoupon[]>([]);
  const [couponId, setCouponId] = useState("");
  const [months, setMonths] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Null while unknown: an operator without coupon permissions should see
  // nothing rather than an empty list implying the customer has no discount.
  const [visible, setVisible] = useState<boolean | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      const [a, c] = await Promise.all([
        listTenantCoupons(token, tenantId),
        listCoupons(token).catch(() => ({ coupons: [] as AdminCoupon[] })),
      ]);
      setAssignments(a.assignments);
      setCoupons(c.coupons.filter((x) => x.active));
      setVisible(true);
    } catch {
      setVisible(false);
    }
  }, [token, tenantId]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (visible !== true) return null;

  const live = assignments.filter((a) => a.live);

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <div className="flex items-center gap-3 mb-1">
        <h2 className="font-semibold text-gray-900">Coupons</h2>
        <Link href="/system/coupons" className="ms-auto text-xs font-medium text-violet-600 hover:text-violet-700">
          Manage all coupons
        </Link>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        A coupon discounts what this organization is charged. Their plan and contracted price are unchanged.
      </p>

      {live.length > 0 ? (
        <div className="mb-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
          Charged with <strong>{live.map((a) => a.label).join(", ")}</strong> right now
          {live[0].endsAt ? `, until ${fmt(live[0].endsAt)}` : ", with no end date"}.
        </div>
      ) : (
        <p className="mb-4 text-sm text-gray-500">Paying full price - no coupon is applying.</p>
      )}

      {assignments.length > 0 && (
        <ul className="mb-4 space-y-2">
          {assignments.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 px-3 py-2 text-sm">
              <span className="font-mono text-gray-900">{a.code}</span>
              <span className="text-gray-700">{a.label}</span>
              <span className="text-gray-500">
                {fmt(a.startsAt)} → {a.endsAt ? fmt(a.endsAt) : "no end date"}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${
                  a.live ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-600"
                }`}
              >
                {a.live ? "discounting now" : a.status.toLowerCase()}
              </span>
              {a.status === "ACTIVE" && (
                <button
                  disabled={busy}
                  onClick={async () => {
                    if (!token) return;
                    setBusy(true);
                    setError(null);
                    try {
                      await revokeTenantCoupon(token, a.id);
                      await reload();
                    } catch (err: unknown) {
                      setError((err as { message?: string })?.message ?? "Could not revoke");
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

      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Give a coupon</span>
          <select
            value={couponId}
            onChange={(e) => setCouponId(e.target.value)}
            className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm"
          >
            <option value="">—</option>
            {coupons.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Months</span>
          <input
            value={months}
            onChange={(e) => setMonths(e.target.value)}
            inputMode="numeric"
            placeholder="default"
            className="w-24 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm"
          />
        </label>
        <button
          disabled={busy || !couponId}
          onClick={async () => {
            if (!token) return;
            setBusy(true);
            setError(null);
            try {
              await assignCouponToTenant(token, tenantId, {
                couponId,
                durationMonths: months ? Number(months) : null,
              });
              setCouponId("");
              setMonths("");
              await reload();
            } catch (err: unknown) {
              setError((err as { message?: string })?.message ?? "Could not assign");
            } finally {
              setBusy(false);
            }
          }}
          className="rounded-md bg-gray-900 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
        >
          Assign
        </button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
