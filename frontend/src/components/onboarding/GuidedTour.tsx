"use client";

// GuidedTour - the first-time story of the platform.
//
// Not a feature checklist: a guided story. A small GOTCHA guide character
// travels with the user between the real screens, each step leads with the
// VALUE ("what this does for your business"), and the inbox act runs on
// injected demo data (lib/tour-mock.ts) so a brand-new empty account still
// feels alive - the owner opens a real-looking chat, meets the Co-Pilot and
// the action buttons, all on fixtures that can't touch real data.
//
// Choreography per step: navigate FIRST, let the page render, then the
// character glides to the target and the popup appears. Never the reverse.
//
// Navigation is TAUGHT, never teleported: every page move is preceded by a
// step that spotlights the nav entry the user clicks themselves (main
// sidebar, Settings side menu, AI Studio tabs), and anchored popups carry a
// "you are here" location chip - the tour's job is a mental map, not a slideshow.
//
//   • Starts via localStorage["onboarding.launchTour"]="1", ?tour=1, or the
//     window event "gotcha:start-tour". Cleared by ?tour=0, Skip, or Finish.
//   • Progress is stored by step ID (survives the voice step appearing/
//     disappearing with the tenant's voice license).
//   • HARD RULE: at most ONE navigation attempt per step (sessionStorage
//     guard). A target route that redirects elsewhere must degrade to the
//     "press Next" fallback - re-pushing on mismatch once looped navigation
//     forever and DDoSed our own API.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useI18n } from "@/context/I18nContext";
import { useVoiceFlags } from "@/lib/use-voice-flags";
import { setTourMock, tourMockActive } from "@/lib/tour-mock";

const STORAGE_KEY = "onboarding.launchTour";
const PROGRESS_KEY = "onboarding.tourStep"; // stores the step ID
const NAV_ATTEMPT_KEY = "onboarding.tourNav";
const GUIDE_POS_KEY = "onboarding.tourGuidePos";

interface TourStep {
  id: string;
  /** CSS selector to spotlight; null = center-stage screen. */
  selector: string | null;
  /** Route to go to first (may carry a query, e.g. /ai-studio?tab=skills). */
  navigateTo?: string;
  /** Keep the inbox demo-data mode on during this step. */
  mockInbox?: boolean;
  /** Advance when the spotlit element is clicked (the user DOES the thing).
      Only these steps leave the spotlit element clickable - on every other
      step the spotlight is look-don't-touch, so the tour can never be
      derailed by a stray click (connecting a channel, creating a workflow…). */
  advanceOnClick?: boolean;
  /** When this selector already exists the step's "do it" click is moot -
      e.g. the Co-Pilot panel auto-opened with the conversation. With
      `presentCopy` set, the step STAYS and swaps to that copy (click-to-
      advance off, so the user can't accidentally undo the auto-open) instead
      of silently jumping ahead - the old instant skip read as a glitch. */
  skipIfPresent?: string;
  /** Alternate copy shown when `skipIfPresent` matched (see above). */
  presentCopy?: { title: [string, string]; body: [string, string] };
  /** Skip this step when the selector is MISSING - e.g. "close the panel"
      is moot if the user already closed it. */
  skipIfAbsent?: string;
  /** Let the user actually use the spotlit element (scroll, expand, poke
      around) without advancing - for "experience it" beats like the Co-Pilot
      panel, which runs entirely on tour-mock fixtures. */
  interactive?: boolean;
  /** "You are here" chip ([en, he]) - matches the real nav labels so the
      user builds a mental map of WHERE each feature lives. */
  location?: [string, string];
  /** Center-stage cinematic card (welcome / finale). */
  center?: boolean;
  placement?: "auto" | "bottom" | "top" | "left" | "right";
  title: [string, string];
  body: [string, string];
  cta?: [string, string];
}

