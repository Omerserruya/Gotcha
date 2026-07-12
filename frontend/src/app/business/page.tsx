"use client";

// "Your Business" — the permanent home of the Digital Twin (audit finding P-1).
//
// Onboarding builds the twin once; this page renders it for the life of the
// account. Same data (discovery + health), same confidence-levelled portrait,
// same corrections + gap-teaching, plus the living recommendation backlog with
// an in-app home. Nothing about the twin is thrown away after activation.

import { useCallback, useEffect, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
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
  type BusinessDiscoveryRecord,
  type HealthReport,
  type DiscoveryGap,
  type RecommendationRow,
} from "@/lib/api";

export default function BusinessPage() {
  return (
    <AppLayout>
      <BusinessInner />
    </AppLayout>
  );
}

function BusinessInner() {
  const { token } = useAuth();
  const { locale } = useI18n();
  const he = locale === "he";

  const [loading, setLoading] = useState(true);
  const [disc, setDisc] = useState<BusinessDiscoveryRecord | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [gaps, setGaps] = useState<DiscoveryGap[]>([]);
  const [recs, setRecs] = useState<RecommendationRow[]>([]);

  const loadHealth = useCallback(async () => {
    if (!token) return;
    try {
      const r = await getBusinessHealth(token);
      setHealth(r.data.health);
      setGaps(r.data.gaps || []);
    } catch { /* non-blocking */ }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    (async () => {
      const [d, r] = await Promise.all([
        getBusinessDiscovery(token).catch(() => null),
        getRecommendations(token, "OPEN").catch(() => null),
      ]);
      if (!alive) return;
      const discovery = d?.data.discovery || null;
      setDisc(discovery);
      if (discovery) setGaps(discovery.gaps || []);
      setRecs(r?.data.recommendations || []);
      await loadHealth();
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, loadHealth]);

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
        <p className="text-sm text-gray-500 mt-2">{he ? "השלימו את ההגדרה ואחקור את העסק שלכם — ואז הפרופיל החי יופיע כאן." : "Finish setup and I'll investigate your business — your living profile will then live here."}</p>
        <a href="/setup" className="inline-block mt-5 px-6 py-2.5 bg-primary-500 hover:bg-primary-600 text-white text-sm font-medium rounded-xl">{he ? "להגדרה ←" : "Go to setup →"}</a>
      </div>
    );
  }

  return (
    <div className="max-w-3xl w-full mx-auto px-4 py-8 md:py-12 space-y-6">
      <BusinessTwin he={he} disc={disc} health={health} gaps={gaps} onCorrect={onCorrect} onTeach={onTeach} />
      <RecommendationsHub he={he} recs={recs} onResolve={(id) => resolveRec(id, "complete")} onDismiss={(id) => resolveRec(id, "dismiss")} />
    </div>
  );
}
