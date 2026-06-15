"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getCustomerSnapshot, type CustomerSnapshot, type SnapshotFact, type SnapshotOpportunity } from "@/lib/gotcha-api";

/**
 * Customer Intelligence Card (V2, Phase 3) - the Snapshot projection rendered
 * in the conversation Context Panel: WHO / WHAT (per-opportunity) / MISSING /
 * NEXT / NARRATIVE. Generated from CustomerProfile + Opportunity +
 * ConversationIntelligence + the gap engine.
 *
 * Renders nothing until there's something to show (no intelligence yet → no
 * clutter).
 */

function fmtValue(f: SnapshotFact, he: boolean): string {
  if (f.type === "boolean") return f.value ? (he ? "כן" : "Yes") : (he ? "לא" : "No");
  if (f.type === "number" && typeof f.value === "number") return f.value.toLocaleString();
  return String(f.value ?? "");
}

const OPP_LABELS: Record<string, { en: string; he: string; icon: string }> = {
  event_hall: { en: "Event", he: "אירוע", icon: "🎉" },
  real_estate: { en: "Property", he: "נכס", icon: "🏠" },
  recruiting: { en: "Candidate", he: "מועמד", icon: "💼" },
  ecommerce: { en: "Order", he: "הזמנה", icon: "📦" },
  general: { en: "Opportunity", he: "הזדמנות", icon: "🎯" },
};