// Copy rule: lead with what it DOES for the business, never with the feature
// name. Short. One idea per step. [en, he].
const ALL_STEPS: TourStep[] = [
  {
    id: "welcome",
    selector: null,
    center: true,
    // Brand rule: open with the BUSINESS OUTCOME (easier, faster, nothing
    // slips), never with "AI employees platform" framing.
    title: ["Your business is about to get a lot easier", "העסק שלכם עומד להיות הרבה יותר קל"],
    body: [
      "Customers get answers in seconds - day or night - nothing slips through the cracks, and your time comes back to you. Give me one minute and I'll show you how, screen by screen.",
      "לקוחות מקבלים תשובה תוך שניות - ביום ובלילה - שום פנייה לא נופלת בין הכיסאות, והזמן שלכם חוזר אליכם. תנו לי דקה אחת ואראה לכם איך, מסך אחרי מסך.",
    ],
    cta: ["Show me", "קדימה"],
  },
  {
    id: "inbox-nav",
    selector: '[data-tour="nav-conversations"]',
    advanceOnClick: true,
    placement: "right",
    title: ["This menu is your map", "התפריט הזה הוא המפה שלכם"],
    body: [
      "Everything in GOTCHA lives one click away in this menu. First stop: the Inbox, where every customer conversation arrives. Click it and let's step inside.",
      "הכול ב-GOTCHA נמצא במרחק לחיצה אחת בתפריט הזה. תחנה ראשונה: תיבת הדואר, שאליה מגיעה כל שיחת לקוח. לחצו עליה וניכנס פנימה.",
    ],
  },
  {
    id: "inbox",
    selector: '[data-tour="inbox-list"]',
    navigateTo: "/conversations",
    mockInbox: true,
    placement: "right",
    location: ["Inbox", "תיבת דואר"],
    title: ["Never miss a customer again", "אף לקוח לא הולך לאיבוד יותר"],
    body: [
      "WhatsApp, Instagram, email, webchat - every message lands here, already answered by your AI employee. See the Inbox item glowing in the menu? That glow always tells you where you are. These are demo conversations so you can feel it live.",
      "וואטסאפ, אינסטגרם, מייל, צ'אט - כל הודעה נוחתת כאן, כשעובד ה-AI כבר ענה עליה. רואים את תיבת הדואר מוארת בתפריט? ההארה הזאת תמיד תגיד לכם איפה אתם. אלו שיחות דמו כדי שתרגישו את זה חי.",
    ],
  },
  {
    id: "inbox-open",
    selector: '[data-tour="inbox-row-primary"]',
    mockInbox: true,
    advanceOnClick: true,
    placement: "right",
    location: ["Inbox", "תיבת דואר"],
    title: ["Open Dana's conversation", "פתחו את השיחה של דנה"],
    body: [
      "Dana asked where her order is - and got an answer in seconds, at 11pm, without you. Click the conversation to see it.",
      "דנה שאלה איפה ההזמנה שלה - וקיבלה תשובה תוך שניות, ב-23:00 בלילה, בלעדיכם. לחצו על השיחה כדי לראות.",
    ],
  },
  {
    id: "copilot-open",
    selector: '[data-tour="chat-copilot-toggle"]',
    mockInbox: true,
    advanceOnClick: true,
    // On desktop the panel auto-opens with an inbound-last conversation -
    // asking to "click Co-Pilot" would toggle it CLOSED. The step stays and
    // explains what just happened instead of vanishing (presentCopy).
    skipIfPresent: '[data-tour="copilot-panel"]',
    presentCopy: {
      title: ["Your Co-Pilot is already here", "הקו-פיילוט שלכם כבר כאן"],
      body: [
        "The Co-Pilot panel opened by itself alongside the conversation - it does that whenever you enter a chat. The highlighted button is where you open and close it yourself, any time. Press Next and let's look inside.",
        "פאנל הקו-פיילוט נפתח מעצמו לצד השיחה - זה קורה בכל פעם שנכנסים לצ'אט. הכפתור המודגש הוא המקום לפתוח ולסגור אותו בעצמכם, מתי שתרצו. לחצו הבא ונציץ פנימה.",
      ],
    },
    placement: "bottom",
    location: ["Inbox", "תיבת דואר"],
    title: ["Meet your Co-Pilot", "הכירו את הקו-פיילוט"],
    body: [
      "When YOU step into a chat, you're never alone. Click the Co-Pilot button - it already read everything.",
      "כשאתם נכנסים לשיחה, אתם אף פעם לא לבד. לחצו על כפתור הקו-פיילוט - הוא כבר קרא הכל.",
    ],
  },
  {
    id: "copilot",
    selector: '[data-tour="copilot-panel"]',
    mockInbox: true,
    interactive: true,
    placement: "left",
    location: ["Inbox", "תיבת דואר"],
    title: ["It did your homework", "הוא כבר עשה בשבילכם שיעורי בית"],
    body: [
      "Who Dana is in your CRM, how she feels, what she needs - and a reply ready to send in one click. Take your time: scroll the panel and explore, it's all demo data. Press Next when you're ready.",
      "מי דנה ב-CRM שלכם, איך היא מרגישה, מה היא צריכה - ותשובה מוכנה לשליחה בלחיצה אחת. קחו את הזמן: גללו בפאנל וחקרו, הכול נתוני דמו. לחצו הבא כשתסיימו.",
    ],
  },
  {
    id: "copilot-close",
    selector: '[data-tour="chat-copilot-toggle"]',
    mockInbox: true,
    advanceOnClick: true,
    // If the user already closed the panel themselves, there is nothing to
    // close - move on.
    skipIfAbsent: '[data-tour="copilot-panel"]',
    placement: "bottom",
    location: ["Inbox", "תיבת דואר"],
    title: ["Now close it yourself", "עכשיו סגרו אותו בעצמכם"],
    body: [
      "Click the Co-Pilot button again and the panel tucks away - the conversation stays exactly where it was. Open, peek, close: that's the rhythm of working with it.",
      "לחצו שוב על כפתור הקו-פיילוט והפאנל מתקפל - השיחה נשארת בדיוק איפה שהייתה. לפתוח, להציץ, לסגור: זה הקצב של העבודה איתו.",
    ],
  },
  {
    id: "chat-actions",
    selector: '[data-tour="chat-actions"]',
    mockInbox: true,
    placement: "bottom",
    location: ["Inbox", "תיבת דואר"],
    title: ["You stay the boss", "אתם נשארים הבוס"],
    body: [
      "Take over a conversation, hand it back to the AI, close it, or call the customer - one click each. The AI works for you, not instead of you.",
      "קחו שיחה לידיים, החזירו אותה ל-AI, סגרו אותה או התקשרו ללקוח - לחיצה אחת לכל פעולה. ה-AI עובד בשבילכם, לא במקומכם.",
    ],
  },
  {
    id: "channels-nav",
    selector: '[data-tour="nav-settings"]',
    advanceOnClick: true,
    placement: "right",
    title: ["Channels live inside Settings", "הערוצים גרים בתוך ההגדרות"],
    body: [
      "Connecting WhatsApp, Instagram, email and the rest happens under Settings. Click Settings in the menu and I'll walk you the rest of the way.",
      "חיבור וואטסאפ, אינסטגרם, מייל והשאר נעשה תחת הגדרות. לחצו על הגדרות בתפריט ואוביל אתכם בהמשך הדרך.",
    ],
  },
  {
    id: "channels-menu",
    selector: '[data-tour="settings-nav-channels"]',
    navigateTo: "/settings",
    advanceOnClick: true,
    placement: "right",
    location: ["Settings", "הגדרות"],
    title: ["Settings has its own menu", "להגדרות יש תפריט משלהן"],
    body: [
      "Inside Settings, everything is arranged in this menu of sections. Here's Channels - click it.",
      "בתוך ההגדרות הכול מסודר בתפריט האזורים הזה. הנה ערוצים - לחצו עליו.",
    ],
  },
  {
    id: "channels",
    selector: '[data-tour="channels-connect"]',
    navigateTo: "/settings/channels",
    placement: "top",
    location: ["Settings · Channels", "הגדרות · ערוצים"],
    title: ["Be everywhere your customers already are", "להיות בכל מקום שהלקוחות שלכם כבר נמצאים"],
    body: [
      "WhatsApp, Instagram, Messenger, email, webchat, even a phone line with a voice answerer. No need to connect anything now, it all waits for you in your next tasks right after the tour.",
      "וואטסאפ, אינסטגרם, מסנג'ר, מייל, צ'אט לאתר, ואפילו קו טלפוני עם מענה קולי. לא צריך לחבר כלום עכשיו, הכול מחכה לכם במשימות הבאות מיד אחרי הסיור.",
    ],
  },
  {
    id: "voice-nav",
    selector: '[data-tour="settings-nav-voice-channels"]',
    advanceOnClick: true,
    placement: "right",
    location: ["Settings · Channels", "הגדרות · ערוצים"],
    title: ["Same menu, one section down", "אותו תפריט, אזור אחד למטה"],
    body: [
      "Notice you never left Settings: you just switch sections in this menu. Click Voice channels.",
      "שימו לב שלא יצאתם מההגדרות: פשוט מחליפים אזור בתפריט הזה. לחצו על ערוצי קול.",
    ],
  },
  {
    id: "voice",
    selector: null,
    navigateTo: "/settings/voice-channels",
    location: ["Settings · Voice channels", "הגדרות · ערוצי קול"],
    title: ["It answers the phone too", "הוא עונה גם לטלפון"],
    body: [
      "Connect a phone line and your AI employee picks up real calls - talks, books, transcribes, and briefs you afterwards. Your business stops missing calls.",
      "חברו קו טלפון ועובד ה-AI עונה לשיחות אמיתיות - מדבר, קובע, מתמלל ומעדכן אתכם אחר כך. העסק שלכם מפסיק לפספס שיחות.",
    ],
  },
  {
    id: "ai-nav",
    selector: '[data-tour="nav-ai-studio"]',
    advanceOnClick: true,
    placement: "right",
    title: ["And this is the AI Studio", "וכאן גר ה-AI Studio"],
    body: [
      "Everything about your AI employees lives in one place, and it has its own home in the main menu. Click AI Studio and I'll show you around.",
      "כל מה שקשור לעובדי ה-AI שלכם גר במקום אחד, ויש לו בית משלו בתפריט הראשי. לחצו על סטודיו AI ואעשה לכם סיבוב.",
    ],
  },
  {
    id: "ai-overview",
    selector: '[data-tour="ai-studio-tabs"]',
    navigateTo: "/ai-studio",
    placement: "bottom",
    location: ["AI Studio", "סטודיו AI"],
    title: ["Welcome to AI Studio", "ברוכים הבאים לסטודיו ה-AI"],
    body: [
      "This is where you manage and improve your whole AI system, in four rooms: Team Members (your AI employees), Playbooks (your business processes), Knowledge (what they learn from) and Skills & Integrations (what they can do). These tabs move you between the rooms - we'll visit each one.",
      "כאן מנהלים ומשפרים את כל מערכת ה-AI, בארבעה חדרים: חברי צוות (עובדי ה-AI שלכם), תהליכים (התהליכים העסקיים), ידע (ממה הם לומדים) וכישורים ואינטגרציות (מה הם מסוגלים לעשות). הטאבים האלה מעבירים בין החדרים - נבקר בכל אחד.",
    ],
  },
  {
    id: "ai-tools",
    selector: '[data-tour="ai-tools"]',
    navigateTo: "/ai-studio?tab=skills",
    placement: "bottom",
    location: ["AI Studio · Skills & Integrations", "סטודיו AI · כישורים ואינטגרציות"],
    title: ["Give it hands, not just a mouth", "תנו לו ידיים, לא רק פה"],
    body: [
      "We've moved one tab over, to Skills & Integrations. Connect your calendar, CRM and tools, and your employee doesn't just answer, it DOES: books meetings, updates leads, checks orders. Connecting waits for you in your tasks after the tour.",
      "עברנו טאב אחד, לכישורים ואינטגרציות. חברו יומן, CRM וכלים, והעובד לא רק עונה, הוא עושה: קובע פגישות, מעדכן לידים, בודק הזמנות. החיבור עצמו מחכה לכם במשימות שאחרי הסיור.",
    ],
  },
  {
    id: "knowledge",
    selector: '[data-tour="kb-overview"]',
    navigateTo: "/ai-studio?tab=knowledge",
    location: ["AI Studio · Knowledge", "סטודיו AI · ידע"],
    title: ["Teach it your business in minutes", "תלמדו אותו את העסק שלכם בדקות"],
    body: [
      "Next tab: Knowledge. Drop in your price list, policies, website, Google Drive - from that moment your AI answers from YOUR truth, not from guesses. Adding sources is one of your first tasks after the tour.",
      "הטאב הבא: ידע. זרקו פנימה מחירון, מדיניות, אתר, Google Drive - מאותו רגע ה-AI עונה מהאמת שלכם, לא מניחושים. הוספת מקורות היא מהמשימות הראשונות שאחרי הסיור.",
    ],
  },
  {
    id: "hire",
    selector: '[data-tour="create-ai-employee"]',
    navigateTo: "/ai-studio?tab=team",
    placement: "bottom",
    location: ["AI Studio · Team Members", "סטודיו AI · חברי צוות"],
    title: ["You don't need to grow to hire more", "כבר לא צריך לגדול כדי לגייס עוד"],
    body: [
      "Back on the Team Members tab - this is where your AI employees live. When you need another one - sales, support, bookings - this button hires them in minutes, each with its own personality, knowledge and goals.",
      "חזרנו לטאב חברי הצוות - כאן גרים עובדי ה-AI שלכם. כשתצטרכו עוד אחד - מכירות, שירות, זימון תורים - הכפתור הזה מגייס אותו בדקות, עם אופי, ידע ומטרות משלו.",
    ],
  },
  {
    id: "workflows",
    selector: '[data-tour="new-workflow"]',
    navigateTo: "/ai-studio?tab=playbooks",
    placement: "bottom",
    location: ["AI Studio · Playbooks", "סטודיו AI · תהליכים"],
    title: ["Put the busywork on rails", "שימו את העבודה השחורה על פסים"],
    body: [
      "Last room: the Playbooks tab. Draw a journey once - who gets routed where, what details get collected, when a human steps in - and it runs itself, no code. That's all four rooms of AI Studio: from now on the tabs are yours.",
      "החדר האחרון: טאב התהליכים. מציירים מסלול פעם אחת - מי מנותב לאן, אילו פרטים נאספים, מתי בן אדם נכנס - וזה רץ לבד, בלי קוד. אלו ארבעת החדרים של הסטודיו: מעכשיו הטאבים שלכם.",
    ],
  },
  {
    id: "outbound-nav",
    selector: '[data-tour="nav-outbound"]',
    advanceOnClick: true,
    placement: "right",
    title: ["Don't just answer - reach out", "אל תחכו שיפנו - תפנו"],
    body: [
      "So far customers reached YOU. Outbound is where you start the conversation - and it has its own place in the main menu. Click it.",
      "עד עכשיו הלקוחות הגיעו אליכם. 'יוצא' הוא המקום שבו אתם פותחים את השיחה - ויש לו מקום משלו בתפריט הראשי. לחצו עליו.",
    ],
  },
  {
    id: "outbound",
    selector: '[data-tour="outbound-dialer"]',
    navigateTo: "/outbound/call",
    placement: "right",
    location: ["Outbound", "יוצא"],
    title: ["Revenue you start", "הכנסה שאתם יוזמים"],
    body: [
      "Call customers, send campaigns and broadcasts to exactly the right people, on the channel they actually read. The tabs above switch between calls, templates and broadcasts.",
      "התקשרו ללקוחות, שלחו קמפיינים ותפוצות בדיוק לאנשים הנכונים, בערוץ שהם באמת קוראים. הטאבים למעלה עוברים בין שיחות, תבניות ותפוצות.",
    ],
  },
  {
    id: "settings-nav",
    selector: '[data-tour="nav-settings"]',
    advanceOnClick: true,
    placement: "right",
    title: ["One last stop", "תחנה אחרונה"],
    body: [
      "Remember Settings from earlier, when we connected channels? Click it once more - there's one part of it worth knowing by heart.",
      "זוכרים את ההגדרות מקודם, כשחיברנו ערוצים? לחצו עליהן שוב - יש שם חלק אחד ששווה להכיר בעל פה.",
    ],
  },
  {
    id: "settings",
    selector: '[data-tour="settings-nav"]',
    navigateTo: "/settings",
    placement: "right",
    location: ["Settings", "הגדרות"],
    title: ["Everything is set up here", "כאן מגדירים הכול"],
    body: [
      "One last stop, back in Settings - you already know the way. This menu of sections is the part to remember: users and roles, business hours, language, notifications, usage. When you want to change how things work, it happens in one of these sections.",
      "תחנה אחרונה, שוב בהגדרות - את הדרך אתם כבר מכירים. תפריט האזורים הזה הוא מה ששווה לזכור: משתמשים והרשאות, שעות פעילות, שפה, התראות, צריכה. כשתרצו לשנות איך דברים עובדים, זה קורה באחד האזורים כאן.",
    ],
  },
  {
    id: "done",
    selector: null,
    center: true,
    title: ["From today, customers are the easy part", "מהיום, הלקוחות הם החלק הקל"],
    body: [
      "Every customer answered everywhere, your team never alone in a conversation, and you in full control. You can replay this tour any time from the Getting started page - now go try it on your own business.",
      "כל לקוח נענה בכל ערוץ, הצוות שלכם אף פעם לא לבד בשיחה, ואתם בשליטה מלאה. אפשר להריץ את הסיור שוב בכל רגע מעמוד הצעדים הראשונים - עכשיו לכו לנסות על העסק שלכם.",
    ],
    cta: ["Finish", "סיימנו"],
  },
];

