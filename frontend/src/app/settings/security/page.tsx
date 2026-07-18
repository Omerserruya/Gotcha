"use client";

/**
 * Workspace -> Security.
 *
 * A tenant admin sets the hierarchical MFA policy and sees live compliance:
 *   - SYSTEM_ADMIN protection is always on (platform requirement, not a toggle).
 *   - "Require MFA for Administrators" (default OFF).
 *   - "Require MFA for all users" (default OFF).
 * When a policy is enabled, un-enrolled users are gated into MFA setup on their
 * next entry (see MfaEnrollmentGate); already-enrolled users are unaffected.
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getTenantSecurity, updateTenantSecurity, getTenantSecurityReview,
  type TenantSecurity, type TenantSecurityMember,
} from "@/lib/api";

export default function SecuritySettingsPage() {
  const { token } = useAuth();
  const { locale } = useI18n();
  const he = locale === "he";
  const L = (en: string, heb: string) => (he ? heb : en);

  const [data, setData] = useState<TenantSecurity | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<null | "admins" | "all">(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try { setData(await getTenantSecurity(token)); setError(null); }
    catch (e: any) { setError(e?.message || L("Could not load security settings.", "לא ניתן לטעון הגדרות אבטחה.")); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  async function toggle(which: "admins" | "all", value: boolean) {
    if (!token) return;
    setSaving(which); setError(null);
    try {
      const patch = which === "admins" ? { mfaRequiredForAdmins: value } : { mfaRequiredForAllUsers: value };
      setData(await updateTenantSecurity(token, patch));
    } catch (e: any) {
      setError(e?.message || L("Could not update the policy.", "לא ניתן לעדכן את המדיניות."));
    } finally { setSaving(null); }
  }

  if (!token) return null;

  return (
    <div className="p-6" dir={he ? "rtl" : "ltr"}>
      <h1 className="mb-1 text-xl font-semibold text-gray-900">{L("Security", "אבטחה")}</h1>
      <p className="mb-6 text-sm text-gray-500">{L("Control multi-factor authentication for your workspace.", "ניהול אימות רב-שלבי עבור סביבת העבודה שלך.")}</p>

      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      {loading && !data && <p className="text-sm text-gray-400">{L("Loading…", "טוען…")}</p>}

      {data && (
        <div className="max-w-2xl space-y-6">
          {/* Authentication - system admin (not configurable) */}
          <section className="rounded-2xl border border-gray-100 bg-white p-5 shadow-subtle">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">{L("Authentication", "אימות")}</h2>
            <div className="mt-3 flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-green-50 text-green-600">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">{L("Platform administrators", "מנהלי פלטפורמה")}</p>
                <p className="text-xs text-gray-500">{L("Always protected with MFA. This is a platform security requirement and cannot be turned off.", "תמיד מוגנים באמצעות MFA. זוהי דרישת אבטחה של הפלטפורמה ולא ניתן לכבות אותה.")}</p>
              </div>
            </div>
          </section>

          {/* Tenant security - the two toggles */}
          <section className="rounded-2xl border border-gray-100 bg-white p-5 shadow-subtle">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">{L("Tenant security", "אבטחת ארגון")}</h2>
            <div className="mt-3 divide-y divide-gray-100">
              <ToggleRow
                title={L("Require MFA for Administrators", "חייב MFA למנהלים")}
                desc={L("Every admin in this workspace must set up MFA before accessing GOTCHA.", "כל מנהל בסביבת עבודה זו חייב להגדיר MFA לפני הגישה ל-GOTCHA.")}
                checked={data.policy.mfaRequiredForAdmins || data.policy.mfaRequiredForAllUsers}
                disabled={saving !== null || data.policy.mfaRequiredForAllUsers}
                hint={data.policy.mfaRequiredForAllUsers ? L("Included by “all users”", "כלול תחת „כל המשתמשים”") : undefined}
                busy={saving === "admins"}
                onChange={(v) => toggle("admins", v)}
                he={he}
              />
              <ToggleRow
                title={L("Require MFA for all users", "חייב MFA לכל המשתמשים")}
                desc={L("Every member of this workspace must set up MFA before accessing GOTCHA.", "כל חבר בסביבת עבודה זו חייב להגדיר MFA לפני הגישה ל-GOTCHA.")}
                checked={data.policy.mfaRequiredForAllUsers}
                disabled={saving !== null}
                busy={saving === "all"}
                onChange={(v) => toggle("all", v)}
                he={he}
              />
            </div>
          </section>

          {/* Password policy (platform-enforced, read-only) */}
          <section className="rounded-2xl border border-gray-100 bg-white p-5 shadow-subtle">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">{L("Password policy", "מדיניות סיסמאות")}</h2>
            <p className="mt-1 text-xs text-gray-500">{L("Enforced for every account across the platform when a password is set or changed.", "נאכפת עבור כל חשבון בפלטפורמה בעת קביעת או שינוי סיסמה.")}</p>
            <ul className="mt-3 space-y-1.5">
              {[
                L("At least 12 characters", "לפחות 12 תווים"),
                L("Upper- and lower-case letters, a number and a symbol", "אותיות גדולות וקטנות, מספר וסימן"),
                L("Rejected if found in a known data breach", "נדחית אם נמצאה בדליפת מידע ידועה"),
                L("Rejected if easily guessable", "נדחית אם קלה לניחוש"),
              ].map((rule) => (
                <li key={rule} className="flex items-center gap-2 text-sm text-gray-700">
                  <svg className="h-4 w-4 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                  {rule}
                </li>
              ))}
            </ul>
          </section>

          {/* Compliance */}
          <section className="rounded-2xl border border-gray-100 bg-white p-5 shadow-subtle">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">{L("Compliance", "עמידה בדרישות")}</h2>
              <button onClick={() => setReviewOpen(true)} className="text-xs font-medium text-primary-600 hover:underline">
                {L("Review users", "סקירת משתמשים")}
              </button>
            </div>
            {!data.idpAvailable && (
              <p className="mt-2 text-[11px] text-amber-600">{L("Live status is temporarily unavailable; showing last known state.", "הסטטוס החי אינו זמין כרגע; מוצג המצב האחרון הידוע.")}</p>
            )}
            <div className="mt-3 grid grid-cols-2 gap-3">
              <ComplianceCard label={L("Administrators protected", "מנהלים מוגנים")} c={data.compliance.admins} he={he} />
              <ComplianceCard label={L("Users protected", "משתמשים מוגנים")} c={data.compliance.users} he={he} />
            </div>
          </section>
        </div>
      )}

      {reviewOpen && token && (
        <ReviewUsersModal token={token} L={L} he={he} onClose={() => { setReviewOpen(false); void load(); }} />
      )}
    </div>
  );
}

