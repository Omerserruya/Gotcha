"use client";

// FeatureGuides - the persistent, per-feature first-time guidance layer.
//
// Unlike a one-shot tour, this is a standing layer: the FIRST time a user
// opens a feature surface (Knowledge Base, AI Employees, Workflows,
// Settings) it highlights the key action with a "click here to add…"
// coachmark. Every guide can be Skipped (done) or deferred with "Show me
// later" (snoozed → re-surfaces next session). State is per-user in the DB
// (User.onboardingGuides) so it survives devices and never replays a guide
// the user already finished.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getOnboardingGuides, patchOnboardingGuide, type GuideState } from "@/lib/api";

interface GuideStep {
  selector: string;        // data-tour anchor; falls back to centered if missing
  title: [string, string]; // [en, he]
  body: [string, string];
  placement?: "bottom" | "top" | "left" | "right" | "auto";
}
interface Feature {
  key: string;
  match: (path: string) => boolean;
  steps: GuideStep[];
}

// Order matters - more specific paths first.
const FEATURES: Feature[] = [
  {
    key: "knowledge",
    match: (p) => p.startsWith("/ai-studio/knowledge") || p.startsWith("/knowledge"),
    steps: [
      {
        selector: '[data-tour="kb-add-source"]',
        title: ["Knowledge Base", "מאגר ידע"],
        body: [
          "Click here to add your first source - a document, FAQ, or URL. Your AI answers from this.",
          "לחצו כאן כדי להוסיף מקור ראשון - מסמך, שאלות נפוצות או קישור. ה-AI עונה לפי זה.",
        ],
      },
    ],
  },
  {
    key: "ai-studio",
    match: (p) => p === "/ai-studio" || p.startsWith("/ai-studio/agents"),
    steps: [
      {
        selector: '[data-tour="create-ai-employee"]',
        title: ["AI Employees", "עובדי AI"],
        body: [
          "Click here to create your first AI Employee. It handles conversations using your business + source system.",
          "לחצו כאן כדי ליצור עובד AI ראשון. הוא מנהל שיחות לפי העסק ומערכת הליבה שלכם.",
        ],
      },
    ],
  },
  {
    key: "workflows",
    match: (p) => p.startsWith("/ai-studio/flows"),
    steps: [
      {
        selector: '[data-tour="new-workflow"]',
        title: ["Workflows", "תהליכי עבודה"],
        body: [
          "Click here to build a workflow - automate routing, actions and follow-ups.",
          "לחצו כאן כדי לבנות תהליך - אוטומציה של ניתוב, פעולות ומעקבים.",
        ],
      },
    ],
  },
  {
    key: "settings",
    match: (p) => p.startsWith("/settings"),
    steps: [
      {
        selector: '[data-tour="invite-teammate"]',
        title: ["Invite your team", "הזמינו את הצוות"],
        body: [
          "Click here to invite teammates so they can handle conversations alongside your AI.",
          "לחצו כאן כדי להזמין חברי צוות שיטפלו בשיחות לצד ה-AI.",
        ],
      },
    ],
  },
];

interface Rect { top: number; left: number; width: number; height: number; }

