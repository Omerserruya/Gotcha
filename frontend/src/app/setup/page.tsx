"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  completeOnboarding,
  getOnboardingStatus,
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

  const [phase, setPhase] = useState<"loading" | "confirm" | "outcome" | "activating">("loading");
  const [error, setError] = useState("");

  const [orgName, setOrgName] = useState("");
  const [chosenLocale, setChosenLocale] = useState<string>(uiLocale || "en");
  const [description, setDescription] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);

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
        // Refreshed after Screen 1 saved? Jump straight to Screen 2.
        if (data.businessProfileCompleted) {
          setPhase("outcome");
        } else {
          setPhase("confirm");
        }
      })
      .catch(() => setPhase("confirm"));
  }, [isLoading, user, token, router]);

  async function handleSaveProfile(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setError("");
    setSavingProfile(true);
    try {
      await saveBusinessProfile(token, {
        organizationName: orgName.trim(),
        businessDescription: description.trim(),
        locale: chosenLocale,
      });
      if (chosenLocale !== uiLocale) {
        await setLocale(chosenLocale as any);
      }
      track("onboarding.screen1_completed");
      setPhase("outcome");
    } catch (err: any) {
      setError(err.message || t("setup.errSaveProfile"));
    } finally {
      setSavingProfile(false);
    }
  }

  async function handlePickOutcome(outcome: Outcome) {
    if (!token) return;
    setError("");
    setPhase("activating");
    try {
      // Stash on the client — MissionPanel + analytics consume it.
      // localStorage is sufficient for MVP; no schema change needed.
      try {
        localStorage.setItem("onboarding.outcome", outcome);
      } catch { /* private-mode safe */ }
      track(`onboarding.outcome_${outcome}`);

      await completeOnboarding(token);
      track("onboarding.entered_app", { outcome });

      const target = OUTCOMES.find((o) => o.id === outcome)?.deepLink ?? "/conversations";
      router.replace(`${target}?outcome=${outcome}`);
    } catch (err: any) {
      setError(err.message || t("setup.errActivate"));
      setPhase("outcome");
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
        {error && (
          <div className="mb-4 p-3 rounded-xl bg-red-50 text-red-600 text-sm">{error}</div>
        )}

        {phase === "confirm" && (
          <form
            onSubmit={handleSaveProfile}
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

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t("setup.oneLineWhatYouDo")}</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
                rows={3}
                maxLength={2000}
                placeholder={t("setup.oneLinePlaceholder")}
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm resize-none"
              />
            </div>

            <button
              type="submit"
              disabled={savingProfile || !orgName.trim() || !description.trim()}
              className="w-full py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition disabled:opacity-50 shadow-lg shadow-primary-500/25"
            >
              {savingProfile ? t("common.loading") : t("setup.confirmAndContinue")}
            </button>
          </form>
        )}

        {phase === "outcome" && (
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-7 space-y-5">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{t("setup.outcomeTitle")}</h1>
              <p className="text-sm text-gray-500 mt-1">{t("setup.outcomeSubtitle")}</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {OUTCOMES.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => handlePickOutcome(o.id)}
                  className="p-4 rounded-xl border border-gray-200 hover:border-primary-400 hover:bg-primary-50/40 transition text-sm font-medium text-gray-800 text-center"
                >
                  {t(o.titleKey)}
                </button>
              ))}
            </div>

            <p className="text-xs text-gray-400 text-center">{t("setup.outcomeFooter")}</p>
          </div>
        )}
      </div>
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