function ToggleRow({ title, desc, checked, disabled, busy, hint, onChange, he }: {
  title: string; desc: string; checked: boolean; disabled?: boolean; busy?: boolean; hint?: string;
  onChange: (v: boolean) => void; he: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-gray-800">{title}</p>
          {hint && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">{hint}</span>}
        </div>
        <p className="mt-0.5 text-xs text-gray-500">{desc}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${checked ? "bg-primary-600" : "bg-gray-200"} ${disabled ? "opacity-50" : ""}`}
      >
        <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${checked ? (he ? "-translate-x-5" : "translate-x-5") : (he ? "-translate-x-0.5" : "translate-x-0.5")}`}>
          {busy && <span className="block h-full w-full animate-pulse rounded-full bg-white" />}
        </span>
      </button>
    </div>
  );
}

function ComplianceCard({ label, c, he }: { label: string; c: { protected: number; total: number }; he: boolean }) {
  const full = c.total > 0 && c.protected >= c.total;
  const pct = c.total > 0 ? Math.round((c.protected / c.total) * 100) : 0;
  return (
    <div className="rounded-xl border border-gray-100 p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${full ? "text-green-600" : "text-gray-900"}`} dir="ltr">
        {c.protected} / {c.total}
      </p>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
        <div className={`h-full rounded-full ${full ? "bg-green-500" : "bg-primary-500"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ReviewUsersModal({ token, L, he, onClose }: {
  token: string; L: (en: string, heb: string) => string; he: boolean; onClose: () => void;
}) {
  const [members, setMembers] = useState<TenantSecurityMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTenantSecurityReview(token)
      .then((r) => setMembers(r.members))
      .catch((e: any) => setError(e?.message || "Failed to load"));
  }, [token]);

  // Who still needs MFA first, then everyone else.
  const sorted = (members ?? []).slice().sort((a, b) => {
    const an = a.required && !a.enrolled ? 0 : 1;
    const bn = b.required && !b.enrolled ? 0 : 1;
    return an - bn;
  });
  const needing = sorted.filter((m) => m.required && !m.enrolled).length;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-900/50 p-4 backdrop-blur-sm" dir={he ? "rtl" : "ltr"} onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">{L("MFA status by user", "סטטוס MFA לפי משתמש")}</h3>
            {members && <p className="text-xs text-gray-500">{needing > 0 ? L(`${needing} still need to enroll`, `${needing} עדיין צריכים להירשם`) : L("Everyone required is protected", "כל הנדרשים מוגנים")}</p>}
          </div>
          <button onClick={onClose} aria-label={L("Close", "סגירה")} className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {error && <p className="text-sm text-red-600">{error}</p>}
          {!members && !error && <p className="text-sm text-gray-400">{L("Loading…", "טוען…")}</p>}
          {members && (
            <ul className="divide-y divide-gray-100">
              {sorted.map((m) => {
                const needs = m.required && !m.enrolled;
                return (
                  <li key={m.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-gray-800">{m.name || m.email}</p>
                      <p className="truncate text-[11px] text-gray-400">{m.email} · {roleLabel(m.role, L)}</p>
                    </div>
                    {m.enrolled ? (
                      <span className="shrink-0 rounded-full bg-green-100 px-2.5 py-0.5 text-[10px] font-semibold text-green-700">{L("Protected", "מוגן")}</span>
                    ) : needs ? (
                      <span className="shrink-0 rounded-full bg-red-100 px-2.5 py-0.5 text-[10px] font-semibold text-red-700">{L("Needs MFA", "נדרש MFA")}</span>
                    ) : (
                      <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-0.5 text-[10px] font-semibold text-gray-500">{L("Optional", "אופציונלי")}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function roleLabel(role: string, L: (en: string, heb: string) => string): string {
  if (role === "SYSTEM_ADMIN") return L("Platform admin", "מנהל פלטפורמה");
  if (role === "ADMIN") return L("Administrator", "מנהל");
  return L("Member", "חבר");
}