export function FeatureGuides() {
  const { token } = useAuth();
  const { locale } = useI18n();
  const lang = locale === "he" ? 1 : 0;
  const pathname = usePathname();

  const [guides, setGuides] = useState<Record<string, GuideState> | null>(null);
  const sessionHidden = useRef<Set<string>>(new Set()); // snoozed/dismissed this session
  const [activeFeature, setActiveFeature] = useState<Feature | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [missing, setMissing] = useState(false);
  const retryRef = useRef<number | null>(null);

  // Load per-user guide states once.
  useEffect(() => {
    if (!token) return;
    getOnboardingGuides(token)
      .then((res) => setGuides(res.data.guides || {}))
      .catch(() => setGuides({}));
  }, [token]);

  // Decide whether to show a guide for the current route.
  useEffect(() => {
    if (!guides) return;
    const feature = FEATURES.find((f) => f.match(pathname || ""));
    if (!feature) { setActiveFeature(null); return; }
    const state = guides[feature.key];
    if (state === "done") { setActiveFeature(null); return; }
    if (sessionHidden.current.has(feature.key)) { setActiveFeature(null); return; }
    setStepIdx(0);
    setActiveFeature(feature);
  }, [guides, pathname]);

  const step = activeFeature?.steps[stepIdx] || null;

  const measure = useCallback(() => {
    if (!step) { setRect(null); setMissing(false); return; }
    const el = document.querySelector(step.selector) as HTMLElement | null;
    if (!el) { setRect(null); setMissing(true); return; }
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    setMissing(false);
  }, [step]);

  useEffect(() => {
    if (!activeFeature) return;
    measure();
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => { window.removeEventListener("resize", onResize); window.removeEventListener("scroll", onResize, true); };
  }, [activeFeature, stepIdx, measure]);

  // Retry locating the anchor (~4s) - it may mount after the route settles.
  useEffect(() => {
    if (!activeFeature || !step) return;
    if (retryRef.current) window.clearInterval(retryRef.current);
    let tries = 0;
    retryRef.current = window.setInterval(() => {
      tries += 1;
      const el = document.querySelector(step.selector) as HTMLElement | null;
      if (el) { measure(); if (retryRef.current) window.clearInterval(retryRef.current); }
      else if (tries >= 20) { setMissing(true); if (retryRef.current) window.clearInterval(retryRef.current); }
    }, 200);
    return () => { if (retryRef.current) window.clearInterval(retryRef.current); };
  }, [activeFeature, stepIdx, step, measure]);

  const persist = useCallback((state: GuideState) => {
    if (!activeFeature || !token) return;
    setGuides((g) => ({ ...(g || {}), [activeFeature.key]: state }));
    patchOnboardingGuide(token, activeFeature.key, state).catch(() => {});
  }, [activeFeature, token]);

  const done = useCallback(() => { persist("done"); setActiveFeature(null); }, [persist]);
  const snooze = useCallback(() => {
    if (activeFeature) sessionHidden.current.add(activeFeature.key);
    persist("snoozed");
    setActiveFeature(null);
  }, [activeFeature, persist]);
  const next = useCallback(() => {
    if (!activeFeature) return;
    if (stepIdx >= activeFeature.steps.length - 1) { done(); return; }
    setStepIdx((i) => i + 1);
  }, [activeFeature, stepIdx, done]);

  const { popupStyle, holeStyle } = useMemo(() => {
    const POPUP_W = 300, POPUP_H = 180;
    const vw = typeof window === "undefined" ? 1024 : window.innerWidth;
    const vh = typeof window === "undefined" ? 768 : window.innerHeight;
    if (!rect) return { popupStyle: null as any, holeStyle: null as any };
    const PAD = 8;
    const hole = { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 };
    const requested = step?.placement && step.placement !== "auto" ? step.placement : null;
    const space = { bottom: vh - (hole.top + hole.height), top: hole.top, right: vw - (hole.left + hole.width), left: hole.left };
    let place = requested as "bottom" | "top" | "left" | "right" | null;
    if (!place) {
      place = (Object.entries(space).sort((a, b) => b[1] - a[1])[0][0]) as any;
    }
    let top = 0, left = 0;
    if (place === "bottom") { top = hole.top + hole.height + 12; left = hole.left + hole.width / 2 - POPUP_W / 2; }
    else if (place === "top") { top = hole.top - POPUP_H - 12; left = hole.left + hole.width / 2 - POPUP_W / 2; }
    else if (place === "right") { top = hole.top + hole.height / 2 - POPUP_H / 2; left = hole.left + hole.width + 12; }
    else { top = hole.top + hole.height / 2 - POPUP_H / 2; left = hole.left - POPUP_W - 12; }
    left = Math.min(Math.max(12, left), vw - POPUP_W - 12);
    top = Math.min(Math.max(12, top), vh - POPUP_H - 12);
    return { popupStyle: { top, left, width: POPUP_W }, holeStyle: hole };
  }, [rect, step?.placement]);

  if (!activeFeature || !step) return null;
  const showSpot = rect && !missing && holeStyle;
  const lastStep = stepIdx >= activeFeature.steps.length - 1;

  return (
    <div className="fixed inset-0 z-[9998] pointer-events-none">
      {showSpot ? (
        <>
          <div className="absolute bg-black/50 backdrop-blur-[2px] pointer-events-auto" style={{ top: 0, left: 0, right: 0, height: holeStyle.top }} />
          <div className="absolute bg-black/50 backdrop-blur-[2px] pointer-events-auto" style={{ top: holeStyle.top + holeStyle.height, left: 0, right: 0, bottom: 0 }} />
          <div className="absolute bg-black/50 backdrop-blur-[2px] pointer-events-auto" style={{ top: holeStyle.top, left: 0, width: holeStyle.left, height: holeStyle.height }} />
          <div className="absolute bg-black/50 backdrop-blur-[2px] pointer-events-auto" style={{ top: holeStyle.top, left: holeStyle.left + holeStyle.width, right: 0, height: holeStyle.height }} />
          <div className="absolute rounded-2xl ring-4 ring-primary-400/60 animate-pulse pointer-events-none" style={{ ...holeStyle }} />
        </>
      ) : (
        <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px] pointer-events-auto" />
      )}

      <div className="absolute z-10 bg-white rounded-2xl shadow-2xl border border-gray-100 p-4 pointer-events-auto" style={popupStyle || { bottom: 20, right: 20, width: 300 }}>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-semibold tracking-wide text-primary-500 uppercase">{lang === 1 ? "טיפ" : "Tip"}</span>
          <button type="button" onClick={done} className="text-gray-400 hover:text-gray-700 text-[11px]">{lang === 1 ? "דלג" : "Skip"}</button>
        </div>
        <h3 className="text-sm font-bold text-gray-900 mb-1">{step.title[lang]}</h3>
        <p className="text-[13px] text-gray-600 leading-snug">{step.body[lang]}</p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <button type="button" onClick={snooze} className="text-[11px] text-gray-500 hover:text-gray-800">
            {lang === 1 ? "הצג לי מאוחר יותר" : "Show me later"}
          </button>
          <button type="button" onClick={next} className="px-3 py-1 bg-primary-500 hover:bg-primary-600 text-white text-xs font-medium rounded-lg transition">
            {lastStep ? (lang === 1 ? "הבנתי" : "Got it") : (lang === 1 ? "הבא" : "Next")}
          </button>
        </div>
      </div>
    </div>
  );
}
