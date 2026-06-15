"use client";

import { useI18n } from "@/context/I18nContext";

/**
 * Inline signal coaching cards rendered under an INBOUND customer message.
 * Each card is a small, salesperson-style cue:
 *   ┌─────────────────────────────┐
 *   │ 🟢 Buy intent · strong       │
 *   │ 🔥 Hot Lead - Move fast,     │
 *   │ confirm price + close today.│
 *   └─────────────────────────────┘
 *
 * Localised for EN and HE. Hover the chip header to see the verbatim
 * customer quote that triggered the signal.
 */

type SignalKind =
  | "buy_intent"
  | "strong_objection"
  | "price_objection"
  | "hesitation"
  | "rejection"
  | "urgency"
  | "confusion"
  | "churn_risk";

interface Signal {
  kind: SignalKind;
  severity: "soft" | "strong";
  evidence: string;
  confidence: number;
}

interface Coaching {
  /** Short, attention-grabbing headline (max ~3 words). */
  headline: string;
  /** One-sentence tactical hint for the agent. */
  tip: string;
}

interface ChipMeta {
  label: string;
  /** Outer pill colors. */
  pill: string;
  /** Coaching banner accent stripe color. */
  accent: string;
  emoji: string;
}

const CHIP_META: Record<SignalKind, { en: string; he: string; pill: string; accent: string; emoji: string }> = {
  buy_intent:       { en: "Buy intent",       he: "כוונת רכישה",      pill: "bg-emerald-50 text-emerald-700 border-emerald-200", accent: "border-emerald-400", emoji: "🟢" },
  strong_objection: { en: "Strong objection", he: "התנגדות חזקה",    pill: "bg-orange-50 text-orange-700 border-orange-200",     accent: "border-orange-400", emoji: "🟠" },
  price_objection:  { en: "Price concern",    he: "חשש מחיר",        pill: "bg-amber-50 text-amber-700 border-amber-200",        accent: "border-amber-400",  emoji: "🟠" },
  hesitation:       { en: "Hesitation",       he: "היסוס",          pill: "bg-yellow-50 text-yellow-700 border-yellow-200",     accent: "border-yellow-400", emoji: "🟡" },
  rejection:        { en: "Rejection",        he: "דחייה",          pill: "bg-red-50 text-red-700 border-red-200",              accent: "border-red-400",    emoji: "🔴" },
  urgency:          { en: "Urgency",          he: "דחיפות",         pill: "bg-violet-50 text-violet-700 border-violet-200",     accent: "border-violet-400", emoji: "⚡" },
  confusion:        { en: "Confusion",        he: "בלבול",          pill: "bg-sky-50 text-sky-700 border-sky-200",              accent: "border-sky-400",    emoji: "🔵" },
  churn_risk:       { en: "Churn risk",       he: "סיכון נטישה",     pill: "bg-rose-50 text-rose-700 border-rose-200",           accent: "border-rose-500",   emoji: "🚨" },
};

