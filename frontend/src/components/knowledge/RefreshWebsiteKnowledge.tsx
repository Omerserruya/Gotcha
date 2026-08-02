"use client";

/**
 * "Refresh website knowledge" - re-scan the tenant's site and reconcile the
 * result into the Knowledge Base.
 *
 * The interesting part of this control is what it says AFTERWARDS. A refresh
 * that silently reports "done" is indistinguishable from one that quietly
 * failed to ingest half the site, so the result summary reports the real
 * per-outcome counts the server returned: added, updated, unchanged,
 * preserved (a human edit the scan refused to overwrite), removed (a page that
 * no longer exists) and failed. Failures are shown, not swallowed, and the
 * retry is safe because reconciliation is idempotent - running it twice
 * produces "unchanged", not duplicates.
 *
 * Deliberately standalone so the Knowledge Manager can mount it too.
 */

import { useCallback, useRef, useState } from "react";
import { useI18n } from "@/context/I18nContext";
import ConfirmModal from "@/components/ConfirmModal";
import { discoverBusiness, getBusinessDiscovery, type KnowledgeSyncReport } from "@/lib/api";
import clsx from "clsx";

type Phase = "idle" | "confirming" | "scanning" | "done" | "error";

interface Props {
  token: string;
  /** Known website domain. Without one there is nothing to re-scan. */
  domain?: string | null;
  /** Called after a refresh settles so the caller can reload its document list. */
  onRefreshed?: () => void;
  className?: string;
}

export function RefreshWebsiteKnowledge({ token, domain, onRefreshed, className }: Props) {
  const { locale, t } = useI18n();
  const he = locale === "he";

  const [phase, setPhase] = useState<Phase>("idle");
  const [report, setReport] = useState<KnowledgeSyncReport | null>(null);
  const [error, setError] = useState("");
  const pollRef = useRef<number | null>(null);

  const run = useCallback(async () => {
    if (!token || !domain) return;
    setPhase("scanning");
    setError("");
    setReport(null);
    try {
      const res = await discoverBusiness(token, domain, locale);

      if (!res.data.ok) {
        // A scan already running is not an error the user caused - poll it out
        // rather than telling them to try again while it finishes.
        if (res.data.reason === "scan_in_progress") {
          let ticks = 0;
          pollRef.current = window.setInterval(async () => {
            ticks += 1;
            const d = await getBusinessDiscovery(token).catch(() => null);
            const status = d?.data.discovery?.status;
            if (status !== "SCANNING" || ticks > 80) {
              if (pollRef.current) window.clearInterval(pollRef.current);
              setPhase(status === "FAILED" ? "error" : "done");
              if (status === "FAILED") setError(he ? "הסריקה נכשלה. הידע הקיים נשמר." : "The scan failed. Your existing knowledge is intact.");
              onRefreshed?.();
            }
          }, 2500);
          return;
        }
        setPhase("error");
        setError(he ? "הסריקה נכשלה. הידע הקיים נשמר." : "The scan failed. Your existing knowledge is intact.");
        return;
      }

      const knowledge = res.data.knowledge ?? null;
      setReport(knowledge);
      if (!knowledge || knowledge.ok === false) {
        // The site was scanned but ingestion did not happen. Saying "refreshed"
        // here would be a false success - the employee learned nothing.
        setPhase("error");
        setError(
          he
            ? "האתר נסרק, אך עדכון מאגר הידע נכשל. הידע הקיים נשמר - אפשר לנסות שוב."
            : "The site was scanned, but updating the knowledge base failed. Your existing knowledge is intact - you can retry.",
        );
      } else {
        setPhase("done");
      }
      onRefreshed?.();
    } catch (e: any) {
      setPhase("error");
      setError(e?.message || (he ? "הסריקה נכשלה." : "The scan failed."));
    }
  }, [token, domain, locale, he, onRefreshed]);

  if (!domain) return null;

  const busy = phase === "scanning";

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setPhase("confirming")}
        disabled={busy}
        data-testid="refresh-website-knowledge"
        className="flex items-center gap-2 rounded-xl border border-primary-200 bg-white px-4 py-2 text-sm font-medium text-primary-600 transition hover:bg-primary-50 disabled:opacity-50"
      >
        <svg className={clsx("w-4 h-4", busy && "animate-spin")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
        </svg>
        {busy
          ? (he ? "סורק מחדש…" : "Refreshing…")
          : (he ? "רענון ידע מהאתר" : "Refresh website knowledge")}
      </button>

      <ConfirmModal
        isOpen={phase === "confirming"}
        title={he ? "לרענן את הידע מהאתר?" : "Refresh website knowledge?"}
        message={
          he
            ? `נסרוק שוב את ${domain}, נעדכן רשומות ידע שהשתנו ונוסיף עמודים חדשים. רשומות שערכתם ידנית יישארו כפי שהן, וידע שהוספתם בעצמכם לא ייגע. זה לוקח בערך דקה.`
            : `We'll scan ${domain} again, update the knowledge entries that changed and add any new pages. Entries you edited by hand are left as they are, and knowledge you added yourself is untouched. This takes about a minute.`
        }
        confirmText={he ? "רענון" : "Refresh"}
        cancelText={he ? "ביטול" : "Cancel"}
        onConfirm={() => { setPhase("scanning"); void run(); }}
        onCancel={() => setPhase("idle")}
      />

      {busy && (
        <p className="mt-2 text-xs text-primary-600 bg-primary-50 rounded-xl px-3 py-2">
          {he
            ? "קורא את האתר ומעדכן את מאגר הידע. הידע הקיים זמין לאורך כל התהליך."
            : "Reading your site and updating the knowledge base. Your existing knowledge stays available throughout."}
        </p>
      )}

      {phase === "error" && (
        <div className="mt-2 rounded-xl bg-rose-50 px-3 py-2">
          <p className="text-xs text-rose-700">{error}</p>
          <button
            type="button"
            onClick={() => void run()}
            className="mt-1.5 text-xs font-medium text-rose-700 underline hover:text-rose-900"
          >
            {he ? "לנסות שוב" : "Try again"}
          </button>
        </div>
      )}

      {phase === "done" && report && <ResultSummary report={report} he={he} />}
    </div>
  );
}

