"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  analyzeBusinessDomain,
  completeOnboarding,
  createInviteLink,
  getOnboardingStatus,
  inviteTeam,
  saveBusinessProfile,
} from "@/lib/api";

type Outcome = "reply_faster" | "qualify_leads" | "handle_calls";

const OUTCOMES: Array<{ id: Outcome; titleKey: string; deepLink: string }> = [
  { id: "reply_faster", titleKey: "setup.outcomes.replyFaster", deepLink: "/conversations" },
  { id: "qualify_leads", titleKey: "setup.outcomes.qualifyLeads", deepLink: "/conversations" },
  { id: "handle_calls", titleKey: "setup.outcomes.handleCalls", deepLink: "/channels" },
];

const LOCALE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "he", label: "עברית" },
];

type Phase =
  | "loading"
  | "confirm"      // Org name + locale
  | "domain"       // Ask for domain, AI-analyze, confirm description
  | "goals"        // Multi-select goals
  | "invite"       // Team invites (optional)
  | "activating";

export default function SetupPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <SetupContent />
    </Suspense>
  );
}

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="animate-spin w-8 h-8 border-4 border-primary-500 border-t-transparent rounded-full" />
    </div>
  );
}

function SetupContent() {
  const { user, token, isLoading } = useAuth();
  const { t, locale: uiLocale, setLocale } = useI18n();
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");

  // Step 1: org + locale
  const [orgName, setOrgName] = useState("");
  const [chosenLocale, setChosenLocale] = useState<string>(uiLocale || "en");
  const [savingProfile, setSavingProfile] = useState(false);

  // Step 2: domain + AI suggestion
  const [domain, setDomain] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [domainTried, setDomainTried] = useState(false);
  const [suggestion, setSuggestion] = useState<string>("");
  const [description, setDescription] = useState("");
  const [editingSuggestion, setEditingSuggestion] = useState(false);
  const [manualFallback, setManualFallback] = useState(false);

  // Step 3: multi-select goals
  const [goals, setGoals] = useState<Outcome[]>([]);

  // Step 4: invites
  const [inviteEmails, setInviteEmails] = useState("");
  const [inviteSending, setInviteSending] = useState(false);
  const [inviteResults, setInviteResults] = useState<Array<{ email: string; status: string }> | null>(null);
  const [inviteLink, setInviteLink] = useState<string>("");
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    if (isLoading) return;
    if (!user || !token) {
      router.push("/login?redirect=setup");
      return;
    }
    if (user.role !== "ADMIN") {
      router.push("/conversations");
      return;
    }

    getOnboardingStatus(token)
      .then((res) => {
        const data = res.data;
        if (data.tenant?.status === "ACTIVE") {
          router.push("/conversations");
          return;
        }
        if (data.tenant?.name) setOrgName(data.tenant.name);
        // The user may also have an email — pre-seed domain guess from it.
        if (user?.email && !domain) {
          const at = user.email.split("@")[1];
          if (at && at !== "gmail.com" && at !== "yahoo.com" && at !== "outlook.com") {
            setDomain(at);
          }
        }
        // Refreshed past Screen 1? Skip directly to domain step.
        if (data.businessProfileCompleted) {
          setPhase("domain");
        } else {
          setPhase("confirm");
        }
      })
      .catch(() => setPhase("confirm"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, user, token, router]);

  // ── Step 1: save org name + locale (description filled later) ──
  async function handleSaveOrg(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setError("");
    setSavingProfile(true);
    try {
      // Persist a minimal profile now — description will be patched in step 2.
      await saveBusinessProfile(token, {
        organizationName: orgName.trim(),
        businessDescription: orgName.trim(), // placeholder; replaced in step 2
        locale: chosenLocale,
      });
      if (chosenLocale !== uiLocale) {
        await setLocale(chosenLocale as any);
      }
      track("onboarding.screen1_completed");
      setPhase("domain");
    } catch (err: any) {
      setError(err.message || t("setup.errSaveProfile"));
    } finally {
      setSavingProfile(false);
    }
  }

  // ── Step 2: analyze domain → AI suggestion ──
  async function runDomainAnalysis() {
    if (!token || !domain.trim()) return;
    setAnalyzing(true);
    setError("");
    setSuggestion("");
    setManualFallback(false);
    try {
      const res = await analyzeBusinessDomain(token, domain.trim(), uiLocale);
      const data = res.data;
      setDomainTried(true);
      if (data.ok && data.description) {
        setSuggestion(data.description);
        setDescription(data.description);
        setEditingSuggestion(false);
      } else {
        // AI/fetch failed → fall back to manual input.
        setManualFallback(true);
      }
    } catch {
      setDomainTried(true);
      setManualFallback(true);
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleConfirmDescription() {
    if (!token || !description.trim()) return;
    setError("");
    setSavingProfile(true);
    try {
      await saveBusinessProfile(token, {
        organizationName: orgName.trim(),
        businessDescription: description.trim(),
        websiteDomain: domain.trim() || undefined,
        locale: chosenLocale,
      });
      track("onboarding.domain_confirmed", { fromAi: !manualFallback });
      setPhase("goals");
    } catch (err: any) {
      setError(err.message || t("setup.errSaveProfile"));
    } finally {
      setSavingProfile(false);
    }
  }

  // ── Step 3: multi-select goals ──
  function toggleGoal(g: Outcome) {
    setGoals((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));
  }
  async function handleSaveGoals() {
    if (!token || goals.length === 0) return;
    setError("");
    setSavingProfile(true);
    try {
      await saveBusinessProfile(token, {
        organizationName: orgName.trim(),
        businessDescription: description.trim() || orgName.trim(),
        businessGoals: goals,
        websiteDomain: domain.trim() || undefined,
        locale: chosenLocale,
      });
      try {
        // Stash for MissionPanel + post-onboarding tour focus.
        localStorage.setItem("onboarding.goals", JSON.stringify(goals));
      } catch { /* private-mode safe */ }
      track("onboarding.goals_selected", { goals });
      setPhase("invite");
    } catch (err: any) {
      setError(err.message || t("setup.errSaveProfile"));
    } finally {
      setSavingProfile(false);
    }
  }

  // ── Step 4: invite team ──
  async function handleSendInvites() {
    if (!token) return;
    const emails = inviteEmails
      .split(/[,\n;\s]+/)
      .map((e) => e.trim())
      .filter((e) => /.+@.+\..+/.test(e));
    if (emails.length === 0) {
      setError("No valid emails detected — separate with commas or newlines.");
      return;
    }
    setError("");
    setInviteSending(true);
    try {
      const res = await inviteTeam(token, emails);
      setInviteResults(res.data.results);
      track("onboarding.invites_sent", { count: res.data.results.filter(r => r.status === "sent").length });
    } catch (err: any) {
      setError(err.message || "Couldn't send invites.");
    } finally {
      setInviteSending(false);
    }
  }
  async function ensureInviteLink() {
    if (!token || inviteLink) return;
    try {
      const res = await createInviteLink(token);
      setInviteLink(res.data.url);
    } catch (err: any) {
      setError(err.message || "Couldn't generate invite link.");
    }
  }
  async function copyInviteLink() {
    if (!inviteLink) await ensureInviteLink();
    const url = inviteLink || (await createInviteLink(token!).then((r) => r.data.url).catch(() => ""));
    if (!url) return;
    try { await navigator.clipboard.writeText(url); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 1800); } catch { /* clipboard may be blocked */ }
  }
  async function handleFinish() {
    if (!token) return;
    setError("");
    setPhase("activating");
    try {
      await completeOnboarding(token);
      try {
        // Flag for the dashboard to launch the guided tour on first arrival.
        localStorage.setItem("onboarding.launchTour", "1");
      } catch { /* private-mode safe */ }
      const target = goals[0]
        ? OUTCOMES.find((o) => o.id === goals[0])?.deepLink ?? "/conversations"
        : "/conversations";
      const qs = goals.length > 0 ? `?outcome=${goals[0]}&tour=1` : "?tour=1";
      router.replace(`${target}${qs}`);
    } catch (err: any) {
      setError(err.message || t("setup.errActivate"));
      setPhase("invite");
    }
  }

  if (phase === "loading" || isLoading) return <LoadingScreen />;

  if (phase === "activating") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900">{t("setup.preparingWorkspace")}</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-8">
      <div className="max-w-lg w-full">
        <StepDots phase={phase} />

        {error && (
          <div className="mb-4 p-3 rounded-xl bg-red-50 text-red-600 text-sm">{error}</div>
        )}

        {phase === "confirm" && (
          <form
            onSubmit={handleSaveOrg}
            className="bg-white rounded-2xl shadow-lg border border-gray-100 p-7 space-y-5"
          >
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{t("setup.confirmTitle")}</h1>
              <p className="text-sm text-gray-500 mt-1">{t("setup.confirmSubtitle")}</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t("setup.orgName")}</label>
              <input
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                required
                maxLength={200}
                autoFocus
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t("setup.language")}</label>
              <select
                value={chosenLocale}
                onChange={(e) => setChosenLocale(e.target.value)}
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm"
              >
                {LOCALE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              disabled={savingProfile || !orgName.trim()}
              className="w-full py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition disabled:opacity-50 shadow-lg shadow-primary-500/25"
            >
              {savingProfile ? t("common.loading") : t("setup.confirmAndContinue")}
            </button>
          </form>
        )}

        {phase === "domain" && (
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-7 space-y-5">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                {uiLocale === "he" ? "מה האתר שלכם?" : "What's your website?"}
              </h1>
              <p className="text-sm text-gray-500 mt-1">
                {uiLocale === "he"
                  ? "ננסה לסכם את העסק שלכם אוטומטית. תוכלו לאשר או לערוך."
                  : "We'll try to summarize what you do automatically. You can confirm or edit."}
              </p>
            </div>

            {!suggestion && !manualFallback && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {uiLocale === "he" ? "כתובת אתר" : "Website domain"}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={domain}
                      onChange={(e) => setDomain(e.target.value)}
                      placeholder="acme.com"
                      autoFocus
                      className="flex-1 px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm"
                    />
                    <button
                      type="button"
                      onClick={runDomainAnalysis}
                      disabled={analyzing || !domain.trim()}
                      className="px-4 py-2.5 bg-primary-500 hover:bg-primary-600 text-white text-sm font-medium rounded-xl transition disabled:opacity-50"
                    >
                      {analyzing
                        ? (uiLocale === "he" ? "סורק..." : "Analyzing…")
                        : (uiLocale === "he" ? "סרוק" : "Analyze")}
                    </button>
                  </div>
                </div>

                <div className="text-center">
                  <button
                    type="button"
                    onClick={() => { setManualFallback(true); setDomainTried(true); }}
                    className="text-xs text-gray-400 hover:text-gray-600"
                  >
                    {uiLocale === "he" ? "אין לי אתר — אכתוב ידנית" : "No website — I'll write it manually"}
                  </button>
                </div>
              </>
            )}

            {suggestion && !editingSuggestion && (
              <div className="space-y-4">
                <div className="rounded-xl border border-violet-200 bg-violet-50/50 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-violet-600 mb-1.5">
                    {uiLocale === "he" ? "ניסיון לסיכום:" : "AI suggestion:"}
                  </div>
                  <p className="text-sm text-gray-800 leading-relaxed">{suggestion}</p>
                </div>
                <p className="text-sm text-gray-700 font-medium">
                  {uiLocale === "he" ? "האם זה באמת מה שאתם עושים?" : "Is this what you actually do?"}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleConfirmDescription}
                    disabled={savingProfile}
                    className="flex-1 py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition disabled:opacity-50"
                  >
                    {savingProfile ? t("common.loading") : (uiLocale === "he" ? "כן, ממשיכים" : "Yes — continue")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingSuggestion(true)}
                    className="px-4 py-3 border border-gray-200 text-gray-700 hover:bg-gray-50 text-sm rounded-xl"
                  >
                    {uiLocale === "he" ? "ערוך" : "Edit"}
                  </button>
                </div>
              </div>
            )}

            {(editingSuggestion || manualFallback) && (
              <div className="space-y-4">
                {manualFallback && !suggestion && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-800">
                    {uiLocale === "he"
                      ? "לא הצלחנו לסרוק את האתר. כתבו בקצרה מה אתם עושים."
                      : "We couldn't analyze the site. Tell us briefly what you do."}
                  </div>
                )}
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder={t("setup.oneLinePlaceholder")}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm resize-none"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={handleConfirmDescription}
                  disabled={savingProfile || !description.trim()}
                  className="w-full py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition disabled:opacity-50"
                >
                  {savingProfile ? t("common.loading") : (uiLocale === "he" ? "המשך" : "Continue")}
                </button>
              </div>
            )}
          </div>
        )}

        {phase === "goals" && (
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-7 space-y-5">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{t("setup.outcomeTitle")}</h1>
              <p className="text-sm text-gray-500 mt-1">
                {uiLocale === "he"
                  ? "בחרו את כל מה שרלוונטי — אפשר יותר מאחד."
                  : "Pick anything that fits — you can choose more than one."}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {OUTCOMES.map((o) => {
                const active = goals.includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => toggleGoal(o.id)}
                    className={
                      "p-4 rounded-xl border text-sm font-medium text-center transition " +
                      (active
                        ? "border-primary-400 bg-primary-50 text-primary-700 ring-2 ring-primary-200"
                        : "border-gray-200 text-gray-800 hover:border-primary-300 hover:bg-primary-50/30")
                    }
                  >
                    <div className="flex flex-col items-center gap-2">
                      <div className={"w-5 h-5 rounded-md border flex items-center justify-center " + (active ? "bg-primary-500 border-primary-500" : "bg-white border-gray-300")}>
                        {active && (
                          <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                      <span>{t(o.titleKey)}</span>
                    </div>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={handleSaveGoals}
              disabled={savingProfile || goals.length === 0}
              className="w-full py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition disabled:opacity-50 shadow-lg shadow-primary-500/25"
            >
              {savingProfile ? t("common.loading") : (uiLocale === "he" ? "המשך" : "Continue")}
            </button>

            <p className="text-xs text-gray-400 text-center">{t("setup.outcomeFooter")}</p>
          </div>
        )}

        {phase === "invite" && (
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-7 space-y-5">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                {uiLocale === "he" ? "להזמין את הצוות?" : "Invite your team"}
              </h1>
              <p className="text-sm text-gray-500 mt-1">
                {uiLocale === "he"
                  ? "אופציונלי — תוכלו לדלג ולהזמין מאוחר יותר מההגדרות."
                  : "Optional — you can skip this and invite from Settings later."}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {uiLocale === "he" ? "כתובות אימייל" : "Teammate emails"}
              </label>
              <textarea
                value={inviteEmails}
                onChange={(e) => setInviteEmails(e.target.value)}
                rows={3}
                placeholder={uiLocale === "he"
                  ? "alice@company.com, bob@company.com"
                  : "alice@company.com, bob@company.com"}
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm resize-none"
              />
              <p className="mt-1 text-xs text-gray-400">
                {uiLocale === "he" ? "הפרידו בפסיקים או שורות חדשות" : "Separate by commas or new lines"}
              </p>
            </div>

            <button
              type="button"
              onClick={handleSendInvites}
              disabled={inviteSending || !inviteEmails.trim()}
              className="w-full py-2.5 bg-white border border-primary-200 hover:bg-primary-50 text-primary-700 text-sm font-medium rounded-xl transition disabled:opacity-50"
            >
              {inviteSending
                ? (uiLocale === "he" ? "שולח..." : "Sending…")
                : (uiLocale === "he" ? "שלח הזמנות במייל" : "Send email invites")}
            </button>

            {inviteResults && (
              <div className="rounded-xl border border-gray-100 p-3 space-y-1">
                {inviteResults.map((r) => (
                  <div key={r.email} className="flex items-center justify-between text-xs">
                    <span className="text-gray-700">{r.email}</span>
                    <span className={
                      r.status === "sent" ? "text-green-600" :
                      r.status === "exists" ? "text-amber-600" : "text-red-600"
                    }>
                      {r.status === "sent" ? (uiLocale === "he" ? "נשלח" : "Sent") :
                       r.status === "exists" ? (uiLocale === "he" ? "כבר חבר" : "Already a member") :
                       (uiLocale === "he" ? "נכשל" : "Failed")}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="border-t border-gray-100 pt-4 space-y-2">
              <p className="text-sm font-medium text-gray-700">
                {uiLocale === "he" ? "או שתף קישור הזמנה:" : "Or share an invite link:"}
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={inviteLink || (uiLocale === "he" ? "לחצו ליצירה" : "Click to generate")}
                  onClick={ensureInviteLink}
                  className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-xs text-gray-700"
                />
                <button
                  type="button"
                  onClick={copyInviteLink}
                  className="px-3 py-2 bg-gray-900 text-white text-xs rounded-xl hover:bg-gray-800 transition"
                >
                  {linkCopied
                    ? (uiLocale === "he" ? "הועתק!" : "Copied!")
                    : (uiLocale === "he" ? "העתק" : "Copy")}
                </button>
              </div>
              <p className="text-[10px] text-gray-400">
                {uiLocale === "he" ? "תקף ל-14 ימים" : "Valid for 14 days"}
              </p>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={handleFinish}
                className="flex-1 py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition shadow-lg shadow-primary-500/25"
              >
                {uiLocale === "he" ? "סיים והכנס" : "Finish & enter app"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StepDots({ phase }: { phase: Phase }) {
  const steps: Phase[] = ["confirm", "domain", "goals", "invite"];
  const idx = steps.indexOf(phase);
  if (idx < 0) return null;
  return (
    <div className="flex items-center justify-center gap-1.5 mb-5">
      {steps.map((_, i) => (
        <div
          key={i}
          className={
            "h-1.5 rounded-full transition-all " +
            (i < idx ? "bg-primary-500 w-6" : i === idx ? "bg-primary-400 w-8" : "bg-gray-200 w-1.5")
          }
        />
      ))}
    </div>
  );
}

function track(event: string, props?: Record<string, unknown>) {
  try {
    const w = window as unknown as { analytics?: { track?: (e: string, p?: unknown) => void } };
    w.analytics?.track?.(event, props);
  } catch {
    /* analytics is best-effort */
  }
}
