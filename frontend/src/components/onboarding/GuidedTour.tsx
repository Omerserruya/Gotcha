"use client";

// GuidedTour - first-time end-to-end walkthrough for new tenants.
//
// Behavior:
//   • Triggers when localStorage["onboarding.launchTour"] === "1" OR the
//     URL contains ?tour=1.
//   • Walks the user through creating their first AI Employee step by
//     step, anchoring popups to UI elements via `data-tour="..."` hooks.
//   • Each step blurs everything except a "spotlight" cut-out around the
//     target. Next / Skip controls advance or close.
//   • Resilient to missing targets: if a step's anchor doesn't exist
//     after a short retry window, the popup centers itself instead of
//     forcing the user out of the tour.
//
// Cleared by `?tour=0`, the Skip button, or normal completion.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useI18n } from "@/context/I18nContext";

const STORAGE_KEY = "onboarding.launchTour";
const PROGRESS_KEY = "onboarding.tourStep";

interface TourStep {
  id: string;
  // CSS selector to anchor to. Use data-tour="..." hooks on real elements.
  // `null` = center-screen welcome / closing screen.
  selector: string | null;
  navigateTo?: string;
  // i18n: tuple of [en, he]
  title: [string, string];
  body: [string, string];
  cta?: [string, string];
  // Auto-advance when the target is clicked (lets the user actually do
  // the action without an explicit Next press).
  advanceOnClick?: boolean;
  placement?: "auto" | "bottom" | "top" | "left" | "right";
}

const STEPS: TourStep[] = [
  {
    id: "welcome",
    selector: null,
    title: ["Welcome aboard.", "ברוכים הבאים"],
    body: [
      "Let's set up your first AI Employee end-to-end. It takes about a minute.",
      "ניצור יחד את עובד ה-AI הראשון שלכם - לוקח דקה.",
    ],
    cta: ["Start the tour", "התחל את הסיור"],
  },
  {
    id: "open-ai-studio",
    selector: '[data-tour="nav-ai-studio"]',
    title: ["Open AI Studio", "פתחו את ה-AI Studio"],
    body: [
      "This is where your AI Employees live. Click here to open it.",
      "כאן מנהלים את עובדי ה-AI. לחצו כדי לפתוח.",
    ],
    advanceOnClick: true,
    placement: "right",
  },
  {
    id: "create-ai-employee",
    selector: '[data-tour="create-ai-employee"]',
    title: ["Create one", "צרו עובד חדש"],
    body: [
      "Click \"New AI Employee\" to start the wizard. We'll walk you through it.",
      "לחצו על 'עובד חדש' כדי לפתוח את האשף. ננחה אתכם.",
    ],
    advanceOnClick: true,
  },
  {
    id: "wizard-name",
    selector: '[data-tour="wizard-input"]',
    title: ["Name your AI Employee", "תנו שם לעובד"],
    body: [
      "Type a short name (e.g. \"Support Sam\") and press Send. Skip any question that's not relevant.",
      "כתבו שם קצר (למשל 'תמיכה דנה') ולחצו שלח. אפשר לדלג על כל שאלה.",
    ],
    placement: "top",
  },
  {
    id: "after-wizard",
    selector: '[data-tour="save-ai-employee"]',
    title: ["Save and you're set", "שמרו וזהו"],
    body: [
      "When you're happy with the config, click Save. Your AI Employee is live.",
      "כשמרגישים שהגדרתם נכון, לחצו שמירה. העובד עולה לאוויר.",
    ],
    placement: "left",
  },
  {
    id: "back-to-conversations",
    selector: '[data-tour="nav-conversations"]',
    title: ["Send your first reply", "שלחו את התגובה הראשונה"],
    body: [
      "Open Conversations to send a real test reply from your new AI Employee - that completes onboarding.",
      "פתחו 'שיחות' ושלחו תגובת בדיקה אמיתית מהעובד החדש - זה משלים את ההצטרפות.",
    ],
    advanceOnClick: true,
    placement: "right",
  },
  {
    id: "workflow-mission",
    selector: '[data-tour="mission-workflows"]',
    title: ["Your setup checklist", "רשימת ההגדרה שלכם"],
    body: [
      "This checklist guides your setup: connect a knowledge base, set up your AI Employee, connect a channel, and wire your workflow. Each step turns green automatically as you complete it.",
      "הרשימה הזו מלווה אתכם בהגדרה: חיבור מאגר ידע, הגדרת עובד ה-AI, חיבור ערוץ והגדרת תהליך העבודה. כל צעד יצבע ירוק אוטומטית עם השלמתו.",
    ],
  },
  {
    id: "done",
    selector: null,
    title: ["You're set.", "מצוין"],
    body: [
      "The Guide on the sidebar tracks each milestone. Finish them at your pace.",
      "המדריך בסיידבר עוקב אחרי כל אבן דרך. סיימו בקצב שלכם.",
    ],
    cta: ["Got it", "בסדר"],
  },
];

interface Rect { top: number; left: number; width: number; height: number; }