const COACHING: Record<SignalKind, Record<"strong" | "soft", { en: Coaching; he: Coaching }>> = {
  buy_intent: {
    strong: {
      en: { headline: "🔥 Hot Lead!",      tip: "Move fast - confirm price + send the next-step link today." },
      he: { headline: "🔥 ליד חם!",        tip: "תפעל מהר - אשר מחיר ושלח לינק לצעד הבא היום." },
    },
    soft: {
      en: { headline: "Warm signal",       tip: "Acknowledge the intent and clarify the timeline." },
      he: { headline: "סימן חיובי",        tip: "הכר בכוונה ובדוק לוח זמנים." },
    },
  },
  strong_objection: {
    strong: {
      en: { headline: "Hard pushback",     tip: "Don't argue. Ask: 'Help me understand what's not fitting.'" },
      he: { headline: "התנגדות חזקה",      tip: "אל תתווכח. שאל: 'עזור לי להבין מה לא מתאים.'" },
    },
    soft: {
      en: { headline: "Soft pushback",     tip: "Probe gently - uncover the real concern under the words." },
      he: { headline: "התנגדות רכה",       tip: "חקור בעדינות - חשוף את הדאגה האמיתית מאחורי המילים." },
    },
  },
  price_objection: {
    strong: {
      en: { headline: "Price concern",     tip: "Reframe value. Show ROI vs the cost of doing nothing - not the sticker." },
      he: { headline: "חשש מחיר",          tip: "מסגר ערך מחדש. הראה ROI מול עלות אי-פעולה - לא את המחיר." },
    },
    soft: {
      en: { headline: "Budget worry",      tip: "Lean into the value: remind them of the outcomes they'll unlock." },
      he: { headline: "חשש תקציבי",        tip: "התמקד בערך: הזכר להם את התוצאות שהם משיגים." },
    },
  },
  hesitation: {
    strong: {
      en: { headline: "Visible doubt",     tip: "Surface the unsaid: 'What's the one thing holding you back?'" },
      he: { headline: "ספק גלוי",          tip: "הוצא את הלא-נאמר: 'מה הדבר היחיד שמעכב אותך?'" },
    },
    soft: {
      en: { headline: "Mild doubt",        tip: "Reassure with social proof - share a similar customer's win." },
      he: { headline: "ספק קל",            tip: "הרגע עם הוכחה חברתית - שתף הצלחה של לקוח דומה." },
    },
  },
  rejection: {
    strong: {
      en: { headline: "Closing the door",  tip: "Don't push. Acknowledge, thank them, leave a respectful door open." },
      he: { headline: "סוגר את הדלת",      tip: "אל תלחץ. הכר, הודה והשאר דלת פתוחה בכבוד." },
    },
    soft: {
      en: { headline: "Backing away",      tip: "One last clarifying question - then respect the no." },
      he: { headline: "מתרחק",             tip: "שאלה מבהירה אחרונה - ואז כבד את ה'לא'." },
    },
  },
  urgency: {
    strong: {
      en: { headline: "Time pressure",     tip: "Fast-track: skip discovery, propose the next concrete step now." },
      he: { headline: "לחץ זמן",           tip: "מסלול מהיר: דלג על שיחת גילוי והצע את הצעד הבא הקונקרטי עכשיו." },
    },
    soft: {
      en: { headline: "Some urgency",      tip: "Set a clear timeline so they know exactly what happens when." },
      he: { headline: "מעט דחיפות",        tip: "קבע לוח זמנים ברור כדי שידעו בדיוק מה קורה ומתי." },
    },
  },
  confusion: {
    strong: {
      en: { headline: "Lost the thread",   tip: "Stop. Slow down. Use simpler words - one concept at a time." },
      he: { headline: "איבד את החוט",      tip: "עצור. האט. מילים פשוטות - רעיון אחד בכל פעם." },
    },
    soft: {
      en: { headline: "Some confusion",    tip: "Re-explain the last point with a concrete example." },
      he: { headline: "מעט בלבול",         tip: "הסבר שוב את הנקודה האחרונה עם דוגמה קונקרטית." },
    },
  },
  churn_risk: {
    strong: {
      en: { headline: "🚨 Churn risk",     tip: "Stop selling. Listen. Escalate to a CSM if available." },
      he: { headline: "🚨 סיכון נטישה",    tip: "תפסיק למכור. תקשיב. הסלם ל-CSM אם אפשר." },
    },
    soft: {
      en: { headline: "Disengaging",       tip: "Re-engage: ask about their current experience, not the product." },
      he: { headline: "מתנתק",             tip: "התחבר מחדש: שאל על החוויה הנוכחית, לא על המוצר." },
    },
  },
};

export function MessageSignals({ signals }: { signals?: Signal[] | null }) {
  const { locale } = useI18n();
  const lang = locale === "he" ? "he" : "en";

  if (!Array.isArray(signals) || signals.length === 0) return null;

  return (
    <div className="flex flex-col items-start gap-1 mt-1.5 max-w-[85%] md:max-w-[75%]">
      {signals.map((s, i) => {
        const meta = CHIP_META[s.kind];
        const coach = COACHING[s.kind]?.[s.severity]?.[lang];
        if (!meta || !coach) return null;
        const label = meta[lang];
        const tooltip = `"${s.evidence}" - ${Math.round(s.confidence * 100)}%`;
        return (
          <div
            key={`${s.kind}-${i}`}
            className={`flex items-stretch border-l-2 ${meta.accent} bg-white/60 backdrop-blur-sm rounded-r-md shadow-sm overflow-hidden`}
          >
            <div className="flex flex-col px-2 py-1 gap-0.5">
              <div
                title={tooltip}
                className={`inline-flex items-center gap-1 self-start px-1.5 py-0.5 text-[10px] font-semibold rounded-full border ${meta.pill}`}
              >
                <span className="text-[9px]">{meta.emoji}</span>
                <span>{label}</span>
                {s.severity === "strong" && <span className="text-[8px] opacity-70">!</span>}
              </div>
              <div className="text-[11px] leading-tight">
                <span className="font-semibold text-gray-800">{coach.headline}</span>
                <span className="text-gray-500"> - {coach.tip}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
