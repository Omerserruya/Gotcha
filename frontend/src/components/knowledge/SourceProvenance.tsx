"use client";

/**
 * Where a knowledge document came from, shown on its row.
 *
 * Once the website scan started writing entries automatically, a customer
 * opening Knowledge saw a list of documents with no way to tell which ones
 * they had written and which the machine had generated - which matters a lot
 * before you edit or delete one. This renders the provenance the ingestion
 * path stamps into `metadata`.
 *
 * Internal identifiers are deliberately NOT rendered. The metadata is allowed
 * to carry a checksum and a dedupe key because the reconciler needs them; the
 * customer does not, and a tenant id must never reach the UI at all.
 */

import clsx from "clsx";

export interface DocProvenance {
  origin?: string;
  topic?: string;
  sourceType?: string;
  sourceUrl?: string;
  normalizedUrl?: string;
  language?: string;
  createdDuringOnboarding?: boolean;
  lastRefreshedAt?: string;
  manualEdit?: boolean;
}

export function readProvenance(metadata: unknown): DocProvenance | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const m = metadata as Record<string, unknown>;
  if (m.origin !== "onboarding") return null;
  return {
    origin: String(m.origin),
    topic: typeof m.topic === "string" ? m.topic : undefined,
    sourceType: typeof m.sourceType === "string" ? m.sourceType : undefined,
    sourceUrl: typeof m.sourceUrl === "string" ? m.sourceUrl : undefined,
    normalizedUrl: typeof m.normalizedUrl === "string" ? m.normalizedUrl : undefined,
    language: typeof m.language === "string" ? m.language : undefined,
    createdDuringOnboarding: m.createdDuringOnboarding === true,
    lastRefreshedAt: typeof m.lastRefreshedAt === "string" ? m.lastRefreshedAt : undefined,
    manualEdit: m.manualEdit === true,
  };
}

const SOURCE_LABEL: Record<string, { en: string; he: string }> = {
  onboarding_scan: { en: "From website scan", he: "מסריקת האתר" },
  onboarding_answer: { en: "You answered this", he: "תשובה שמסרתם" },
  readiness_answer: { en: "You answered this", he: "תשובה שמסרתם" },
  url: { en: "Web page", he: "עמוד באתר" },
  file: { en: "Uploaded file", he: "קובץ שהועלה" },
  drive: { en: "Google Drive", he: "Google Drive" },
};

function relativeDay(iso: string | undefined, he: boolean): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return he ? "היום" : "today";
  if (days === 1) return he ? "אתמול" : "yesterday";
  if (days < 30) return he ? `לפני ${days} ימים` : `${days}d ago`;
  const months = Math.floor(days / 30);
  return he ? `לפני ${months} חודשים` : `${months}mo ago`;
}

export function SourceProvenance({ metadata, he }: { metadata: unknown; he: boolean }) {
  const p = readProvenance(metadata);
  if (!p) return null;

  const label = p.sourceType ? SOURCE_LABEL[p.sourceType] : undefined;
  const refreshed = relativeDay(p.lastRefreshedAt, he);

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 align-middle" data-testid="doc-provenance">
      {label && (
        <span className={clsx(
          "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
          p.sourceType === "onboarding_scan" ? "bg-primary-50 text-primary-600" : "bg-gray-100 text-gray-500",
        )}>
          {he ? label.he : label.en}
        </span>
      )}
      {p.manualEdit && (
        <span
          className="rounded-md bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700"
          title={he ? "ערכתם את הרשומה - סריקה חוזרת לא תדרוס אותה" : "You edited this - a re-scan won't overwrite it"}
        >
          {he ? "נערך ידנית" : "Edited by you"}
        </span>
      )}
      {refreshed && (
        <span className="text-[10px] text-gray-400">
          {he ? `רוענן ${refreshed}` : `refreshed ${refreshed}`}
        </span>
      )}
      {p.sourceUrl && (
        <a
          href={p.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[10px] text-blue-500 hover:underline truncate max-w-[220px]"
          dir="ltr"
        >
          {p.normalizedUrl || p.sourceUrl}
        </a>
      )}
    </span>
  );
}

export default SourceProvenance;
