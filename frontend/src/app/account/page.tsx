"use client";

/**
 * Account & Security - native self-service experience.
 *
 * Reachable by EVERY authenticated user. GOTCHA owns the profile (name, phone,
 * language - editable here); credential/MFA/session/login data lives in
 * Authentik and is surfaced NATIVELY through /api/account/* (sessions, login
 * history, device summary) rather than bouncing the user to the IdP. Only the
 * two flows Authentik must own interactively - setting a password and enrolling
 * a device - deep-link into its hosted portal, and even those are launched from
 * inside this page.
 */

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { accountSettingsUrl, authentikFlowUrl, AUTHENTIK_FLOWS, FLOW_DONE_MESSAGE } from "@/lib/oidc";
import {
  getAccount, updateAccount, getAccountSecurity, getAccountPasswordLink,
  getAccountSessions, terminateAccountSession, terminateAllAccountSessions,
  getAccountLoginHistory, requestEmailChange, removeMfaDevice,
  type AccountProfile, type AccountSecurity, type AccountSession, type AccountLoginEvent,
} from "@/lib/api";

type SectionId = "profile" | "security" | "sessions" | "activity" | "preferences" | "privacy" | "support";

export default function AccountPage() {
  return <AccountExperience />;
}

/**
 * The Account & Security experience. Rendered standalone at /account (own header,
 * for direct access / system admins) OR `embedded` inside the Settings shell at
 * /settings/account (no header - Settings provides the chrome), so Account reads
 * as part of Settings rather than a redirect away.
 */
