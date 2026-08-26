"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  listHistoricalImports,
  getHistoricalImport,
  listKnowledgeCandidates,
  approveKnowledgeCandidate,
  rejectKnowledgeCandidate,
  bulkApproveKnowledgeCandidates,
  bulkRejectKnowledgeCandidates,
  type HistoricalImportSummary,
  type HistoricalTopic,
  type KnowledgeCandidateView,
} from "@/lib/api";
import { hasHistoricalResults, type HistoricalImportView } from "@/lib/historical-import-client";

/**
 * "What GOTCHA learned" - the results of a historical import, and the queue
 * where the owner decides what becomes real knowledge.
 *
 * Two things on one page, in this order, on purpose:
 *
 *   1. What we found, in numbers they can check against their own sense of
 *      their business. This is the moment the product either earns trust or
 *      loses it, and it earns it by being verifiable rather than impressive.
 *   2. What we would like to add, one item at a time, with the evidence
 *      attached and nothing pre-selected.
 *
 * Nothing on this page writes to the knowledge base without a click. That is
 * the whole design: historical answers are what employees once SAID, which is
 * evidence of policy and not policy itself.
 */
export function DiscoveredKnowledge() {
  const { token } = useAuth();
  const { t, locale } = useI18n();
  const n = useCallback(
    (v: number) => v.toLocaleString(locale === "he" ? "he-IL" : "en-US"),
    [locale],
  );

  const [imp, setImp] = useState<
    (HistoricalImportView & { summary: HistoricalImportSummary | null; topTopics: HistoricalTopic[] }) | null
  >(null);
  const [candidates, setCandidates] = useState<KnowledgeCandidateView[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const list = await listHistoricalImports(token);
      // The most recent import that actually has results. An import still
      // transferring has nothing to review, and showing its empty queue would
      // read as "we found nothing".
      const latest = list.imports.find((i) => hasHistoricalResults(i.status));
      if (!latest) {
        setImp(null);
        setCandidates([]);
        return;
      }
      const [full, cands] = await Promise.all([
        getHistoricalImport(token, latest.id),
        listKnowledgeCandidates(token, latest.id, "PENDING"),
      ]);
      setImp(full);
      setCandidates(cands.candidates);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const approvableCount = useMemo(
    () => candidates.filter((c) => c.bulkApprovable).length,
    [candidates],
  );

  async function onApprove(candidate: KnowledgeCandidateView, answer?: string) {
    if (!token) return;
    setBusy(true);
    setNotice(null);
    try {
      await approveKnowledgeCandidate(token, candidate.id, answer ? { answer } : undefined);
      setCandidates((prev) => prev.filter((c) => c.id !== candidate.id));
      setNotice(t("historicalImport.review.approved"));
    } catch (err: any) {
      // The server's error field is a machine code ("conflict_requires_answer"),
      // not something to show a reviewer raw.
      setNotice(
        err?.code === "conflict_requires_answer"
          ? t("historicalImport.review.conflictRequired")
          : err?.message ?? "",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onReject(candidate: KnowledgeCandidateView) {
    if (!token) return;
    setBusy(true);
    setNotice(null);
    try {
      await rejectKnowledgeCandidate(token, candidate.id);
      setCandidates((prev) => prev.filter((c) => c.id !== candidate.id));
      setNotice(t("historicalImport.review.rejected"));
    } catch (err: any) {
      setNotice(err?.message ?? "");
    } finally {
      setBusy(false);
    }
  }

  async function onBulkApprove() {
    if (!token || !imp) return;
    setBusy(true);
    try {
      const res = await bulkApproveKnowledgeCandidates(token, imp.id);
      setNotice(t("historicalImport.review.bulkApproved", { count: n(res.approved) }));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function onBulkReject() {
    if (!token || !imp) return;
    setBusy(true);
    try {
      const res = await bulkRejectKnowledgeCandidates(token, imp.id);
      setNotice(t("historicalImport.review.bulkRejected", { count: n(res.rejected) }));
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="p-6 text-sm text-gray-500">...</div>;
  }

  if (!imp) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-lg font-semibold text-gray-900">
          {t("historicalImport.review.title")}
        </h1>
        <p className="mt-2 text-sm text-gray-600">{t("historicalImport.review.empty")}</p>
        <p className="mt-1 text-sm text-gray-500">{t("historicalImport.review.emptyHint")}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <ResultsHeader imp={imp} n={n} t={t} />

      <div className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              {t("historicalImport.review.title")}
            </h2>
            <p className="mt-1 text-sm text-gray-600">{t("historicalImport.review.subtitle")}</p>
          </div>
          {candidates.length > 0 && (
            <div className="flex gap-2">
              {/*
                Only ever offered for items the SERVER marked safe: no conflicts,
                and consistency above the shared threshold. The count comes from
                the same flag the endpoint enforces, so the button can never
                promise more than the endpoint will do.
              */}
              {approvableCount > 0 && (
                <button
                  onClick={onBulkApprove}
                  disabled={busy}
                  className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                >
                  {t("historicalImport.review.bulkApprove")} ({n(approvableCount)})
                </button>
              )}
              <button
                onClick={onBulkReject}
                disabled={busy}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {t("historicalImport.review.bulkReject")}
              </button>
            </div>
          )}
        </div>

        {notice && (
          <div className="mt-3 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-700">{notice}</div>
        )}

        {candidates.length === 0 ? (
          <p className="mt-4 text-sm text-gray-500">{t("historicalImport.review.empty")}</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {candidates.map((c) => (
              <CandidateCard
                key={c.id}
                candidate={c}
                busy={busy}
                onApprove={onApprove}
                onReject={onReject}
                n={n}
                t={t}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Results header ──────────────────────────────────────────

function ResultsHeader({
  imp,
  n,
  t,
}: {
  imp: HistoricalImportView & { summary: HistoricalImportSummary | null; topTopics: HistoricalTopic[] };
  n: (v: number) => string;
  t: (k: string, vars?: Record<string, string>) => string;
}) {
  const s = imp.summary;
  const topics = imp.topTopics ?? [];

  return (
    <div>
      <h1 className="text-lg font-semibold text-gray-900">
        {t("historicalImport.results.title")}
      </h1>
      <p className="mt-1 text-sm text-gray-600">{t("historicalImport.results.subtitle")}</p>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t("historicalImport.results.messages")} value={n(imp.importedMessages)} />
        <Stat label={t("historicalImport.results.customers")} value={n(imp.importedCustomers)} />
        {/* Only shown when a system of record is connected AND matched
            something. A hard "0 matched" for a business with no Shopify would
            read as a failure rather than as "not applicable". */}
        {s && s.matchedSourceOfTruth > 0 && (
          <Stat
            label={t("historicalImport.results.matched")}
            value={`${n(s.matchedSourceOfTruth)} (${Math.round(s.sourceOfTruthShare * 100)}%)`}
          />
        )}
        <Stat
          label={t("historicalImport.results.suggestions")}
          value={n(imp.knowledgeCandidateCount)}
        />
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-medium text-gray-900">
          {t("historicalImport.results.topicsTitle")}
        </h3>
        {topics.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">{t("historicalImport.results.topicsEmpty")}</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {topics.map((topic) => (
              <li key={topic.topic} className="flex items-center gap-3">
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-gray-700">
                  {Math.round(topic.share * 100)}%
                </span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                  <span
                    className="block h-full rounded-full bg-gray-800"
                    style={{ width: `${Math.max(2, Math.round(topic.share * 100))}%` }}
                  />
                </span>
                <span className="w-40 shrink-0 truncate text-xs text-gray-700">{topic.topic}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        The methodology, in the open, next to the numbers it explains.

        Deliberately no "X% could be automated" anywhere on this page. There is
        no honest way to compute it from conversation data, and a fabricated
        headline would make the numbers that ARE real look invented too.
      */}
      {s && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-700">
            {t("historicalImport.results.methodology")}
          </summary>
          <div className="mt-2 space-y-1.5 rounded-md bg-gray-50 p-3 text-xs leading-relaxed text-gray-600">
            <p>
              {t("historicalImport.results.recurring", {
                percent: String(Math.round(s.recurringInquiryShare * 100)),
              })}
            </p>
            {Object.values(s.methodology ?? {}).map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p>{t("historicalImport.results.windowNote", { days: String(imp.windowDays) })}</p>
          </div>
        </details>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="text-lg font-semibold tabular-nums text-gray-900">{value}</div>
      <div className="mt-0.5 text-xs text-gray-500">{label}</div>
    </div>
  );
}

// ─── One suggestion ──────────────────────────────────────────

function CandidateCard({
  candidate,
  busy,
  onApprove,
  onReject,
  n,
  t,
}: {
  candidate: KnowledgeCandidateView;
  busy: boolean;
  onApprove: (c: KnowledgeCandidateView, answer?: string) => void;
  onReject: (c: KnowledgeCandidateView) => void;
  n: (v: number) => string;
  t: (k: string, vars?: Record<string, string>) => string;
}) {
  const [showExamples, setShowExamples] = useState(false);
  // A conflicted suggestion opens in edit mode with an empty answer. There is
  // no default to pre-fill: the business gave two answers, and pre-filling
  // either one is the silent choice the whole conflict flow exists to prevent.
  const [editing, setEditing] = useState(candidate.conflict);
  const [draft, setDraft] = useState(candidate.conflict ? "" : candidate.answer);

  const confidenceKey =
    candidate.confidenceLabel === "high"
      ? "historicalImport.review.confidenceHigh"
      : candidate.confidenceLabel === "medium"
        ? "historicalImport.review.confidenceMedium"
        : "historicalImport.review.confidenceLow";

  return (
    <li className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        {candidate.category && (
          <span className="rounded-full bg-gray-900/5 px-2 py-0.5 text-[11px] font-medium text-gray-600">
            {t(`historicalImport.category.${candidate.category}`)}
          </span>
        )}
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700">
          {candidate.topic}
        </span>
        {candidate.requiresLiveLookup && (
          <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-800 ring-1 ring-violet-200">
            {t("historicalImport.review.liveLookup")}
          </span>
        )}
        {candidate.conflict && (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-amber-200">
            {t("historicalImport.review.conflictTitle")}
          </span>
        )}
        {candidate.alreadyCoveredBy && (
          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-800 ring-1 ring-blue-200">
            {t("historicalImport.review.alreadyCovered", {
              title: candidate.alreadyCoveredBy.title,
            })}
          </span>
        )}
      </div>

      <p className="mt-2 text-sm font-medium text-gray-900">{candidate.question}</p>

      {candidate.conflict && candidate.variants ? (
        <div className="mt-2 space-y-2">
          <p className="text-xs leading-relaxed text-gray-600">
            {t("historicalImport.review.conflictBody")}
          </p>
          {candidate.variants.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => {
                setDraft(v.answer);
                setEditing(true);
              }}
              className="block w-full rounded-md border border-gray-200 p-2 text-start hover:border-gray-400"
            >
              <div className="text-sm text-gray-800">{v.answer}</div>
              <div className="mt-1 text-[11px] text-gray-500">
                {t("historicalImport.review.conflictVariant", { count: n(v.occurrenceCount) })}
              </div>
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-sm text-gray-700">{candidate.answer}</p>
      )}

      {/* The reasoning behind the answer, shown because it is the part a
          reviewer can most easily check and most easily correct. The rule is
          often obviously right; whether the THINKING behind it is right is the
          judgement only they can make, and it travels into the knowledge base
          with the answer. */}
      {candidate.reasoning && (
        <p className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-600">
          <span className="font-medium text-gray-700">
            {t("historicalImport.review.reasoningLabel")}:
          </span>{" "}
          {candidate.reasoning}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
        <span>
          {t("historicalImport.review.evidence", {
            conversations: n(candidate.occurrenceCount),
            customers: n(candidate.customerCount),
          })}
        </span>
        <span>
          {t("historicalImport.review.confidence")}: {t(confidenceKey)}
        </span>
        {candidate.examples.length > 0 && (
          <button
            type="button"
            onClick={() => setShowExamples((v) => !v)}
            className="underline hover:text-gray-700"
          >
            {showExamples
              ? t("historicalImport.review.hideExamples")
              : t("historicalImport.review.viewExamples")}
          </button>
        )}
      </div>

      {/* Said in words, every time, next to the score. A number labelled
          "confidence" invites the reading that the answer is correct, and it
          only ever meant that we saw it consistently. */}
      <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
        {t("historicalImport.review.confidenceNote")}
      </p>

      {showExamples && (
        <ul className="mt-2 space-y-2 rounded-md bg-gray-50 p-2">
          {candidate.examples.map((e, i) => (
            <li key={i} className="text-xs">
              <div className="text-gray-600">{e.question}</div>
              <div className="mt-0.5 text-gray-800">{e.answer}</div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <div className="mt-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
            placeholder={
              candidate.conflict ? t("historicalImport.review.conflictRequired") : undefined
            }
          />
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {editing ? (
          <>
            <button
              onClick={() => onApprove(candidate, draft.trim())}
              disabled={busy || draft.trim().length === 0}
              className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-40"
            >
              {t("historicalImport.review.save")}
            </button>
            <button
              onClick={() => {
                // For a conflict, "cancel" clears the choice but stays in the
                // choose-an-answer flow - leaving it would land on a plain
                // Approve that the server must refuse.
                setEditing(candidate.conflict);
                setDraft(candidate.conflict ? "" : candidate.answer);
              }}
              disabled={busy}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              {t("historicalImport.review.cancel")}
            </button>
          </>
        ) : (
          <>
            <button
              // A conflicted item has no "the" answer to approve - the server
              // 409s a bare approve by design (conflict_requires_answer).
              // Matan hit exactly this: Cancel dropped him back here, the
              // plain Approve fired the bare request, and four silent 409s
              // later nothing had happened. For a conflict this button now
              // reopens the choose-an-answer flow instead of calling the API.
              onClick={() => (candidate.conflict ? setEditing(true) : onApprove(candidate))}
              disabled={busy}
              className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {t("historicalImport.review.approve")}
            </button>
            <button
              onClick={() => setEditing(true)}
              disabled={busy}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              {t("historicalImport.review.edit")}
            </button>
          </>
        )}
        <button
          onClick={() => onReject(candidate)}
          disabled={busy}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-800"
        >
          {t("historicalImport.review.reject")}
        </button>
      </div>
    </li>
  );
}
