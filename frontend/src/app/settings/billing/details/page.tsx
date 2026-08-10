"use client";

/**
 * Receipt details - the settings home for who the tax document is made out to.
 *
 * The form itself is shared with the add-card and checkout flows, so all three
 * ask for the same things in the same words. What is specific here is the
 * standalone framing and the warning, which exists because the consequence of
 * leaving the country blank is invisible until a payment declines.
 */
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { RequirePermission } from "@/components/RequirePermission";
import { ReceiptDetailsForm, useBillingIdentity } from "@/components/billing/ReceiptDetailsForm";

function BillingDetailsInner() {
  const { t, locale } = useI18n();
  const he = String(locale ?? "").startsWith("he");
  const { identity, loading, complete } = useBillingIdentity();

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Link
        href="/settings/billing"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700"
      >
        <svg className="h-4 w-4 rtl:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
        </svg>
        {t("settings.billing.backToBilling")}
      </Link>

      <div className="mb-6 mt-3">
        <h1 className="text-2xl font-bold text-gray-900">{he ? "פרטי קבלה" : "Receipt details"}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {he
            ? "השם והמספר שיופיעו על חשבונית המס/קבלה, והמדינה שקובעת את המע״מ."
            : "The name and ID that appear on the tax invoice/receipt, and the country that sets the tax."}
        </p>
      </div>

      {!loading && !complete && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {he
            ? "עד שיוגדרו שם ומדינה לא נוכל לחייב: בלי מדינה אין דרך לדעת אם חל מע״מ, ולגבות בלי לדעת זה או לחייב יתר או להשאיר חוב מס."
            : "Charging is on hold until a name and country are set. Without a country there is no way to know whether tax applies, and charging anyway either overcharges you or leaves tax uncollected."}
        </div>
      )}

      <div className="rounded-2xl border border-gray-200 p-5">
        {loading ? (
          <div className="h-64 animate-pulse rounded-xl bg-gray-50" />
        ) : (
          <ReceiptDetailsForm value={identity} />
        )}
      </div>
    </div>
  );
}

export default function BillingDetailsPage() {
  return (
    <RequirePermission perm="settings:billing:manage" redirectTo="/settings/billing">
      <BillingDetailsInner />
    </RequirePermission>
  );
}