/**
 * The honest outcome. Every bucket is rendered, including the boring ones:
 * "42 unchanged" is the number that tells a customer the refresh did not
 * silently rewrite their knowledge base.
 */
function ResultSummary({ report, he }: { report: KnowledgeSyncReport; he: boolean }) {
  const rows: Array<{ key: string; label: string; value: number; tone: string }> = [
    { key: "added", label: he ? "נוספו" : "Added", value: report.added, tone: "text-green-700 bg-green-50" },
    { key: "updated", label: he ? "עודכנו" : "Updated", value: report.updated, tone: "text-blue-700 bg-blue-50" },
    { key: "unchanged", label: he ? "ללא שינוי" : "Unchanged", value: report.unchanged, tone: "text-gray-600 bg-gray-50" },
    { key: "preserved", label: he ? "נשמרו עריכות" : "Your edits kept", value: report.preserved, tone: "text-violet-700 bg-violet-50" },
    { key: "removed", label: he ? "הוסרו" : "No longer on site", value: report.removed, tone: "text-amber-700 bg-amber-50" },
    { key: "failed", label: he ? "נכשלו" : "Failed", value: report.failed, tone: "text-rose-700 bg-rose-50" },
  ];

  const failures = report.details.filter((d) => d.action === "failed");

  return (
    <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-3.5 shadow-sm" data-testid="refresh-result">
      <p className="text-xs font-semibold text-gray-900 mb-2">
        {he ? "תוצאות הרענון" : "Refresh result"}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {rows.map((r) => (
          <span
            key={r.key}
            data-testid={`refresh-count-${r.key}`}
            className={clsx("rounded-lg px-2 py-1 text-[11px] font-medium tabular-nums", r.tone)}
          >
            {r.value} {r.label}
          </span>
        ))}
      </div>

      {failures.length > 0 && (
        <div className="mt-2.5 border-t border-gray-100 pt-2">
          <p className="text-[11px] font-medium text-rose-700 mb-1">
            {he ? "לא הצלחנו לעבד:" : "We couldn't process:"}
          </p>
          <ul className="space-y-0.5">
            {failures.slice(0, 5).map((f, i) => (
              <li key={i} className="text-[11px] text-gray-500 truncate">
                {f.title || f.dedupeKey}
                {f.reason ? <span className="text-gray-400"> - {f.reason}</span> : null}
              </li>
            ))}
          </ul>
          {failures.length > 5 && (
            <p className="text-[11px] text-gray-400 mt-0.5">
              {he ? `ועוד ${failures.length - 5}` : `and ${failures.length - 5} more`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default RefreshWebsiteKnowledge;