// Steps that only exist for voice-licensed tenants (see the `steps` filter).
const VOICE_STEP_IDS = new Set(["voice-nav", "voice"]);

interface Rect { top: number; left: number; width: number; height: number; }

// A tour selector may match several nodes (desktop sidebar + mobile tab bar
// render the same anchors) - spotlight the one that's actually visible.
function findVisibleTarget(selector: string): HTMLElement | null {
  const els = document.querySelectorAll<HTMLElement>(selector);
  for (let i = 0; i < els.length; i++) {
    const r = els[i].getBoundingClientRect();
    if (r.width > 1 && r.height > 1) return els[i];
  }
  return null;
}

// useSearchParams demands a Suspense boundary at build time (static export
// routes) - wrap internally so every AppLayout keeps mounting <GuidedTour />
// with no changes.
export function GuidedTour() {
  return (
    <Suspense fallback={null}>
      <GuidedTourInner />
    </Suspense>
  );
}

function GuidedTourInner() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const { locale } = useI18n();
  const { voiceCopilotEnabled } = useVoiceFlags();
  const lang = locale === "he" ? 1 : 0;

  // Voice act only exists for voice-licensed tenants - both the "click Voice
  // channels" nav beat and the payoff, or the tour would point at a menu item
  // that isn't rendered. Progress is persisted by step ID so this filter can
  // flip while flags load without desyncing.
  const steps = useMemo(
    () => ALL_STEPS.filter((s) => !VOICE_STEP_IDS.has(s.id) || voiceCopilotEnabled),
    [voiceCopilotEnabled],
  );

  const [active, setActive] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [missingTarget, setMissingTarget] = useState(false);
  const [settled, setSettled] = useState(false);
  // Between-steps interaction lock: for ~700ms after every advance the whole
  // screen is inert, so nothing can be clicked mid-transition and the tour can
  // never be knocked out of sync by a fast second click.
  const [transitionLock, setTransitionLock] = useState(false);
  // skipIfPresent matched on a step with presentCopy: the step stays, shows
  // the alternate copy, and its click-to-advance is disabled (the click would
  // undo what the app already did, e.g. close the auto-opened Co-Pilot).
  const [presentDetected, setPresentDetected] = useState(false);

  const step = steps[stepIdx];
  // The one flag every interaction decision keys on: is the spotlit element
  // meant to be clicked RIGHT NOW to advance?
  const canClickTarget = !!step?.advanceOnClick && !presentDetected;

  // ── Boot: should the tour start? ──
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("tour") === "1";
    const fromUrlOff = params.get("tour") === "0";
    let flag = false;
    try { flag = localStorage.getItem(STORAGE_KEY) === "1"; } catch { /* private mode */ }
    if (fromUrlOff) {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
      setTourMock(false);
      return;
    }
    if (fromUrl || flag) {
      let savedIdx = 0;
      try {
        const savedId = localStorage.getItem(PROGRESS_KEY);
        const found = steps.findIndex((s) => s.id === savedId);
        if (found >= 0) savedIdx = found;
        // The tour navigates between pages and this component remounts with
        // each page's AppLayout - the flag carries it across. A ?tour=1 start
        // must persist it too, or the tour dies on step 2.
        localStorage.setItem(STORAGE_KEY, "1");
      } catch { /* */ }
      setStepIdx(savedIdx);
      setActive(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-derive the index if the steps array changes mid-tour (voice license
  // flag resolving) - the persisted ID is the source of truth.
  useEffect(() => {
    if (!active) return;
    try {
      const savedId = localStorage.getItem(PROGRESS_KEY);
      if (!savedId) return;
      const found = steps.findIndex((s) => s.id === savedId);
      if (found >= 0 && found !== stepIdx) setStepIdx(found);
    } catch { /* */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps]);

  // Manual start from anywhere (the Getting Started "Take the tour" button).
  useEffect(() => {
    const onStart = () => {
      try {
        localStorage.setItem(STORAGE_KEY, "1");
        localStorage.setItem(PROGRESS_KEY, ALL_STEPS[0].id);
        sessionStorage.removeItem(NAV_ATTEMPT_KEY);
      } catch { /* */ }
      setStepIdx(0);
      setActive(true);
    };
    window.addEventListener("gotcha:start-tour", onStart);
    return () => window.removeEventListener("gotcha:start-tour", onStart);
  }, []);

  // ── Persist step progress (by ID) ──
  useEffect(() => {
    if (!active || !step) return;
    try { localStorage.setItem(PROGRESS_KEY, step.id); } catch { /* */ }
  }, [active, step]);

  // ── Inbox demo-data lifecycle ──
  // Declared BEFORE the navigation effect so the flag is on by the time the
  // inbox mounts and fetches. Idempotent: only toggles on actual change.
  useEffect(() => {
    if (!active || !step) return;
    const want = !!step.mockInbox;
    if (tourMockActive() !== want) setTourMock(want);
  }, [active, step]);

  // ── Arrival: are we on this step's page (path AND query)? ──
  const arrived = useMemo(() => {
    if (!step?.navigateTo) return true;
    const [navPath, navQuery] = step.navigateTo.split("?");
    if (pathname !== navPath) return false;
    if (navQuery) {
      const want = new URLSearchParams(navQuery);
      const entries = Array.from(want.entries());
      for (const [k, v] of entries) {
        if (search.get(k) !== v) return false;
      }
    }
    return true;
  }, [step, pathname, search]);

  // ── Navigate FIRST (one attempt per step, redirect-proof) ──
  useEffect(() => {
    if (!active || !step?.navigateTo || arrived) return;
    const attempt = `${step.id}:${step.navigateTo}`;
    try {
      if (sessionStorage.getItem(NAV_ATTEMPT_KEY) === attempt) return;
      sessionStorage.setItem(NAV_ATTEMPT_KEY, attempt);
    } catch { /* private mode - fall through, worst case is one extra push */ }
    router.push(step.navigateTo);
  }, [active, step, arrived, router]);

  // ── ...THEN the popup: let the page paint before we talk over it ──
  // Deliberately NOT keyed on stepIdx: while several steps play out on the
  // same page (the inbox act), the popup stays mounted and MORPHS to the next
  // anchor instead of blinking out and back in. Only a real navigation
  // (arrived flipping false) resets the gate.
  useEffect(() => {
    if (!active) return;
    if (!arrived) {
      setSettled(false);
      return;
    }
    const t = window.setTimeout(() => setSettled(true), step?.center ? 150 : 450);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, arrived]);

  // ── Target-rect tracking ──
  // One rAF loop per step: waits for the anchor (route transitions), scrolls
  // it into view once, then keeps the rect glued through scroll/resize/late
  // layout shifts. State only updates when the rect actually moves.
  useEffect(() => {
    if (!active || !arrived) return;
    if (!step?.selector) {
      setRect(null);
      setMissingTarget(false);
      return;
    }
    // NOTE: the previous step's rect is intentionally NOT cleared here - when
    // the next anchor is on the same page, the spotlight/popup MORPH from the
    // old target to the new one (CSS transitions on the hole/popup) instead
    // of blinking. A stale rect only gets cleared after the new anchor has
    // been missing for a beat.
    setMissingTarget(false);
    let raf = 0;
    let scrolled = false;
    let last: Rect | null = null;
    const startedAt = performance.now();
    const tick = () => {
      const el = findVisibleTarget(step.selector!);
      if (el) {
        if (!scrolled) {
          scrolled = true;
          const r0 = el.getBoundingClientRect();
          if (r0.top < 0 || r0.bottom > window.innerHeight) {
            try { el.scrollIntoView({ block: "center" }); } catch { /* */ }
          }
        }
        const r = el.getBoundingClientRect();
        const moved =
          !last ||
          Math.abs(r.top - last.top) > 0.5 ||
          Math.abs(r.left - last.left) > 0.5 ||
          Math.abs(r.width - last.width) > 0.5 ||
          Math.abs(r.height - last.height) > 0.5;
        if (moved) {
          last = { top: r.top, left: r.left, width: r.width, height: r.height };
          setRect(last);
          setMissingTarget(false);
        }
      } else {
        const elapsed = performance.now() - startedAt;
        if (elapsed > 700) {
          // Same-value setState bails out, so this is cheap while null.
          last = null;
          setRect(null);
        }
        if (elapsed > 4000) setMissingTarget(true);
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [active, arrived, stepIdx, step?.selector]);

  // Arm the between-steps lock on every step change.
  useEffect(() => {
    if (!active) return;
    setTransitionLock(true);
    const t = window.setTimeout(() => setTransitionLock(false), 700);
    return () => window.clearTimeout(t);
  }, [active, stepIdx]);

  // Reset the "already done" detection whenever the step changes.
  useEffect(() => { setPresentDetected(false); }, [stepIdx]);

  // A step whose "do it" target is already satisfied (e.g. the Co-Pilot
  // panel auto-opened with the conversation - asking to click the toggle
  // would CLOSE it). With presentCopy the step stays and explains what
  // happened; without it (legacy) the step is skipped. Watches briefly
  // because panels mount async.
  useEffect(() => {
    if (!active || !arrived || !step?.skipIfPresent) return;
    const sel = step.skipIfPresent;
    const hasAltCopy = !!step.presentCopy;
    let tries = 0;
    const id = window.setInterval(() => {
      tries += 1;
      if (document.querySelector(sel)) {
        window.clearInterval(id);
        if (hasAltCopy) setPresentDetected(true);
        else setStepIdx((i) => Math.min(steps.length - 1, i + 1));
      } else if (tries > 8) {
        window.clearInterval(id);
      }
    }, 250);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, arrived, stepIdx]);

  // Inverse guard: a step that UNDOES something (close the Co-Pilot) is moot
  // when the thing is already undone - skip it instead of teaching a click
  // that would do the opposite.
  useEffect(() => {
    if (!active || !arrived || !step?.skipIfAbsent) return;
    const sel = step.skipIfAbsent;
    let tries = 0;
    const id = window.setInterval(() => {
      tries += 1;
      if (document.querySelector(sel)) {
        window.clearInterval(id);
      } else if (tries > 4) {
        window.clearInterval(id);
        setStepIdx((i) => Math.min(steps.length - 1, i + 1));
      }
    }, 250);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, arrived, stepIdx]);

  const finish = useCallback(() => {
    setActive(false);
    setTourMock(false);
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(PROGRESS_KEY);
      sessionStorage.removeItem(NAV_ATTEMPT_KEY);
      sessionStorage.removeItem(GUIDE_POS_KEY);
    } catch { /* */ }
  }, []);

  const skip = finish;
  const next = useCallback(() => {
    setStepIdx((i) => {
      if (i >= steps.length - 1) {
        finish();
        return i;
      }
      return i + 1;
    });
  }, [steps.length, finish]);
  const back = useCallback(() => setStepIdx((i) => Math.max(0, i - 1)), []);

  // ── Advance when the user actually DOES the step's action ──
  // Capture-phase document listener with closest() so it works even though
  // the anchor mounts asynchronously after navigation. Ignored while the page
  // is still settling or during the between-steps lock.
  useEffect(() => {
    if (!active || !step?.selector || !canClickTarget) return;
    if (!settled || transitionLock) return;
    const sel = step.selector;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || !t.closest(sel)) return;
      // Persist the advance SYNCHRONOUSLY, before the click's navigation runs.
      // A nav click can unmount this component (routes with their own layout,
      // e.g. /settings, remount AppLayout) - a state-only advance would then
      // die with the unmount and the remount would re-read the step we just
      // finished, stranding the tour on it forever. Storage is the source of
      // truth on boot, so writing it here survives either outcome.
      const nx = steps[stepIdx + 1];
      if (nx) { try { localStorage.setItem(PROGRESS_KEY, nx.id); } catch { /* */ } }
      window.setTimeout(next, 200);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [active, stepIdx, step, next, settled, transitionLock, canClickTarget, steps]);

  // "Next" must actually DO the step, never skip past it: on a do-it step it
  // performs the click itself (open Dana's chat, open the Co-Pilot, click the
  // nav item) and lets the click listener advance - the app and the tour stay
  // in the same reality. (Pressing Next used to advance WITHOUT the action,
  // leaving the next step pointing at UI that didn't exist yet.)
  const performNext = useCallback(() => {
    if (transitionLock) return;
    if (canClickTarget && step?.selector) {
      const el = findVisibleTarget(step.selector);
      if (el) { el.click(); return; }
    }
    next();
  }, [step, next, transitionLock, canClickTarget]);

  // ── Popup + spotlight geometry ──
  const { popupStyle, holeStyle } = useMemo(() => {
    const POPUP_W = 300;
    const POPUP_H = 200;
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

    const requested = step?.placement && step.placement !== "auto" ? step.placement : null;
    const spaceBottom = vh - (hole.top + hole.height);
    const spaceTop = hole.top;
    const spaceRight = vw - (hole.left + hole.width);
    const spaceLeft = hole.left;
    let place: "bottom" | "top" | "right" | "left" = requested as any;
    if (!place) {
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
      top = hole.top + hole.height + 16;
      left = Math.max(12, hole.left + hole.width / 2 - POPUP_W / 2);
    } else if (place === "top") {
      top = hole.top - POPUP_H - 16;
      left = Math.max(12, hole.left + hole.width / 2 - POPUP_W / 2);
    } else if (place === "right") {
      top = Math.max(12, hole.top + hole.height / 2 - POPUP_H / 2);
      left = hole.left + hole.width + 16;
    } else {
      top = Math.max(12, hole.top + hole.height / 2 - POPUP_H / 2);
      left = Math.max(12, hole.left - POPUP_W - 16);
    }
    if (left + POPUP_W > vw - 12) left = Math.max(12, vw - POPUP_W - 12);
    if (top + POPUP_H > vh - 12) top = Math.max(12, vh - POPUP_H - 12);
    if (top < 12) top = 12;
    if (left < 12) left = 12;
    return {
      popupStyle: { top, left, width: POPUP_W },
      holeStyle: hole,
    };
  }, [rect, step?.placement]);

  // ── Guide character position ──
  // The character exists the whole time the tour is active. Between pages it
  // drifts to a "walking" spot; once the popup lands it perches on the
  // popup's corner. Its last position survives remounts via sessionStorage,
  // so on every navigation it visibly TRAVELS from where it was.
  const guideTarget = useMemo(() => {
    const vw = typeof window === "undefined" ? 1024 : window.innerWidth;
    const vh = typeof window === "undefined" ? 768 : window.innerHeight;
    if (step?.center && settled) return { x: vw / 2 - 32, y: vh / 2 - 235 };
    if (popupStyle && settled) return { x: popupStyle.left - 22, y: popupStyle.top - 26 };
    if (settled && !step?.selector) return { x: vw / 2 - 32, y: vh * 0.62 };
    // traveling / waiting for the page
    return { x: vw / 2 - 32, y: vh * 0.72 };
  }, [step?.center, step?.selector, settled, popupStyle]);

  const initialGuidePos = useRef<{ x: number; y: number } | null>(null);
  if (initialGuidePos.current === null && typeof window !== "undefined") {
    try {
      const raw = sessionStorage.getItem(GUIDE_POS_KEY);
      initialGuidePos.current = raw ? JSON.parse(raw) : guideTarget;
    } catch { initialGuidePos.current = guideTarget; }
  }
  const [guidePos, setGuidePos] = useState<{ x: number; y: number }>(
    () => initialGuidePos.current || { x: 0, y: 0 },
  );
  useEffect(() => {
    // Next frame → CSS transition animates the glide.
    const raf = window.requestAnimationFrame(() => {
      setGuidePos(guideTarget);
      try { sessionStorage.setItem(GUIDE_POS_KEY, JSON.stringify(guideTarget)); } catch { /* */ }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [guideTarget]);

  if (!active || !step) return null;

  const showSpotlight = settled && rect && !missingTarget && holeStyle;
  const showPopup = settled && (step.center || !step.selector || rect || missingTarget);
  const finalStep = stepIdx === steps.length - 1;
  const total = steps.length;
  // presentCopy swap: when the app already did the step's action (auto-opened
  // panel), narrate that instead of asking for a click that would undo it.
  const showPresentCopy = presentDetected && !!step.presentCopy;
  const stepTitle = showPresentCopy ? step.presentCopy!.title[lang] : step.title[lang];
  const stepBody = showPresentCopy ? step.presentCopy!.body[lang] : step.body[lang];

  return (
    <div className="fixed inset-0 z-[9999] pointer-events-none" aria-hidden={false}>
      <style>{`
        @keyframes gotchaTourPop { from { opacity: 0; transform: translateY(8px) scale(0.96); } to { opacity: 1; transform: none; } }
        @keyframes gotchaFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes gotchaContentSwap { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
        @keyframes gotchaTourHero { from { opacity: 0; transform: translateY(16px) scale(0.94); } to { opacity: 1; transform: none; } }
        @keyframes gotchaGuideBob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-7px); } }
        @keyframes gotchaSparkle { 0%, 100% { opacity: 0.2; transform: scale(0.7); } 50% { opacity: 1; transform: scale(1.15); } }
      `}</style>

      {/* Backdrop */}
      {showSpotlight ? (
        <>
          {/* Invisible click-blockers around the hole - the target stays
              clickable, everything else is inert. Visuals live on the
              animated hole below (a blocker can't morph smoothly). */}
          <div className="absolute pointer-events-auto" style={{ top: 0, left: 0, right: 0, height: holeStyle.top }} />
          <div className="absolute pointer-events-auto" style={{ top: holeStyle.top + holeStyle.height, left: 0, right: 0, bottom: 0 }} />
          <div className="absolute pointer-events-auto" style={{ top: holeStyle.top, left: 0, width: holeStyle.left, height: holeStyle.height }} />
          <div className="absolute pointer-events-auto" style={{ top: holeStyle.top, left: holeStyle.left + holeStyle.width, right: 0, height: holeStyle.height }} />
          {/* Look-don't-touch: unless this step explicitly asks for a click
              (or invites exploration via `interactive`), the spotlit element
              itself is inert too - so "highlighted" never means "clickable"
              (no accidental channel connects, workflow creates, or opening
              random chats mid-tour). */}
          {!(canClickTarget || step.interactive) && (
            <div className="absolute pointer-events-auto" style={{ ...holeStyle }} />
          )}
          {/* The dim IS the hole's giant box-shadow - so when the next anchor
              is on the same page, the spotlight visibly GLIDES to it instead
              of cutting. */}
          <div
            className="absolute rounded-2xl pointer-events-none"
            style={{
              ...holeStyle,
              boxShadow: "0 0 0 200vmax rgba(2, 6, 23, 0.55)",
              transition: "top 450ms cubic-bezier(0.22,1,0.36,1), left 450ms cubic-bezier(0.22,1,0.36,1), width 450ms cubic-bezier(0.22,1,0.36,1), height 450ms cubic-bezier(0.22,1,0.36,1)",
            }}
          />
          <div
            className="absolute rounded-2xl ring-4 ring-primary-400/60 animate-pulse pointer-events-none"
            style={{
              ...holeStyle,
              transition: "top 450ms cubic-bezier(0.22,1,0.36,1), left 450ms cubic-bezier(0.22,1,0.36,1), width 450ms cubic-bezier(0.22,1,0.36,1), height 450ms cubic-bezier(0.22,1,0.36,1)",
            }}
          />
        </>
      ) : step.center && settled ? (
        <div className="absolute inset-0 bg-slate-950/70 pointer-events-auto" style={{ animation: "gotchaFadeIn 400ms ease-out" }} />
      ) : null}

      {/* Whole-screen lock while navigating / between steps: nothing in the
          app is clickable until the next step is actually on screen. */}
      {(!settled || transitionLock) && (
        <div className="absolute inset-0 pointer-events-auto" aria-hidden />
      )}

      {/* The guide - travels between screens, perches next to each popup. */}
      <div
        className="absolute z-30"
        style={{
          transform: `translate(${guidePos.x}px, ${guidePos.y}px)`,
          transition: "transform 850ms cubic-bezier(0.22, 1, 0.36, 1)",
          willChange: "transform",
        }}
      >
        <div className="relative" style={{ animation: "gotchaGuideBob 2.6s ease-in-out infinite" }}>
          <span className="absolute -top-2 -right-2 text-primary-300 text-xs" style={{ animation: "gotchaSparkle 1.8s ease-in-out infinite" }}>✦</span>
          <span className="absolute -bottom-1 -left-3 text-violet-300 text-[10px]" style={{ animation: "gotchaSparkle 2.3s ease-in-out 0.6s infinite" }}>✦</span>
          <div className="w-16 h-16 rounded-full bg-white shadow-2xl ring-4 ring-primary-400/50 flex items-center justify-center overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo_icon.png" alt="" className="w-10 h-10 object-contain" />
          </div>
        </div>
      </div>

      {/* Center-stage screens (welcome / finale) - the cinematic beat. */}
      {step.center && showPopup && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div
            className="pointer-events-auto relative max-w-md mx-4 rounded-3xl bg-white shadow-2xl px-8 pt-14 pb-8 text-center"
            style={{ animation: "gotchaTourHero 0.45s cubic-bezier(0.22, 1, 0.36, 1)" }}
          >
            <div className="absolute inset-x-0 -top-1 h-24 rounded-t-3xl bg-gradient-to-b from-primary-50 to-transparent pointer-events-none" />
            <span className="text-[10px] font-semibold tracking-widest text-primary-500 uppercase">
              {lang === 1 ? "סיור" : "Tour"} · {stepIdx + 1}/{total}
            </span>
            <h2 className="mt-2 text-2xl font-extrabold leading-tight bg-gradient-to-r from-primary-600 to-violet-600 bg-clip-text text-transparent">
              {stepTitle}
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-gray-600">{stepBody}</p>
            <div className="mt-6 flex items-center justify-center gap-3">
              {!finalStep && (
                <button type="button" onClick={skip} className="px-3 py-2 text-sm text-gray-400 hover:text-gray-600 font-medium transition">
                  {lang === 1 ? "דלגו" : "Skip"}
                </button>
              )}
              <button
                type="button"
                onClick={performNext}
                className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-primary-500 to-violet-500 hover:from-primary-600 hover:to-violet-600 text-white text-sm font-semibold shadow-lg shadow-primary-500/25 transition"
              >
                {step.cta ? step.cta[lang] : lang === 1 ? "הבא" : "Next"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Anchored popup - appears only after the page has painted. */}
      {!step.center && showPopup && (
        // Outer shell stays mounted across same-page steps and GLIDES to the
        // next anchor; only the inner content re-keys (quick fade-up). This is
        // what makes consecutive beats read as one continuous motion.
        <div
          className="absolute z-10 bg-white rounded-2xl shadow-2xl border border-gray-100 p-4 pointer-events-auto"
          style={{
            ...(popupStyle || { bottom: 20, right: 20, width: 300 }),
            animation: "gotchaTourPop 0.3s ease-out",
            transition: "top 500ms cubic-bezier(0.22,1,0.36,1), left 500ms cubic-bezier(0.22,1,0.36,1)",
          }}
        >
        <div key={step.id} style={{ animation: "gotchaContentSwap 350ms ease-out" }}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-semibold tracking-wide text-primary-500 uppercase">
              {lang === 1 ? "סיור" : "Tour"} {stepIdx + 1}/{total}
            </span>
            <button type="button" onClick={skip} className="text-gray-400 hover:text-gray-700 text-[11px]">
              {lang === 1 ? "דלג" : "Skip"}
            </button>
          </div>
          {/* "You are here" - anchors every explanation to a place in the
              app, so the tour builds a navigation mental model, not just a
              feature reel. */}
          {step.location && (
            <p className="mb-1.5 inline-flex items-center gap-1 max-w-full truncate text-[10px] font-semibold text-violet-700 bg-violet-50 rounded-full px-2 py-0.5" dir="auto">
              <span aria-hidden>📍</span>
              {step.location[lang]}
            </p>
          )}
          <h3 className="text-sm font-bold text-gray-900 mb-1">{stepTitle}</h3>
          <p className="text-[13px] text-gray-600 leading-snug">{stepBody}</p>

          {canClickTarget && !missingTarget && (
            <p className="mt-1.5 text-[11px] text-primary-700 bg-primary-50 rounded-md px-2 py-1">
              {lang === 1 ? "לחצו על האזור המואר כדי להמשיך ✨" : "Click the highlighted area to continue ✨"}
            </p>
          )}
          {step.interactive && !missingTarget && (
            <p className="mt-1.5 text-[11px] text-primary-700 bg-primary-50 rounded-md px-2 py-1">
              {lang === 1 ? "האזור המואר פתוח בשבילכם - גללו וחקרו ✨" : "The highlighted area is open for you - scroll and explore ✨"}
            </p>
          )}
          {missingTarget && step.selector && (
            <p className="mt-1.5 text-[11px] text-amber-700 bg-amber-50 rounded-md px-2 py-1">
              {lang === 1 ? "האזור עוד לא טעון. לחצו הבא או פעלו ידנית." : "Target isn't visible yet. Press Next or do it manually."}
            </p>
          )}

          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="flex gap-1">
              {steps.map((_, i) => (
                <span
                  key={i}
                  className={
                    "h-1 rounded-full transition-all " +
                    (i < stepIdx ? "bg-primary-500 w-1.5" : i === stepIdx ? "bg-primary-400 w-4" : "bg-gray-200 w-1")
                  }
                />
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              {stepIdx > 0 && (
                <button type="button" onClick={back} className="px-2.5 py-1 text-gray-400 hover:text-gray-700 text-xs font-medium rounded-lg transition">
                  {lang === 1 ? "חזרה" : "Back"}
                </button>
              )}
              <button
                type="button"
                onClick={performNext}
                className="px-3 py-1 bg-primary-500 hover:bg-primary-600 text-white text-xs font-medium rounded-lg transition"
              >
                {step.cta ? step.cta[lang] : finalStep ? (lang === 1 ? "סיים" : "Done") : lang === 1 ? "הבא" : "Next"}
              </button>
            </div>
          </div>
        </div>
        </div>
      )}
    </div>
  );
}