export function GuidedTour() {
  const router = useRouter();
  const pathname = usePathname();
  const { locale } = useI18n();
  const lang = locale === "he" ? 1 : 0;

  const [active, setActive] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [missingTarget, setMissingTarget] = useState(false);
  const retryRef = useRef<number | null>(null);

  // ── Boot: should the tour start? ──
  useEffect(() => {
    if (typeof window === "undefined") return;
    const search = new URLSearchParams(window.location.search);
    const fromUrl = search.get("tour") === "1";
    const fromUrlOff = search.get("tour") === "0";
    let flag = false;
    try { flag = localStorage.getItem(STORAGE_KEY) === "1"; } catch { /* private mode */ }
    if (fromUrlOff) {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
      return;
    }
    if (fromUrl || flag) {
      let savedStep = 0;
      try {
        const raw = localStorage.getItem(PROGRESS_KEY);
        if (raw) savedStep = Math.max(0, Math.min(STEPS.length - 1, parseInt(raw, 10) || 0));
      } catch { /* */ }
      setStepIdx(savedStep);
      setActive(true);
    }
  }, []);

  // ── Persist step progress ──
  useEffect(() => {
    if (!active) return;
    try { localStorage.setItem(PROGRESS_KEY, String(stepIdx)); } catch { /* */ }
  }, [active, stepIdx]);

  const step = STEPS[stepIdx];

  // ── Target-rect tracking ──
  const measure = useCallback(() => {
    if (!step || !step.selector) {
      setRect(null);
      setMissingTarget(false);
      return;
    }
    const el = document.querySelector(step.selector) as HTMLElement | null;
    if (!el) {
      setRect(null);
      setMissingTarget(true);
      return;
    }
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    setMissingTarget(false);
  }, [step]);

  useEffect(() => {
    if (!active) return;
    measure();
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [active, stepIdx, pathname, measure]);

  // Retry locating the target for up to ~4s - covers transitions
  // where the target isn't mounted yet (e.g. navigated route).
  useEffect(() => {
    if (!active || !step?.selector) return;
    if (retryRef.current) window.clearInterval(retryRef.current);
    let tries = 0;
    retryRef.current = window.setInterval(() => {
      tries += 1;
      const el = document.querySelector(step.selector!) as HTMLElement | null;
      if (el) {
        measure();
        if (retryRef.current) window.clearInterval(retryRef.current);
      } else if (tries >= 20) {
        setMissingTarget(true);
        if (retryRef.current) window.clearInterval(retryRef.current);
      }
    }, 200);
    return () => {
      if (retryRef.current) window.clearInterval(retryRef.current);
    };
  }, [active, stepIdx, pathname, step?.selector, measure]);

  // Auto-advance on target click
  useEffect(() => {
    if (!active || !step?.selector || !step.advanceOnClick) return;
    const el = document.querySelector(step.selector) as HTMLElement | null;
    if (!el) return;
    const onClick = () => {
      // Don't jump steps if the user is mid-typing; click is the cue.
      setTimeout(() => setStepIdx((i) => Math.min(STEPS.length - 1, i + 1)), 150);
    };
    el.addEventListener("click", onClick, { once: true });
    return () => el.removeEventListener("click", onClick);
  }, [active, stepIdx, step]);

  const finish = useCallback(() => {
    setActive(false);
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(PROGRESS_KEY);
    } catch { /* */ }
  }, []);

  const skip = finish;
  const next = useCallback(() => {
    if (stepIdx >= STEPS.length - 1) {
      finish();
      return;
    }
    const nxt = STEPS[stepIdx + 1];
    setStepIdx((i) => i + 1);
    if (nxt?.navigateTo && pathname !== nxt.navigateTo) {
      router.push(nxt.navigateTo);
    }
  }, [stepIdx, pathname, router, finish]);

  // Memoize spotlight + popup geometry
  const { popupStyle, holeStyle } = useMemo(() => {
    const POPUP_W = 280; // narrower so it doesn't cover panels
    const POPUP_H = 180; // rough estimate for clamping
    const vw = typeof window === "undefined" ? 1024 : window.innerWidth;
    const vh = typeof window === "undefined" ? 768 : window.innerHeight;

    if (!rect) return { popupStyle: null as any, holeStyle: null as any };
    const PADDING = 8;
    const hole = {
      top: rect.top - PADDING,
      left: rect.left - PADDING,
      width: rect.width + PADDING * 2,
      height: rect.height + PADDING * 2,
    };

    // Pick placement automatically based on which side has room.
    const requested = step?.placement && step.placement !== "auto" ? step.placement : null;
    const spaceBottom = vh - (hole.top + hole.height);
    const spaceTop = hole.top;
    const spaceRight = vw - (hole.left + hole.width);
    const spaceLeft = hole.left;
    let place: "bottom" | "top" | "right" | "left" = requested as any;
    if (!place) {
      // Auto: prefer the side with the most room, biased to bottom-then-right.
      const candidates: Array<{ p: "bottom" | "top" | "right" | "left"; s: number }> = [
        { p: "bottom", s: spaceBottom },
        { p: "top", s: spaceTop },
        { p: "right", s: spaceRight },
        { p: "left", s: spaceLeft },
      ];
      candidates.sort((a, b) => b.s - a.s);
      place = candidates[0]!.p;
    }

    let top = 0, left = 0;
    if (place === "bottom") {
      top = hole.top + hole.height + 12;
      left = Math.max(12, hole.left + hole.width / 2 - POPUP_W / 2);
    } else if (place === "top") {
      top = hole.top - POPUP_H - 12;
      left = Math.max(12, hole.left + hole.width / 2 - POPUP_W / 2);
    } else if (place === "right") {
      top = Math.max(12, hole.top + hole.height / 2 - POPUP_H / 2);
      left = hole.left + hole.width + 12;
    } else {
      // left
      top = Math.max(12, hole.top + hole.height / 2 - POPUP_H / 2);
      left = Math.max(12, hole.left - POPUP_W - 12);
    }
    // Clamp inside viewport.
    if (left + POPUP_W > vw - 12) left = Math.max(12, vw - POPUP_W - 12);
    if (top + POPUP_H > vh - 12) top = Math.max(12, vh - POPUP_H - 12);
    if (top < 12) top = 12;
    if (left < 12) left = 12;
    return {
      popupStyle: { top, left, width: POPUP_W },
      holeStyle: hole,
    };
  }, [rect, step?.placement]);

  if (!active || !step) return null;

  const showSpotlight = rect && !missingTarget && holeStyle;
  const finalStep = stepIdx === STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-[9999] pointer-events-none" aria-hidden={false}>
      {/* Backdrop with cut-out */}
      {showSpotlight ? (
        <>
          {/* 4 dark rectangles around the spotlight, leaving the target visible. */}
          <div
            className="absolute bg-black/55 backdrop-blur-[3px] transition-all duration-200 pointer-events-auto"
            style={{ top: 0, left: 0, right: 0, height: holeStyle.top }}
          />
          <div
            className="absolute bg-black/55 backdrop-blur-[3px] transition-all duration-200 pointer-events-auto"
            style={{ top: holeStyle.top + holeStyle.height, left: 0, right: 0, bottom: 0 }}
          />
          <div
            className="absolute bg-black/55 backdrop-blur-[3px] transition-all duration-200 pointer-events-auto"
            style={{ top: holeStyle.top, left: 0, width: holeStyle.left, height: holeStyle.height }}
          />
          <div
            className="absolute bg-black/55 backdrop-blur-[3px] transition-all duration-200 pointer-events-auto"
            style={{ top: holeStyle.top, left: holeStyle.left + holeStyle.width, right: 0, height: holeStyle.height }}
          />
          {/* Pulsing ring around the spotlight */}
          <div
            className="absolute rounded-2xl ring-4 ring-primary-400/60 animate-pulse pointer-events-none"
            style={{ ...holeStyle }}
          />
        </>
      ) : (
        <div className="absolute inset-0 bg-black/55 backdrop-blur-[3px] pointer-events-auto" />
      )}

      {/* Popup - anchored next to the spotlight when there is one, otherwise
          pinned to the bottom-right so welcome/done screens don't block the
          page. Width is capped tight so the popup doesn't crowd panels. */}
      <div
        className="absolute z-10 bg-white rounded-2xl shadow-2xl border border-gray-100 p-4 pointer-events-auto"
        style={popupStyle || { bottom: 16, right: 16, width: 280 }}
      >
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-semibold tracking-wide text-primary-500 uppercase">
            {lang === 1 ? "סיור" : "Tour"} {stepIdx + 1}/{STEPS.length}
          </span>
          <button
            type="button"
            onClick={skip}
            className="text-gray-400 hover:text-gray-700 text-[11px]"
          >
            {lang === 1 ? "דלג" : "Skip"}
          </button>
        </div>
        <h3 className="text-sm font-bold text-gray-900 mb-1">{step.title[lang]}</h3>
        <p className="text-[13px] text-gray-600 leading-snug">{step.body[lang]}</p>

        {missingTarget && step.selector && (
          <p className="mt-1.5 text-[11px] text-amber-700 bg-amber-50 rounded-md px-2 py-1">
            {lang === 1
              ? "האזור עוד לא טעון. לחצו הבא או פעלו ידנית."
              : "Target isn't visible yet. Press Next or do it manually."}
          </p>
        )}

        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex gap-1">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={
                  "h-1 rounded-full transition-all " +
                  (i < stepIdx ? "bg-primary-500 w-1.5" : i === stepIdx ? "bg-primary-400 w-4" : "bg-gray-200 w-1")
                }
              />
            ))}
          </div>
          <button
            type="button"
            onClick={next}
            className="px-3 py-1 bg-primary-500 hover:bg-primary-600 text-white text-xs font-medium rounded-lg transition"
          >
            {step.cta
              ? step.cta[lang]
              : finalStep
              ? (lang === 1 ? "סיים" : "Done")
              : (lang === 1 ? "הבא" : "Next")}
          </button>
        </div>
      </div>
    </div>
  );
}
