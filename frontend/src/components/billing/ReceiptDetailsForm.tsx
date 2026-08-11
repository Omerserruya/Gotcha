"use client";

/**
 * Who the receipt is made out to.
 *
 * Two different things live here and they are not the same thing:
 *
 *   the NAME and ID printed on the tax document
 *   the COUNTRY, which selects the tax rate
 *
 * The country is asked for rather than inferred. The tenant's default country
 * code is a phone-normalisation default and the onboarding country is a
 * website-crawl guess; neither is a statement anyone made about where they are
 * liable, and a wrong answer either overcharges someone or leaves them owing
 * tax nobody collected. Until it is answered the server refuses to charge, so
 * this asks plainly rather than letting it surface as a declined payment.
 *
 * One component, three places - the settings page, adding a card, and checkout
 * - because a second copy is how the three drift into asking for different
 * things.
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getBillingIdentity, saveBillingIdentity, type BillingIdentity } from "@/lib/api-billing";

export const EMPTY_IDENTITY: BillingIdentity = {
  billingName: null,
  vatId: null,
  billingEmail: null,
  billingCountry: null,
  billingAddress: null,
};

/** The jurisdictions worth offering by name. */
const COMMON_COUNTRIES = [
  { code: "IL", he: "ישראל", en: "Israel" },
  { code: "US", he: 'ארה"ב', en: "United States" },
  { code: "GB", he: "בריטניה", en: "United Kingdom" },
  { code: "DE", he: "גרמניה", en: "Germany" },
  { code: "FR", he: "צרפת", en: "France" },
];

/** The two answers without which nothing can be charged or documented. */
export function identityIsComplete(id: BillingIdentity | null | undefined): boolean {
  return Boolean(id?.billingName?.trim() && id?.billingCountry?.trim());
}

export function useBillingIdentity() {
  const { token } = useAuth();
  const [identity, setIdentity] = useState<BillingIdentity | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      const { data } = await getBillingIdentity(token);
      setIdentity({ ...EMPTY_IDENTITY, ...data });
    } catch {
      // No profile yet is not an error - it is the state every organization
      // starts in, and the form is how it stops being that.
      setIdentity({ ...EMPTY_IDENTITY });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { identity, setIdentity, loading, reload, complete: identityIsComplete(identity) };
}

export function ReceiptDetailsForm({
  value,
  onSaved,
  saveLabel,
  compact = false,
}: {
  value: BillingIdentity | null;
  onSaved?: (saved: BillingIdentity) => void;
  saveLabel?: string;
  /** Drops the address field, for the inline uses where it is noise. */
  compact?: boolean;
}) {
  const { token } = useAuth();
  const { locale } = useI18n();
  const he = String(locale ?? "").startsWith("he");

  const [form, setForm] = useState<BillingIdentity>(value ?? EMPTY_IDENTITY);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (value) setForm({ ...EMPTY_IDENTITY, ...value });
  }, [value]);

  const set = (k: keyof BillingIdentity) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v || null }));

  const save = async () => {
    if (!token) return;
    setSaving(true);
    setMsg(null);
    try {
      const { data } = await saveBillingIdentity(token, form);
      const saved = { ...EMPTY_IDENTITY, ...data };
      setForm(saved);
      setMsg({ kind: "ok", text: he ? "הפרטים נשמרו" : "Saved" });
      onSaved?.(saved);
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? (he ? "השמירה נכשלה" : "Could not save") });
    } finally {
      setSaving(false);
    }
  };

  const canSave = Boolean(form.billingName?.trim() && form.billingCountry?.trim());

  return (
    <div className="space-y-4">
      {msg && (
        <div
          className={`rounded-xl border px-4 py-2.5 text-sm ${
            msg.kind === "ok"
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {msg.text}
        </div>
      )}

      <Field
        label={he ? "שם לקבלה" : "Name on the receipt"}
        hint={he ? "השם המשפטי של העסק או האדם שמחויב" : "The legal name of the business or person being billed"}
        value={form.billingName ?? ""}
        onChange={set("billingName")}
      />

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">{he ? "מדינה" : "Country"}</label>
        <select
          value={form.billingCountry ?? ""}
          onChange={(e) => set("billingCountry")(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
        >
          <option value="">{he ? "בחרו מדינה" : "Select a country"}</option>
          {COMMON_COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {he ? c.he : c.en}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-gray-500">
          {he
            ? "קובעת את שיעור המע״מ. בישראל נוסף מע״מ מעל המחיר; מחוץ לישראל אין מס כרגע."
            : "Sets the tax rate. In Israel VAT is added on top of the price; outside Israel there is currently no tax."}
        </p>
      </div>

      <Field
        label={he ? 'ח.פ. / ע.מ. / ת"ז' : "Company or tax ID"}
        hint={he ? "מופיע על חשבונית המס" : "Appears on the tax invoice"}
        value={form.vatId ?? ""}
        onChange={set("vatId")}
      />

      <Field
        label={he ? "אימייל לקבלות" : "Email for receipts"}
        hint={he ? "לשם תישלח הקבלה אוטומטית" : "The receipt is emailed here automatically"}
        type="email"
        value={form.billingEmail ?? ""}
        onChange={set("billingEmail")}
      />

      {!compact && (
        <Field label={he ? "כתובת" : "Address"} value={form.billingAddress ?? ""} onChange={set("billingAddress")} />
      )}

      <div className="pt-1">
        <button
          onClick={save}
          disabled={saving || !canSave}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {saving ? (he ? "שומר…" : "Saving…") : saveLabel ?? (he ? "שמירה" : "Save")}
        </button>
        {!canSave && (
          <span className="ms-3 text-xs text-gray-400">
            {he ? "שם ומדינה הם שדות חובה" : "Name and country are required"}
          </span>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
      />
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}
