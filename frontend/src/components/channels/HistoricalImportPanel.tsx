"use client";

import Link from "next/link";
import { useI18n } from "@/context/I18nContext";
import type { HistoricalImportView } from "@/lib/historical-import-client";

/**
 * The history-import state on a WhatsApp channel card.
 *
 * ── The one rule this component exists to keep ──
 *
 * Channel state and import state are separate, and this panel never touches the
 * first. A number that is connected and receiving messages says so at the top of
 * the card; whatever is happening down here, including an outright failure, does
 * not change that. A customer whose history import broke still has a working
 * WhatsApp channel, and telling them otherwise would send them to disconnect and
 * reconnect a channel that was fine.
 *
 * ── On the progress bar ──
 *
 * The bar only appears while the source is genuinely transferring, where we have
 * Meta's own percentage. Once analysis begins there is no honest percentage, so
 * the bar is replaced by counted work ("842 of 1,247 customers") or, before
 * there is anything to count, by plain stage text. The alternative - an invented
 * percentage that keeps moving - would undermine every real number on the
 * results page it leads to.
 */
export function HistoricalImportPanel({
  imp,
  resultsHref = "/ai-studio/knowledge?tab=discovered",
}: {
  imp: HistoricalImportView;
  resultsHref?: string;
}) {
  const { t, locale } = useI18n();
  const n = (v: number) => v.toLocaleString(locale === "he" ? "he-IL" : "en-US");

  const tone =
    imp.stage === "failed"
      ? "border-amber-200 bg-amber-50"
      : imp.stage === "unavailable"
        ? "border-gray-200 bg-gray-50"
        : imp.stage === "ready"
          ? "border-emerald-200 bg-emerald-50"
          : "border-blue-200 bg-blue-50";

  return (
    <div className={`mt-3 rounded-lg border p-3 ${tone}`} data-testid="historical-import-panel">
      {imp.stage === "transferring" && <Transferring imp={imp} />}
      {imp.stage === "analyzing" && <Analyzing imp={imp} />}
      {imp.stage === "ready" && <Ready imp={imp} resultsHref={resultsHref} />}
      {imp.stage === "unavailable" && <Unavailable imp={imp} />}
      {imp.stage === "failed" && <Failed imp={imp} resultsHref={resultsHref} />}
    </div>
  );

  /**
   * One bar, two phases.
   *
   * An import is two pieces of work of very different length - Meta sending the
   * history, then GOTCHA reading it - and a single bar spanning both would sit
   * near halfway for hours. Two labelled bars, each with its own percentage,
   * say where the work actually is.
   */
  function ProgressBar({ percent, label }: { percent: number; label: string }) {
    const clamped = Math.max(0, Math.min(100, percent));
    return (
      <>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-gray-900">{label}</span>
          <span className="text-sm tabular-nums text-gray-700">{clamped}%</span>
        </div>
        <div
          className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/70"
          role="progressbar"
          aria-label={label}
          aria-valuenow={clamped}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-blue-600 transition-all duration-500"
            style={{ width: `${clamped}%` }}
          />
        </div>
      </>
    );
  }

  function Transferring({ imp }: { imp: HistoricalImportView }) {
    return (
      <div>
        <ProgressBar
          percent={imp.percent ?? 0}
          label={t("historicalImport.transferring.title")}
        />
        {/* Said plainly, because the anxious question at this moment is
            "is my WhatsApp working right now" and the answer is yes. */}
        <p className="mt-2 text-xs leading-relaxed text-gray-600">
          {t("historicalImport.transferring.body")}
        </p>
      </div>
    );
  }

  function Analyzing({ imp }: { imp: HistoricalImportView }) {
    const counts = imp.analysisCounts;
    return (
      <div>
        {/* The transfer is finished by definition once analysis starts, so it
            stays on screen at 100 rather than disappearing - otherwise the bar
            appears to restart from zero and the work already done looks lost. */}
        <div className="opacity-60">
          <ProgressBar percent={100} label={t("historicalImport.transferring.title")} />
        </div>
        <div className="mt-3">
          <ProgressBar
            percent={imp.analysisPercent ?? 0}
            label={t("historicalImport.analyzing.title")}
          />
        </div>
        <p className="mt-2 text-xs leading-relaxed text-gray-600">
          {t("historicalImport.analyzing.body")}
        </p>
        {/* The counted work stays beneath the percentage. The bar says roughly
            how far; this says exactly what was done, and it is the number to
            trust if the two ever disagree. */}
        {counts && (
          <p className="mt-1 text-xs tabular-nums text-gray-700">
            {t("historicalImport.analyzing.customers", {
              analyzed: n(counts.analyzed),
              total: n(counts.total),
            })}
          </p>
        )}
      </div>
    );
  }

  function Ready({ imp, resultsHref }: { imp: HistoricalImportView; resultsHref: string }) {
    return (
      <div>
        <div className="text-sm font-medium text-gray-900">
          {t("historicalImport.ready.title")}
        </div>
        {/* Real counts, read from the import's persisted summary. The same row
            the results page and the completion email read, so the three can
            never quote different numbers. */}
        <p className="mt-1 text-xs text-gray-700">
          {t("historicalImport.ready.stats", {
            messages: n(imp.importedMessages),
            customers: n(imp.importedCustomers),
          })}
        </p>
        {imp.knowledgeCandidateCount > 0 && (
          <p className="mt-1 text-xs text-gray-700">
            {t("historicalImport.ready.suggestions", {
              count: n(imp.knowledgeCandidateCount),
            })}
          </p>
        )}
        <Link
          href={resultsHref}
          className="mt-2 inline-flex items-center gap-1 rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800"
        >
          {t("historicalImport.ready.cta")}
        </Link>
      </div>
    );
  }

  function Unavailable({ imp }: { imp: HistoricalImportView }) {
    return (
      <div>
        <div className="text-sm font-medium text-gray-900">
          {t("historicalImport.unavailable.title")}
        </div>
        {/* Not an error state. The owner switched history sharing off in their
            WhatsApp Business app, which is theirs to decide; framing it as a
            fault would send them looking for something to fix. */}
        <p className="mt-1 text-xs leading-relaxed text-gray-600">
          {t("historicalImport.unavailable.body")}
        </p>
      </div>
    );
  }

  function Failed({ imp, resultsHref }: { imp: HistoricalImportView; resultsHref: string }) {
    return (
      <div>
        <div className="text-sm font-medium text-gray-900">
          {t("historicalImport.failed.title")}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-gray-700">
          {imp.failureReason || t("historicalImport.failed.body")}
        </p>
        {/* The single most useful thing to say here, and the least obvious:
            Meta grants one history sync per onboarding, so there is no retry
            button we could offer. */}
        <p className="mt-1 text-xs leading-relaxed text-gray-600">
          {t("historicalImport.failed.reimport")}
        </p>
        {/* Partial results are kept. An import that broke during knowledge
            mining still linked customers and built memory, and hiding that
            would throw away work the customer already has. */}
        {imp.importedMessages > 0 && (
          <p className="mt-2 text-xs text-gray-700">
            {t("historicalImport.failed.partial", {
              messages: n(imp.importedMessages),
              customers: n(imp.importedCustomers),
            })}
          </p>
        )}
        {imp.hasResults && (
          <Link
            href={resultsHref}
            className="mt-2 inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-800 hover:bg-gray-50"
          >
            {t("historicalImport.ready.cta")}
          </Link>
        )}
      </div>
    );
  }
}
