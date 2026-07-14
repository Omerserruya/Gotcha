"use client";

// "Your Business" - the permanent home of the Digital Twin, re-homed under
// Settings (the main sidebar slot went to Getting Started). Same living
// profile + recommendation backlog, plus a "Scan again" action that re-runs
// the discovery engine and refreshes everything (the /discover route already
// guards concurrent scans and keeps the last good report until the new one
// lands, so this is safe to expose).

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { BusinessTwin, RecommendationsHub } from "@/components/business/BusinessTwin";
import {
  getBusinessDiscovery,
  getBusinessHealth,
  getRecommendations,
  correctDiscovery,
  teachGap,
  resolveRecommendation,
  discoverBusiness,
  type BusinessDiscoveryRecord,
  type HealthReport,
  type DiscoveryGap,
  type RecommendationRow,
} from "@/lib/api";

export default function SettingsBusinessPage() {
  const { token } = useAuth();
  const { locale } = useI18n();
  const he = locale === "he";

  const [loading, setLoading] = useState(true);
  const [disc, setDisc] = useState<BusinessDiscoveryRecord | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [gaps, setGaps] = useState<DiscoveryGap[]>([]);
  const [recs, setRecs] = useState<RecommendationRow[]>([]);
  const [rescanning, setRescanning] = useState(false);
  const [rescanError, setRescanError] = useState("");
  const pollRef = useRef<number | null>(null);

  const loadHealth = useCallback(async () => {
    if (!token) return;
    try {
      const r = await getBusinessHealth(token);
      setHealth(r.data.health);
      setGaps(r.data.gaps || []);
    } catch { /* non-blocking */ }
  }, [token]);

  const loadAll = useCallback(async () => {
    if (!token) return;
    const [d, r] = await Promise.all([
      getBusinessDiscovery(token).catch(() => null),
      getRecommendations(token, "OPEN").catch(() => null),
    ]);
    const discovery = d?.data.discovery || null;
    setDisc(discovery);
    if (discovery) setGaps(discovery.gaps || []);
    setRecs(r?.data.recommendations || []);
    await loadHealth();
    setLoading(false);
    return discovery;
  }, [token, loadHealth]);

  useEffect(() => {
    loadAll();
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [loadAll]);

  // Re-scan: kick /discover with the known domain, then poll until the scan
  // finishes and reload the whole page state. The prior report stays readable
  // server-side, so a failed re-scan never loses the profile.
  const rescan = useCallback(async () => {
    const domain = disc?.websiteDomain;
    if (!token || !domain || rescanning) return;
    setRescanning(true);
    setRescanError("");
    try {
      const r = await discoverBusiness(token, domain, locale);
      if (!r.data.ok && r.data.reason !== "scan_in_progress") {
        setRescanError(he ? "הסריקה נכשלה - נסו שוב בעוד רגע." : "The scan failed - try again in a moment.");
        setRescanning(false);
        return;
      }
      let ticks = 0;
      pollRef.current = window.setInterval(async () => {
        ticks += 1;
        try {
          const d = await getBusinessDiscovery(token);
          const status = d.data.discovery?.status;
          if (status !== "SCANNING" || ticks > 80) {
            if (pollRef.current) window.clearInterval(pollRef.current);
            await loadAll();
            setRescanning(false);
            if (status === "FAILED") {
              setRescanError(he ? "הסריקה נכשלה - הפרופיל הקודם נשמר." : "The scan failed - your previous profile is intact.");
            }
          }
        } catch { /* keep polling */ }
      }, 2500);
    } catch (e: any) {
      setRescanError(e?.message || (he ? "הסריקה נכשלה." : "Scan failed."));
      setRescanning(false);
    }
  }, [token, disc?.websiteDomain, rescanning, locale, he, loadAll]);

  const onCorrect = useCallback(async (target: "channel" | "tool" | "platform" | "gap", action: "remove" | "incorrect" | "ignore", key: string) => {
    if (!token) return;
    setDisc((prev) => {
      if (!prev) return prev;
      if (target === "channel") return { ...prev, communication: { channels: (prev.communication?.channels || []).filter((c) => c.type !== key) } };
      if (target === "gap") return { ...prev, gaps: (prev.gaps || []).filter((g) => g.label !== key) };
      const t = prev.technology;
      if (!t) return prev;
      if (target === "platform") return { ...prev, technology: { ...t, platform: null } };
      return { ...prev, technology: { ...t, tools: (t.tools || []).filter((x) => x.slug !== key), legacy: (t.legacy || []).filter((x) => x.slug !== key), tracking: (t.tracking || []).filter((x) => x.slug !== key) } };
    });
    if (target === "gap") setGaps((prev) => prev.filter((g) => g.label !== key));
    await correctDiscovery(token, target, action, key).catch(() => {});
  }, [token]);

  const onTeach = useCallback(async (label: string, method: "text" | "url", value: string): Promise<boolean> => {
    if (!token) return false;
    try {
      const res = await teachGap(token, label, method, value);
      if (!res.data.ok) return false;
      setDisc((prev) => (prev ? { ...prev, gaps: (prev.gaps || []).filter((g) => g.label !== label) } : prev));
      setGaps((prev) => prev.filter((g) => g.label !== label));
      await loadHealth();
      return true;
    } catch { return false; }
  }, [token, loadHealth]);

  const resolveRec = useCallback(async (id: string, decision: "complete" | "dismiss") => {
    if (!token) return;
    setRecs((prev) => prev.filter((r) => r.id !== id));
    await resolveRecommendation(token, id, decision).catch(() => {});
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-primary-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!disc || disc.status === "PENDING") {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center" dir={he ? "rtl" : "ltr"}>
        <div className="w-14 h-14 mx-auto rounded-2xl bg-primary-50 text-primary-500 flex items-center justify-center text-2xl mb-4">🔎</div>
        <h1 className="text-2xl font-bold text-gray-900">{he ? "עוד לא בניתי את פרופיל העסק" : "I haven't built your business profile yet"}</h1>
        <p className="text-sm text-gray-500 mt-2">{he ? "השלימו את ההגדרה ואחקור את העסק שלכם - ואז הפרופיל החי יופיע כאן." : "Finish setup and I'll investigate your business - your living profile will then live here."}</p>
        <a href="/setup" className="inline-block mt-5 px-6 py-2.5 bg-primary-500 hover:bg-primary-600 text-white text-sm font-medium rounded-xl">{he ? "להגדרה ←" : "Go to setup →"}</a>
      </div>
    );
  }

  return (
    <div className="max-w-3xl w-full mx-auto px-4 py-8 md:py-12 space-y-6 overflow-y-auto h-full">
      {/* Header + re-scan */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-900">{he ? "העסק שלכם" : "Your Business"}</h1>
          {disc.websiteDomain && <p className="text-xs text-gray-400">{disc.websiteDomain}</p>}
        </div>
        {disc.websiteDomain && (
          <button
            onClick={rescan}
            disabled={rescanning}
            className="flex items-center gap-2 rounded-xl border border-primary-200 bg-white px-4 py-2 text-sm font-medium text-primary-600 transition hover:bg-primary-50 disabled:opacity-50"
          >
            <svg className={"w-4 h-4 " + (rescanning ? "animate-spin" : "")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
            {rescanning
              ? (he ? "סורק מחדש…" : "Re-scanning…")
              : (he ? "סריקה מחודשת" : "Scan again")}
          </button>
        )}
      </div>
      {rescanning && (
        <p className="text-xs text-primary-600 bg-primary-50 rounded-xl px-3 py-2">
          {he
            ? "סורק את האתר מחדש ומעדכן את הפרופיל, הבריאות וההמלצות - זה לוקח בערך דקה. הפרופיל הקודם נשמר עד שהסריקה מסתיימת."
            : "Re-scanning your site and refreshing the profile, health and recommendations - takes about a minute. Your current profile stays intact until it finishes."}
        </p>
      )}
      {rescanError && <p className="text-xs text-rose-600 bg-rose-50 rounded-xl px-3 py-2">{rescanError}</p>}

      <BusinessTwin he={he} disc={disc} health={health} gaps={gaps} onCorrect={onCorrect} onTeach={onTeach} />
      <RecommendationsHub he={he} recs={recs} onResolve={(id) => resolveRec(id, "complete")} onDismiss={(id) => resolveRec(id, "dismiss")} />
    </div>
  );
}