export function AccountExperience({ embedded = false }: { embedded?: boolean }) {
  const { user, token, isLoading, logout } = useAuth();
  const { locale, setLocale } = useI18n();
  const router = useRouter();
  const he = locale === "he";
  const L = (en: string, heb: string) => (he ? heb : en);

  const [active, setActive] = useState<SectionId>("profile");

  useEffect(() => {
    if (!isLoading && !user) router.replace(`/login?next=${embedded ? "/settings/account" : "/account"}`);
  }, [isLoading, user, router, embedded]);

  if (isLoading || !user || !token) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary-200 border-t-primary-600" />
      </div>
    );
  }

  const portal = (() => { try { return accountSettingsUrl(); } catch { return ""; } })();
  const backHref = user.role === "SYSTEM_ADMIN" ? "/system" : "/";

  const sections: { id: SectionId; label: string; icon: JSX.Element }[] = [
    { id: "profile", label: L("Profile", "פרופיל"), icon: <IconUser /> },
    { id: "security", label: L("Security", "אבטחה"), icon: <IconShield /> },
    { id: "sessions", label: L("Sessions", "סשנים"), icon: <IconDevice /> },
    { id: "activity", label: L("Login activity", "פעילות כניסה"), icon: <IconClock /> },
    { id: "preferences", label: L("Preferences", "העדפות"), icon: <IconSliders /> },
    { id: "privacy", label: L("Privacy", "פרטיות"), icon: <IconLock /> },
    { id: "support", label: L("Support", "תמיכה"), icon: <IconLife /> },
  ];

  const body = (
    <div className={embedded ? "" : "mx-auto max-w-5xl px-4 py-8"} dir={he ? "rtl" : "ltr"}>
      <div className="md:flex md:gap-6">
        {/* Section nav */}
        <aside className="mb-6 md:mb-0 md:w-52 md:shrink-0">
          <h1 className="mb-4 px-1 text-xl font-extrabold tracking-tight text-gray-900">
            {L("Account & Security", "חשבון ואבטחה")}
          </h1>
          <nav className="flex gap-1 overflow-x-auto md:flex-col md:gap-0.5">
            {sections.map((s) => (
              <button
                key={s.id}
                onClick={() => setActive(s.id)}
                className={`flex items-center gap-2.5 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium transition ${
                  active === s.id ? "bg-primary-50 text-primary-700" : "text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                }`}
              >
                <span className={active === s.id ? "text-primary-600" : "text-gray-400"}>{s.icon}</span>
                {s.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <div className="min-w-0 flex-1 space-y-5">
          {active === "profile" && <ProfileSection token={token} L={L} />}
          {active === "security" && <SecuritySection token={token} portal={portal} L={L} />}
          {active === "sessions" && <SessionsSection token={token} L={L} />}
          {active === "activity" && <ActivitySection token={token} L={L} />}
          {active === "preferences" && <PreferencesSection locale={locale} setLocale={setLocale} L={L} />}
          {active === "privacy" && <PrivacySection L={L} />}
          {active === "support" && <SupportSection L={L} logout={logout} />}
        </div>
      </div>
    </div>
  );

  if (embedded) return <div className="p-4 md:p-6">{body}</div>;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link href={backHref} className="flex items-center gap-2 text-gray-500 hover:text-gray-700">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d={he ? "M9 5l7 7-7 7" : "M15 19l-7-7 7-7"} />
            </svg>
            <span className="text-sm font-medium">{L("Back", "חזרה")}</span>
          </Link>
          <Image src="/logo_icon.png" alt="GOTCHA" width={120} height={28} style={{ height: 28, width: "auto" }} priority />
        </div>
      </header>
      {body}
    </div>
  );
}

// ─── Profile ─────────────────────────────────────────────────

function ProfileSection({ token, L }: { token: string; L: (en: string, heb: string) => string }) {
  const [data, setData] = useState<AccountProfile | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getAccount(token).then((d) => {
      setData(d); setName(d.user.name || ""); setPhone(d.user.phoneNumber || "");
    }).catch(() => setErr(L("Couldn't load your profile.", "לא ניתן לטעון את הפרופיל.")));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = data && (name.trim() !== (data.user.name || "") || phone.trim() !== (data.user.phoneNumber || ""));

  async function save() {
    setSaving(true); setErr(null); setSaved(false);
    try {
      const res = await updateAccount(token, { name: name.trim(), phoneNumber: phone.trim() || null });
      setData((d) => d ? { ...d, user: { ...d.user, ...res.user } } : d);
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch { setErr(L("Save failed. Try again.", "השמירה נכשלה. נסו שוב.")); }
    finally { setSaving(false); }
  }

  if (!data) return <Card><Skeleton /></Card>;

  return (
    <Card>
      <SectionTitle title={L("Profile", "פרופיל")} subtitle={L("Your identity across GOTCHA.", "הזהות שלך ב-GOTCHA.")} />
      <div className="mt-5 flex items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-400 to-primary-600 text-2xl font-bold text-white shadow-sm">
          {(data.user.name || "?").charAt(0).toUpperCase()}
        </div>
        <div className="text-xs text-gray-400">
          {L("Avatar uses your initial for now.", "התמונה משתמשת באות הראשונה כרגע.")}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={L("Full name", "שם מלא")}>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </Field>
        <Field label={L("Phone", "טלפון")}>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+972…" className={inputCls} />
        </Field>
        <Field label={L("Email", "דוא\"ל")}>
          <input value={data.user.email} disabled className={`${inputCls} cursor-not-allowed bg-gray-50 text-gray-500`} />
          <EmailChange token={token} L={L} />
        </Field>
        <Field label={L("Role", "תפקיד")}>
          <input value={data.user.role} disabled className={`${inputCls} cursor-not-allowed bg-gray-50 text-gray-500`} />
        </Field>
        {data.departmentName && (
          <Field label={L("Department", "מחלקה")}>
            <input value={data.departmentName} disabled className={`${inputCls} cursor-not-allowed bg-gray-50 text-gray-500`} />
          </Field>
        )}
        {data.tenantName && (
          <Field label={L("Workspace", "סביבת עבודה")}>
            <input value={data.tenantName} disabled className={`${inputCls} cursor-not-allowed bg-gray-50 text-gray-500`} />
          </Field>
        )}
      </div>

      {err && <p className="mt-4 text-sm font-medium text-red-600">{err}</p>}
      <div className="mt-6 flex items-center gap-3">
        <button onClick={save} disabled={!dirty || saving} className={btnPrimary}>
          {saving ? L("Saving…", "שומר…") : L("Save changes", "שמירת שינויים")}
        </button>
        {saved && <span className="text-sm font-medium text-green-600">{L("Saved ✓", "נשמר ✓")}</span>}
      </div>
    </Card>
  );
}

function EmailChange({ token, L }: { token: string; L: (en: string, heb: string) => string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [err, setErr] = useState("");

  async function send() {
    setState("sending"); setErr("");
    try { await requestEmailChange(token, email.trim()); setState("sent"); }
    catch (e: any) {
      setState("error");
      const c = String(e?.message || "");
      setErr(c.includes("email_taken") ? L("That email is already in use.", "הדוא\"ל כבר בשימוש.")
        : c.includes("same_email") ? L("That's already your email.", "זה כבר הדוא\"ל שלך.")
        : c.includes("invalid_email") ? L("Enter a valid email.", "הזינו דוא\"ל תקין.")
        : L("Couldn't send. Try again.", "השליחה נכשלה. נסו שוב."));
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-1 text-[11px] font-medium text-primary-600 hover:underline">
        {L("Change email", "שינוי דוא\"ל")}
      </button>
    );
  }
  if (state === "sent") {
    return <p className="mt-2 text-[11px] text-green-600">{L("Check your new inbox for a confirmation link.", "בדקו את תיבת הדוא\"ל החדשה לקישור אישור.")}</p>;
  }
  return (
    <div className="mt-2 space-y-2">
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={L("new@email.com", "new@email.com")} className={`${inputCls} py-2 text-xs`} />
      {err && <p className="text-[11px] text-red-600">{err}</p>}
      <div className="flex items-center gap-2">
        <button type="button" onClick={send} disabled={state === "sending" || !email.trim()} className="rounded-lg bg-primary-600 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50">
          {state === "sending" ? L("Sending…", "שולח…") : L("Send confirmation", "שליחת אישור")}
        </button>
        <button type="button" onClick={() => { setOpen(false); setState("idle"); setEmail(""); }} className="text-[11px] text-gray-400 hover:text-gray-600">
          {L("Cancel", "ביטול")}
        </button>
      </div>
      <p className="text-[11px] text-gray-400">{L("We'll email a confirmation link to the new address.", "נשלח קישור אישור לכתובת החדשה.")}</p>
    </div>
  );
}

// ─── Security ────────────────────────────────────────────────

function SecuritySection({ token, portal, L }: { token: string; portal: string; L: (en: string, heb: string) => string }) {
  const [sec, setSec] = useState<AccountSecurity | null>(null);
  const [flow, setFlow] = useState<{ url: string; title: string } | null>(null);
  const [manageMfa, setManageMfa] = useState(false);

  const load = useCallback(() => { getAccountSecurity(token).then(setSec).catch(() => setSec({ available: false })); }, [token]);
  useEffect(() => { load(); }, [load]);

  // Open an Authentik flow INSIDE an in-app modal (iframe) instead of redirecting
  // away. On close we re-fetch the security summary so status reflects changes.
  async function changePassword() {
    try {
      const { link } = await getAccountPasswordLink(token);
      setFlow({ url: link, title: L("Change password", "שינוי סיסמה") });
    } catch {
      if (portal) window.open(portal, "_blank", "noopener,noreferrer");
    }
  }
  const openFlow = (slug: string, title: string) => setFlow({ url: authentikFlowUrl(slug), title });

  const mfaOn = !!sec?.mfaEnabled;
  const passkeys = sec?.passkeys?.length ?? 0;
  const totp = sec?.totp?.length ?? 0;
  const recovery = sec?.recoveryCodes?.length ?? 0;

  return (
    <>
      <Card>
        <SectionTitle title={L("Sign-in security", "אבטחת כניסה")} subtitle={L("Your password, two-factor and passkeys.", "סיסמה, אימות דו-שלבי ומפתחות גישה.")} />
        <div className="mt-4 divide-y divide-gray-100">
          <SecRow
            title={L("Password", "סיסמה")}
            status={L("Managed in the secure sign-in service", "מנוהל בשירות הכניסה המאובטח")}
            action={L("Change password", "שינוי סיסמה")}
            onClick={changePassword}
          />
          <SecRow
            title={L("Two-factor authentication", "אימות דו-שלבי")}
            status={sec?.available ? (mfaOn ? L(`Enabled (${totp} authenticator${totp === 1 ? "" : "s"})`, `פעיל (${totp})`) : L("Not configured", "לא מוגדר")) : L("Status unavailable", "סטטוס לא זמין")}
            badge={sec?.available ? (mfaOn ? "on" : "off") : undefined}
            action={mfaOn ? L("Manage", "ניהול") : L("Enable", "הפעלה")}
            onClick={() => (mfaOn ? setManageMfa(true) : openFlow(AUTHENTIK_FLOWS.totp, L("Two-factor authentication", "אימות דו-שלבי")))}
          />
          <SecRow
            title={L("Passkeys", "מפתחות גישה")}
            status={sec?.available ? (passkeys > 0 ? L(`${passkeys} configured`, `${passkeys} מוגדרים`) : L("None yet", "אין עדיין")) : L("Status unavailable", "סטטוס לא זמין")}
            badge={sec?.available ? (passkeys > 0 ? "on" : undefined) : undefined}
            action={L("Add passkey", "הוספת מפתח")}
            onClick={() => openFlow(AUTHENTIK_FLOWS.passkey, L("Add a passkey", "הוספת מפתח גישה"))}
          />
          <SecRow
            title={L("Recovery codes", "קודי שחזור")}
            status={sec?.available ? (recovery > 0 ? L("Generated", "נוצרו") : L("Not generated", "לא נוצרו")) : L("Status unavailable", "סטטוס לא זמין")}
            action={recovery > 0 ? L("Regenerate", "יצירה מחדש") : L("Generate", "יצירה")}
            onClick={() => openFlow(AUTHENTIK_FLOWS.recoveryCodes, L("Recovery codes", "קודי שחזור"))}
          />
        </div>
        {sec?.lastLogin && (
          <p className="mt-4 text-xs text-gray-400">{L("Last sign-in", "כניסה אחרונה")}: {fmt(sec.lastLogin)}</p>
        )}
      </Card>

      {flow && (
        <SecurityFlowModal
          url={flow.url}
          title={flow.title}
          token={token}
          baseline={(sec?.totp?.length ?? 0) + (sec?.passkeys?.length ?? 0) + (sec?.recoveryCodes?.length ?? 0)}
          L={L}
          onClose={() => { setFlow(null); load(); }}
        />
      )}

      {manageMfa && sec && (
        <ManageMfaModal
          token={token}
          sec={sec}
          L={L}
          onChanged={load}
          onAdd={(slug, title) => { setManageMfa(false); openFlow(slug, title); }}
          onClose={() => { setManageMfa(false); load(); }}
        />
      )}
    </>
  );
}

/**
 * Real MFA management: list the caller's authenticators / passkeys / recovery
 * codes and let them REMOVE any (Authentik's own portal only ever let you add
 * more). Adding a factor hands back to the enrolment flow via `onAdd`.
 */
function ManageMfaModal({ token, sec, L, onChanged, onAdd, onClose }: {
  token: string;
  sec: AccountSecurity;
  L: (en: string, heb: string) => string;
  onChanged: () => void;
  onAdd: (slug: string, title: string) => void;
  onClose: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const totp = sec.totp ?? [];
  const passkeys = sec.passkeys ?? [];
  const recovery = sec.recoveryCodes ?? [];

  async function remove(type: "totp" | "webauthn" | "static", id: string) {
    setBusyId(id); setError(null);
    try {
      await removeMfaDevice(token, type, id);
      onChanged();
    } catch (e: any) {
      setError(e?.message || L("Could not remove this method.", "לא ניתן להסיר אמצעי זה."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-900/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
          <h3 className="text-sm font-semibold text-gray-900">{L("Manage two-factor authentication", "ניהול אימות דו-שלבי")}</h3>
          <button onClick={onClose} aria-label={L("Close", "סגירה")} className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

          <MfaGroup
            title={L("Authenticator apps", "אפליקציות אימות")}
            empty={L("None yet", "אין עדיין")}
            items={totp.map((d) => ({ id: d.id, label: d.name || L("Authenticator", "אפליקציית אימות"), sub: d.createdAt }))}
            busyId={busyId}
            onRemove={(id) => remove("totp", id)}
            addLabel={L("Add authenticator", "הוספת אפליקציה")}
            onAdd={() => onAdd(AUTHENTIK_FLOWS.totp, L("Two-factor authentication", "אימות דו-שלבי"))}
            L={L}
          />
          <MfaGroup
            title={L("Passkeys", "מפתחות גישה")}
            empty={L("None yet", "אין עדיין")}
            items={passkeys.map((d) => ({ id: d.id, label: d.name || L("Passkey", "מפתח גישה"), sub: d.createdAt }))}
            busyId={busyId}
            onRemove={(id) => remove("webauthn", id)}
            addLabel={L("Add passkey", "הוספת מפתח")}
            onAdd={() => onAdd(AUTHENTIK_FLOWS.passkey, L("Add a passkey", "הוספת מפתח גישה"))}
            L={L}
          />
          <MfaGroup
            title={L("Recovery codes", "קודי שחזור")}
            empty={L("Not generated", "לא נוצרו")}
            items={recovery.map((d) => ({ id: d.id, label: d.name || L("Recovery code set", "מערכת קודי שחזור"), sub: null }))}
            busyId={busyId}
            onRemove={(id) => remove("static", id)}
            addLabel={recovery.length > 0 ? L("Regenerate", "יצירה מחדש") : L("Generate", "יצירה")}
            onAdd={() => onAdd(AUTHENTIK_FLOWS.recoveryCodes, L("Recovery codes", "קודי שחזור"))}
            L={L}
          />
        </div>
      </div>
    </div>
  );
}

function MfaGroup({ title, empty, items, busyId, onRemove, addLabel, onAdd, L }: {
  title: string; empty: string;
  items: Array<{ id: string; label: string; sub: string | null }>;
  busyId: string | null; onRemove: (id: string) => void;
  addLabel: string; onAdd: () => void;
  L: (en: string, heb: string) => string;
}) {
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">{title}</p>
        <button onClick={onAdd} className="text-xs font-medium text-primary-600 hover:underline">{addLabel}</button>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-gray-400">{empty}</p>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100">
          {items.map((it) => (
            <li key={it.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm text-gray-800">{it.label}</p>
                {it.sub && <p className="truncate text-[11px] text-gray-400">{fmt(it.sub)}</p>}
              </div>
              <button
                onClick={() => onRemove(it.id)}
                disabled={busyId === it.id}
                className="shrink-0 rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-red-600 transition hover:border-red-300 hover:bg-red-50 disabled:opacity-50"
              >
                {busyId === it.id ? L("Removing…", "מסיר…") : L("Remove", "הסרה")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Renders an Authentik enrolment flow (MFA / passkey / recovery / password)
 * INSIDE the app as a modal iframe. The gateway allows framing from
 * *.gotcha.co.il and the Authentik session cookie is same-site, so the flow
 * runs authenticated without a full-page redirect - it feels like part of GOTCHA.
 */
function SecurityFlowModal({ url, title, onClose, L, token, baseline }: { url: string; title: string; onClose: () => void; L: (en: string, heb: string) => string; token?: string; baseline?: number }) {
  const loadCountRef = useRef(0);
  const [verifying, setVerifying] = useState(false);

  // The iframe navigated. First load = the flow's initial render; any load after
  // means it advanced/completed (and Authentik may have bounced to its own app
  // library). Mask + re-check: if a factor changed, close; the mask hides
  // Authentik's page while we check so it never lingers.
  const onFrameLoad = () => {
    loadCountRef.current += 1;
    if (loadCountRef.current <= 1 || !token || baseline === undefined) return;
    setVerifying(true);
    setTimeout(async () => {
      try {
        const s = await getAccountSecurity(token);
        const count = (s.totp?.length ?? 0) + (s.passkeys?.length ?? 0) + (s.recoveryCodes?.length ?? 0);
        if (count !== baseline) { onClose(); return; }
      } catch { /* fall through */ }
      setVerifying(false);
    }, 500);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // The embedded flow redirects to /auth/flow-done on completion, which posts
    // this message - close (and refresh security state) instead of leaving
    // Authentik's dashboard sitting inside the iframe.
    const onMessage = (e: MessageEvent) => { if (e?.data?.type === FLOW_DONE_MESSAGE) setTimeout(onClose, 500); };
    document.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  // Authentik's setup flows don't honor our `next` redirect, so we can't rely on
  // the flow-done message. Poll the security summary while the modal is open and
  // close as soon as a factor was added/removed - the moment enrolment took, so
  // Authentik's own success screen never lingers in the iframe.
  useEffect(() => {
    if (!token || baseline === undefined) return;
    const iv = setInterval(async () => {
      try {
        const s = await getAccountSecurity(token);
        const count = (s.totp?.length ?? 0) + (s.passkeys?.length ?? 0) + (s.recoveryCodes?.length ?? 0);
        if (count !== baseline) onClose();
      } catch { /* keep polling */ }
    }, 4000);
    return () => clearInterval(iv);
  }, [token, baseline, onClose]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-900/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} aria-label={L("Close", "סגירה")} className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="relative">
          <iframe
            src={url}
            title={title}
            onLoad={onFrameLoad}
            className="h-[560px] w-full border-0"
            // No sandbox: this is our own IdP (auth-dev.gotcha.co.il, same-site),
            // and the flow needs its session cookie, scripts, forms, and storage.
            // Framing is already scoped to *.gotcha.co.il by the gateway CSP.
            allow="publickey-credentials-get *; publickey-credentials-create *; clipboard-write"
          />
          {verifying && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-primary-500" />
              <span className="text-sm font-medium text-gray-500">{L("Finishing up…", "מסיים…")}</span>
            </div>
          )}
        </div>
        <div className="border-t border-gray-100 px-5 py-2.5 text-center">
          <button onClick={onClose} className="text-xs font-medium text-primary-600 hover:underline">
            {L("Done", "סיום")}
          </button>
        </div>
      </div>
    </div>
  );
}

function SecRow({ title, status, action, onClick, badge }: {
  title: string; status: string; action: string; onClick: () => void; badge?: "on" | "off";
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-3.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-gray-800">{title}</p>
          {badge === "on" && <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">ON</span>}
          {badge === "off" && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-500">OFF</span>}
        </div>
        <p className="truncate text-xs text-gray-400">{status}</p>
      </div>
      <button onClick={onClick} className="shrink-0 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:border-primary-300 hover:text-primary-600">
        {action}
      </button>
    </div>
  );
}

// ─── Sessions ────────────────────────────────────────────────

function SessionsSection({ token, L }: { token: string; L: (en: string, heb: string) => string }) {
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    getAccountSessions(token).then((r) => { setSessions(r.sessions); setAvailable(r.available); })
      .catch(() => { setSessions([]); setAvailable(false); });
  }, [token]);
  useEffect(() => { load(); }, [load]);

  async function terminate(id: string) {
    setBusy(id);
    try { await terminateAccountSession(token, id); load(); } finally { setBusy(null); }
  }
  async function terminateAll() {
    setBusy("all");
    try { await terminateAllAccountSessions(token); load(); } finally { setBusy(null); }
  }

  return (
    <Card>
      <div className="flex items-start justify-between">
        <SectionTitle title={L("Active sessions", "סשנים פעילים")} subtitle={L("Devices signed in to your account.", "מכשירים שמחוברים לחשבון.")} />
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={load} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:border-primary-300 hover:text-primary-600" title={L("Refresh", "רענון")}>
            {L("Refresh", "רענון")}
          </button>
          {sessions && sessions.length > 1 && (
            <button onClick={terminateAll} disabled={busy === "all"} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50">
              {/* The server keeps the CURRENT session alive - this signs out every other device. */}
              {L("Sign out other sessions", "יציאה מכל שאר המכשירים")}
            </button>
          )}
        </div>
      </div>
      {!sessions ? <div className="mt-4"><Skeleton /></div> : !available ? (
        <EmptyNote text={L("Session details are temporarily unavailable.", "פרטי הסשנים אינם זמינים כרגע.")} />
      ) : sessions.length === 0 ? (
        <EmptyNote text={L("No active sessions found.", "לא נמצאו סשנים פעילים.")} />
      ) : (
        <ul className="mt-4 space-y-2">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-gray-800">{s.userAgent || L("Unknown device", "מכשיר לא ידוע")}</p>
                  {s.current && <span className="rounded-full bg-primary-100 px-2 py-0.5 text-[10px] font-semibold text-primary-700">{L("This device", "המכשיר הזה")}</span>}
                </div>
                <p className="truncate text-xs text-gray-400">
                  {[s.ip, [s.city, s.country].filter(Boolean).join(", "), s.lastUsed ? `${L("last active", "פעיל לאחרונה")} ${fmt(s.lastUsed)}` : null].filter(Boolean).join(" · ")}
                </p>
              </div>
              {!s.current && (
                <button onClick={() => terminate(s.id)} disabled={busy === s.id} className="shrink-0 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:border-red-300 hover:text-red-600">
                  {busy === s.id ? "…" : L("Sign out", "יציאה")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ─── Login activity ──────────────────────────────────────────

function ActivitySection({ token, L }: { token: string; L: (en: string, heb: string) => string }) {
  const [events, setEvents] = useState<AccountLoginEvent[] | null>(null);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    getAccountLoginHistory(token).then((r) => { setEvents(r.events); setAvailable(r.available); })
      .catch(() => { setEvents([]); setAvailable(false); });
  }, [token]);

  return (
    <Card>
      <SectionTitle title={L("Login activity", "פעילות כניסה")} subtitle={L("Recent sign-in attempts on your account.", "ניסיונות כניסה אחרונים לחשבון.")} />
      {!events ? <div className="mt-4"><Skeleton /></div> : !available ? (
        <EmptyNote text={L("Login history is temporarily unavailable.", "היסטוריית הכניסות אינה זמינה כרגע.")} />
      ) : events.length === 0 ? (
        <EmptyNote text={L("No recent activity recorded.", "לא נרשמה פעילות אחרונה.")} />
      ) : (
        <ul className="mt-4 divide-y divide-gray-100">
          {events.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${e.success ? "bg-green-500" : "bg-red-500"}`} />
                  <p className="text-sm font-medium text-gray-800">
                    {e.success ? L("Successful sign-in", "כניסה מוצלחת") : L("Failed sign-in", "כניסה נכשלה")}
                  </p>
                </div>
                <p className="truncate ps-4 text-xs text-gray-400">
                  {[s2(e.userAgent), s2(e.ip), [e.city, e.country].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}
                </p>
              </div>
              <time className="shrink-0 text-xs text-gray-400">{fmt(e.timestamp)}</time>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ─── Preferences ─────────────────────────────────────────────

function PreferencesSection({ locale, setLocale, L }: {
  locale: string; setLocale: (l: "en" | "he") => Promise<void>; L: (en: string, heb: string) => string;
}) {
  const [savingLocale, setSavingLocale] = useState(false);
  async function changeLocale(next: string) {
    // setLocale already persists the per-user locale override to the backend.
    setSavingLocale(true);
    try { await setLocale(next === "he" ? "he" : "en"); } catch { /* soft */ } finally { setSavingLocale(false); }
  }
  return (
    <Card>
      <SectionTitle title={L("Preferences", "העדפות")} subtitle={L("How GOTCHA looks and talks to you.", "איך GOTCHA נראה ומתקשר איתך.")} />
      <div className="mt-4 divide-y divide-gray-100">
        <div className="flex items-center justify-between py-3.5">
          <div>
            <p className="text-sm font-medium text-gray-800">{L("Language", "שפה")}</p>
            <p className="text-xs text-gray-400">{savingLocale ? L("Saving…", "שומר…") : L("Interface and AI content language.", "שפת הממשק והתוכן.")}</p>
          </div>
          <select value={locale} onChange={(e) => changeLocale(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm">
            <option value="en">English</option>
            <option value="he">עברית</option>
          </select>
        </div>
        <RowLink title={L("Notifications", "התראות")} desc={L("Email and in-app alerts.", "התראות דוא\"ל ובאפליקציה.")} href="/settings/notifications" cta={L("Open", "פתיחה")} />
        <div className="flex items-center justify-between py-3.5 opacity-60">
          <div>
            <p className="text-sm font-medium text-gray-800">{L("Appearance", "מראה")}</p>
            <p className="text-xs text-gray-400">{L("Light theme. Dark mode coming soon.", "ערכת נושא בהירה. מצב כהה בקרוב.")}</p>
          </div>
          <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-semibold text-gray-400">{L("Soon", "בקרוב")}</span>
        </div>
      </div>
    </Card>
  );
}

// ─── Privacy ─────────────────────────────────────────────────

function PrivacySection({ L }: { L: (en: string, heb: string) => string }) {
  return (
    <Card>
      <SectionTitle title={L("Privacy", "פרטיות")} subtitle={L("Your data and your rights.", "המידע שלך והזכויות שלך.")} />
      <div className="mt-4 divide-y divide-gray-100">
        <RowLink title={L("Privacy Policy", "מדיניות פרטיות")} desc={L("How we handle your data.", "כיצד אנו מטפלים במידע שלך.")} href="/privacy-policy" cta={L("Read", "קריאה")} />
        <RowAction
          title={L("Export my data", "ייצוא המידע שלי")}
          desc={L("Request a copy of your personal data.", "בקשת עותק של המידע האישי שלך.")}
          cta={L("Request", "בקשה")}
          href="mailto:privacy@gotcha.co.il?subject=Data%20Export%20Request"
        />
        <RowAction
          title={L("Delete my account", "מחיקת החשבון שלי")}
          desc={L("Ask your workspace admin, or contact us.", "פנו למנהל סביבת העבודה או אלינו.")}
          cta={L("Request", "בקשה")}
          href="mailto:privacy@gotcha.co.il?subject=Account%20Deletion%20Request"
          danger
        />
      </div>
    </Card>
  );
}

// ─── Support ─────────────────────────────────────────────────

function SupportSection({ L, logout }: { L: (en: string, heb: string) => string; logout: () => void }) {
  return (
    <>
      <Card>
        <SectionTitle title={L("Support", "תמיכה")} subtitle={L("We're here to help.", "אנחנו כאן כדי לעזור.")} />
        <div className="mt-4 divide-y divide-gray-100">
          <RowAction title={L("Help center", "מרכז עזרה")} desc={L("Guides and answers.", "מדריכים ותשובות.")} cta={L("Open", "פתיחה")} href="https://help.gotcha.co.il" external />
          <RowAction title={L("Contact support", "יצירת קשר")} desc={L("Reach our team.", "פנייה לצוות.")} cta={L("Email", "דוא\"ל")} href="mailto:support@gotcha.co.il" />
        </div>
      </Card>
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-gray-900">{L("Sign out", "יציאה")}</h2>
            <p className="mt-1 text-xs text-gray-500">{L("Ends your session on this device and the sign-in service.", "סיום החיבור במכשיר זה ובשירות הכניסה.")}</p>
          </div>
          <button onClick={logout} className="rounded-xl border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50">
            {L("Sign out", "יציאה")}
          </button>
        </div>
      </Card>
    </>
  );
}

// ─── Shared bits ─────────────────────────────────────────────

const inputCls = "w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-primary-400 focus:ring-2 focus:ring-primary-100";
const btnPrimary = "inline-flex min-h-[44px] items-center rounded-xl bg-gradient-to-r from-primary-600 to-primary-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:from-primary-700 hover:to-primary-600 disabled:cursor-not-allowed disabled:opacity-50";

function Card({ children }: { children: React.ReactNode }) {
  return <section className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6">{children}</section>;
}
function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <h2 className="font-semibold text-gray-900">{title}</h2>
      {subtitle && <p className="mt-1 text-xs text-gray-500">{subtitle}</p>}
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-gray-500">{label}</span>
      {children}
    </label>
  );
}
function RowLink({ title, desc, href, cta }: { title: string; desc: string; href: string; cta: string }) {
  return (
    <Link href={href} className="flex items-center justify-between py-3.5 group">
      <div><p className="text-sm font-medium text-gray-800 group-hover:text-primary-600">{title}</p><p className="text-xs text-gray-400">{desc}</p></div>
      <span className="text-xs font-medium text-primary-600">{cta} →</span>
    </Link>
  );
}
function RowAction({ title, desc, cta, href, external, danger }: { title: string; desc: string; cta: string; href: string; external?: boolean; danger?: boolean }) {
  return (
    <a href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined} className="flex items-center justify-between py-3.5 group">
      <div><p className={`text-sm font-medium ${danger ? "text-red-600" : "text-gray-800 group-hover:text-primary-600"}`}>{title}</p><p className="text-xs text-gray-400">{desc}</p></div>
      <span className={`text-xs font-medium ${danger ? "text-red-500" : "text-primary-600"}`}>{cta} →</span>
    </a>
  );
}
function EmptyNote({ text }: { text: string }) {
  return <p className="mt-4 rounded-lg bg-gray-50 px-3 py-4 text-center text-xs text-gray-400">{text}</p>;
}
function Skeleton() {
  return <div className="space-y-2"><div className="h-4 w-1/3 animate-pulse rounded bg-gray-100" /><div className="h-4 w-2/3 animate-pulse rounded bg-gray-100" /></div>;
}
function fmt(iso: string): string {
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); } catch { return iso; }
}
function s2(v: string | null): string | null { return v && v.length > 40 ? v.slice(0, 40) + "…" : v; }

// icons
function IconUser() { return <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.5 20.25a8.25 8.25 0 0115 0" /></svg>; }
function IconShield() { return <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" /></svg>; }
function IconDevice() { return <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" /></svg>; }
function IconClock() { return <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>; }
function IconSliders() { return <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" /></svg>; }
function IconLock() { return <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 00-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" /></svg>; }
function IconLife() { return <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M16.712 4.33a9.027 9.027 0 011.652 1.306c.51.51.944 1.064 1.306 1.652M16.712 4.33l-3.448 4.138m3.448-4.138a9.014 9.014 0 00-9.424 0M19.67 7.288l-4.138 3.448m4.138-3.448a9.014 9.014 0 010 9.424m-4.138-5.976a3.736 3.736 0 00-.88-1.388 3.737 3.737 0 00-1.388-.88m2.268 2.268a3.765 3.765 0 010 2.528m-2.268-4.796a3.765 3.765 0 00-2.528 0m4.796 4.796c-.181.506-.475.982-.88 1.388a3.736 3.736 0 01-1.388.88m2.268-2.268l4.138 3.448m0 0a9.027 9.027 0 01-1.306 1.652c-.51.51-1.064.944-1.652 1.306m0 0l-3.448-4.138m3.448 4.138a9.014 9.014 0 01-9.424 0m5.976-4.138a3.765 3.765 0 01-2.528 0m0 0a3.736 3.736 0 01-1.388-.88 3.737 3.737 0 01-.88-1.388m2.268 2.268L7.288 19.67m0 0a9.024 9.024 0 01-1.652-1.306 9.027 9.027 0 01-1.306-1.652m0 0l4.138-3.448M4.33 16.712a9.014 9.014 0 010-9.424m4.138 5.976a3.765 3.765 0 010-2.528m0 0c.181-.506.475-.982.88-1.388a3.736 3.736 0 011.388-.88m-2.268 2.268L4.33 7.288m6.406 1.18L7.288 4.33" /></svg>; }