export function CustomerIntelligenceCard({ conversationId }: { conversationId?: string }) {
  const { token } = useAuth();
  const { locale } = useI18n();
  const he = locale === "he";
  const [snap, setSnap] = useState<CustomerSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!token || !conversationId) return;
    setLoading(true);
    try {
      const res = await getCustomerSnapshot(token, { conversationId });
      setSnap(res.snapshot ?? null);
    } catch {
      setSnap(null);
    } finally {
      setLoading(false);
    }
  }, [token, conversationId]);

  useEffect(() => { load(); }, [load]);

  if (!snap || !snap.ok) return null;

  const hasContent =
    snap.opportunities.length > 0 ||
    snap.customerFacts.length > 0 ||
    snap.missing.length > 0 ||
    !!snap.next;
  if (!hasContent) return null;

  return (
    <div className="rounded-xl border border-violet-100 bg-gradient-to-b from-violet-50/60 to-white p-3 mb-2" dir={he ? "rtl" : "ltr"}>
      {/* Header */}
      <div className="flex items-center gap-1.5 mb-2">
        <svg className="w-3.5 h-3.5 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
        </svg>
        <span className="text-[11px] font-semibold text-violet-700 uppercase tracking-wide">
          {he ? "מודיעין לקוח" : "Customer Intelligence"}
        </span>
        {loading && <span className="w-3 h-3 border-2 border-violet-200 border-t-violet-500 rounded-full animate-spin" />}
      </div>

      {/* WHO */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        {snap.who.displayName && <span className="text-sm font-semibold text-gray-900">{snap.who.displayName}</span>}
        {snap.who.vipTier && <Badge tone="amber">⭐ {String(snap.who.vipTier)}</Badge>}
        {snap.who.language && <Badge tone="blue">{String(snap.who.language)}</Badge>}
        {snap.who.sentiment && <Badge tone={snap.who.sentiment === "negative" ? "red" : snap.who.sentiment === "positive" ? "green" : "gray"}>{snap.who.sentiment}</Badge>}
      </div>

      {/* WHAT - opportunities */}
      {snap.opportunities.map((o) => (
        <OpportunityBlock key={o.id} opp={o} he={he} />
      ))}

      {/* Customer-scope facts (durable) */}
      {snap.customerFacts.length > 0 && (
        <div className="mb-2">
          <SectionLabel>{he ? "פרטי לקוח" : "Customer"}</SectionLabel>
          <div className="flex flex-wrap gap-1">
            {snap.customerFacts.map((f) => <FactChip key={f.key} fact={f} he={he} />)}
          </div>
        </div>
      )}

      {/* MISSING */}
      {snap.missing.length > 0 && (
        <div className="mb-2">
          <SectionLabel>{he ? "חסר" : "Missing"}</SectionLabel>
          <div className="flex flex-wrap gap-1">
            {snap.missing.map((g) => (
              <span
                key={g.key}
                className={
                  "inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full border " +
                  (g.importance === "high" ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-gray-50 text-gray-500 border-gray-200")
                }
                title={g.required ? (he ? "שדה חובה" : "Required") : (he ? "רלוונטי לשלב" : "Stage-relevant")}
              >
                ⚠ {g.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* NEXT */}
      {snap.next && (
        <div className="flex items-start gap-1.5 rounded-lg bg-violet-100/60 px-2 py-1.5">
          <span className="text-violet-500 text-xs mt-0.5">▶</span>
          <span className="text-[12px] text-violet-900">
            <span className="font-medium">{he ? "הצעד הבא: " : "Next: "}</span>{snap.next}
          </span>
        </div>
      )}

      {/* NARRATIVE */}
      {snap.narrative && (
        <details className="mt-2 group">
          <summary className="text-[11px] text-gray-400 cursor-pointer hover:text-gray-600 list-none">
            {he ? "סיכום מלא" : "Summary"} ▾
          </summary>
          <p className="text-[11px] text-gray-600 mt-1 leading-relaxed whitespace-pre-wrap">{snap.narrative}</p>
        </details>
      )}
    </div>
  );
}

function OpportunityBlock({ opp, he }: { opp: SnapshotOpportunity; he: boolean }) {
  const meta = OPP_LABELS[opp.type] ?? OPP_LABELS.general;
  const statusLabel = he
    ? ({ OPEN: "פתוח", WON: "נסגר בהצלחה", LOST: "אבד", ABANDONED: "ננטש", ARCHIVED: "בארכיון" } as Record<string, string>)[opp.status] ?? opp.status
    : opp.status.charAt(0) + opp.status.slice(1).toLowerCase();
  return (
    <div className="mb-2 rounded-lg border border-gray-100 bg-white/70 p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[12px] font-semibold text-gray-800">
          {meta.icon} {opp.title || (he ? meta.he : meta.en)}
        </span>
        <span className={"text-[10px] px-1.5 py-0.5 rounded-full " + (opp.status === "OPEN" ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500")}>
          {statusLabel}
        </span>
      </div>
      {opp.estimatedValue != null && (
        <div className="text-[11px] text-gray-500 mb-1">💰 {opp.estimatedValue.toLocaleString()}</div>
      )}
      {opp.facts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {opp.facts.map((f) => <FactChip key={f.key} fact={f} he={he} />)}
        </div>
      )}
    </div>
  );
}

function FactChip({ fact, he }: { fact: SnapshotFact; he: boolean }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-md border bg-white " +
        (fact.uncertain ? "border-dashed border-gray-300 text-gray-500" : "border-gray-200 text-gray-700")
      }
      title={fact.uncertain ? (he ? "לא מאומת - כדאי לוודא" : "Unconfirmed - verify") : `${fact.source}`}
    >
      <span className="text-gray-400">{fact.label}:</span>
      <span className="font-medium">{fmtValue(fact, he)}</span>
      {fact.uncertain && <span className="text-amber-500">?</span>}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-medium text-gray-400 uppercase tracking-wide mb-1">{children}</div>;
}

function Badge({ tone, children }: { tone: "amber" | "blue" | "green" | "red" | "gray"; children: React.ReactNode }) {
  const cls = {
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
    green: "bg-green-50 text-green-700 border-green-200",
    red: "bg-red-50 text-red-700 border-red-200",
    gray: "bg-gray-50 text-gray-600 border-gray-200",
  }[tone];
  return <span className={"text-[10px] px-1.5 py-0.5 rounded-full border " + cls}>{children}</span>;
}
