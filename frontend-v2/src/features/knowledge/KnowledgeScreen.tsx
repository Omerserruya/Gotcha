import { getFormatter, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import {
  hasAmbiguousName,
  lastRefreshed,
  notReadyCount,
  undatedSources,
  type KnowledgeSource,
  type UnansweredQuestion,
} from '@/api/contracts/knowledge';
import { lastHeardFor, variantsOf, type Candidate } from '@/api/contracts/knowledge-candidates';

import {
  BookOpen,
  FolderSync,
  Globe,
  Layers,
  ListChecks,
  MessagesSquare,
  Shapes,
  Upload,
} from 'lucide-react';

import { GapRow } from './GapRow';
import { ResolveConflict } from './ResolveConflict';
import styles from './Knowledge.module.css';
import { UserText } from '@/design-system/primitives/text/UserText';

/**
 * Screen 08 - what GOTCHA knows, and what it does not.
 *
 * ── THE DATE, NOT THE VERDICT ──
 * The design labels each source *"Fresh"* and counts *"Out of date · 4"*.
 * `updatedAt` is real; **a staleness policy is not** - no threshold, no
 * field, no job anywhere in the platform. So each source says **when** it was
 * last refreshed and leaves the judgement to the reader, who knows their own
 * business well enough to decide whether two months is fine.
 *
 * ── FOUR WAYS IN, NOT THE DESIGN'S FIVE ──
 * The design lists *"Business core · Products & prices · Shopify · live"* as
 * a fifth source. **Omer ruled it out (2026-09-26): it is not a knowledge
 * source.** It is the part→system mapping on screen 14, and presenting it
 * here would have required inventing a read that treats it as one.
 *
 * The screen does not explain the absence, deliberately - nobody looking at
 * a knowledge screen misses a row that was never a knowledge row, and an
 * explanation would be the only place the idea appeared.
 *
 * ── AND THE CONFLICT PANEL'S OTHER AXIS IS COMING ──
 * Fact extraction from ingested documents is authorized, so *"your website
 * says ₪550, the PDF says ₪850"* will eventually be real. Nothing is
 * pre-built for it: the shape is unsettled, and the conversation-axis card
 * says truthfully what it knows - which is why widening it later will be an
 * addition rather than a correction.
 *
 * ── AND THE QUESTIONS ARE THE SCREEN ──
 * The design's headline counts - confident topics, thin topics, out of date -
 * have no source. What is real is **the list of questions GOTCHA could not
 * answer**, with `timesAsked` and `distinctAskers` kept apart: one person
 * asking twenty times is a stuck customer, twenty people asking once is a
 * missing page, and a single "asked 23 times" cannot tell you which.
 *
 * ── 08, MEASURED (S2) ──
 * A strip of four in one white card (25px figures); the conflict card (its
 * question, both answers side by side on `#FAF8F4`, the control under them);
 * then "Where it learns from" (grouped by how it came in, the documents' own
 * `sourceType`) beside "Questions it couldn't answer" (400). The two
 * figures nothing measures are "-" in their shape; the conflict answers are
 * sentences people wrote, so they are set at reading size, not 02's 22px.
 */
export async function KnowledgeScreen({
  sources,
  unanswered,
  conflicts,
  conflictsScannedAt,
  everImported,
  rescan = null,
}: {
  readonly sources: readonly KnowledgeSource[] | null;
  readonly unanswered: readonly UnansweredQuestion[] | null;
  readonly conflicts: readonly Candidate[] | null;
  readonly conflictsScannedAt: string | null;
  readonly everImported: boolean;
  /**
   * "Scan again" (11b, from Settings · Workspace since 2026-10-11): under
   * "Your website" when that group is listed, else first in the card - a
   * tenant whose website pages are not (or not yet) listed can still rescan.
   */
  readonly rescan?: ReactNode;
}) {
  const t = await getTranslations('knowledge');
  const format = await getFormatter();

  const date = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { day: 'numeric', month: 'long', year: 'numeric' }) : null;

  const undated = sources ? undatedSources(sources) : [];
  const groups = sources ? groupByWayIn(sources) : [];
  const websiteListed = groups.some((group) => group.way === 'website');
  const rescanBlock = rescan ? (
    <div className={styles.rescan} data-testid="knowledge-rescan">
      {rescan}
    </div>
  ) : null;

  return (
    <div className={styles.screen} data-testid="knowledge-screen">
      {/*
        ★ No strip of four figures (Omer, 2026-10-11: K3) - two of them had
        nothing measuring them, and the conflict and the gaps below say what
        needs an answer.
      */}

      {/*
        ════════════════════════════════════════════════════════════════════
        ★★ THE CONFLICT - AND IT IS NOT THE CONFLICT THE DESIGN DRAWS
        ════════════════════════════════════════════════════════════════════
        02 shows two NAMED SOURCES disagreeing. What this platform detects is
        the business having answered ONE question differently at different
        times (*"We do NOT pick one"*), clustered from an import. So the card
        says that: the question, each answer and how often it was heard. The
        scan runs inside the import only - the coverage line says so, always.
      */}
      {/*
        With nothing to show, the card keeps its SHAPE - a title row and one
        line - and loses its alarm: neutral, like "Worth changing" with no
        suggestion. What it compared goes on the card itself (`title`).
      */}
      <section
        className={styles.conflictCard}
        data-state={conflicts && conflicts.length > 0 && everImported ? 'found' : 'empty'}
        data-testid="conflicts-section"
        title={
          conflicts && conflicts.length > 0 && everImported ? undefined : t('conflicts.coverage')
        }
      >
        {conflicts === null ? (
          <div className={styles.conflictEmpty} data-testid="conflicts-unavailable">
            <p className={styles.conflictEmptyTitle}>{t('conflicts.emptyUnavailable')}</p>
            <p className={styles.conflictEmptyLine}>{t('conflicts.emptyUnavailableLine')}</p>
          </div>
        ) : !everImported ? (
          <div className={styles.conflictEmpty} data-testid="conflicts-never-scanned">
            <p className={styles.conflictEmptyTitle}>{t('conflicts.emptyNever')}</p>
            <p className={styles.conflictEmptyLine}>{t('conflicts.emptyNeverLine')}</p>
          </div>
        ) : conflicts.length === 0 ? (
          <div className={styles.conflictEmpty} data-testid="conflicts-none">
            <p className={styles.conflictEmptyTitle}>{t('conflicts.emptyNone')}</p>
            <p className={styles.conflictEmptyLine}>
              {conflictsScannedAt
                ? t('conflicts.emptyNoneLineWhen', { when: date(conflictsScannedAt) ?? '' })
                : t('conflicts.emptyNoneLine')}
            </p>
          </div>
        ) : (
          <ul className={styles.conflicts}>
            {conflicts.map((candidate) => {
              const variants = variantsOf(candidate);
              return (
                <li
                  key={candidate.id}
                  className={styles.conflict}
                  data-testid={`conflict-${candidate.id}`}
                >
                  <div className={styles.conflictHead}>
                    <p className={styles.conflictQuestion}>
                      <UserText>{candidate.question}</UserText>
                    </p>
                    <p className={styles.conflictAsked}>
                      {t('conflicts.asked', { count: candidate.occurrenceCount })}
                    </p>
                  </div>

                  {/* ★ BOTH ANSWERS, NEITHER PREFERRED - in the order given. */}
                  <ul className={styles.variants}>
                    {variants.map((variant) => {
                      const heard = lastHeardFor(variant, candidate.examples);
                      return (
                        <li
                          key={variant.key}
                          className={styles.variant}
                          data-testid={`variant-${candidate.id}-${variant.key}`}
                        >
                          {/* One of the business's own past answers, verbatim. */}
                          <p className={styles.variantAnswer}>
                            <UserText>{variant.answer}</UserText>
                          </p>
                          <p className={styles.variantMeta}>
                            {t('conflicts.said', { count: variant.occurrenceCount })}
                            {/* Absent is absent - a zero would read as "no customers". */}
                            {variant.customerCount !== null && variant.customerCount !== undefined
                              ? ` · ${t('conflicts.byCustomers', { count: variant.customerCount })}`
                              : ''}
                            {/* At most three examples come back: no borrowed dates. */}
                            {heard
                              ? ` · ${t('conflicts.lastHeard', { when: date(heard) ?? '' })}`
                              : ''}
                          </p>
                        </li>
                      );
                    })}
                  </ul>

                  {/*
                    ⚠ THIS WRITES THE TENANT KNOWLEDGE BASE. Authorized by
                    Omer for this panel. Two presses, the second quoting the
                    answer back - see `ResolveConflict`. No test and no
                    capture presses it. Only where there is more than one
                    answer to choose between.
                  */}
                  {variants.length > 1 ? (
                    <ResolveConflict
                      candidateId={candidate.id}
                      question={candidate.question}
                      reasoning={candidate.reasoning}
                      liveLookup={candidate.requiresLiveLookup}
                      variants={variants}
                    />
                  ) : null}

                  {/* What is true until somebody decides, said before it is decided. */}
                  <p className={styles.conflictMeanwhile}>{t('conflicts.meanwhile')}</p>
                </li>
              );
            })}
          </ul>
        )}

        {/*
          ★★ WHAT WAS COMPARED, beside what it found - the axis is the team's
          own answers over time, not website against PDF. With nothing found
          it is on the card instead (`title`), not a second paragraph.
        */}
        {conflicts && conflicts.length > 0 && everImported ? (
          <p className={styles.coverage} data-testid="conflicts-coverage">
            {t('conflicts.coverage')}
          </p>
        ) : null}
      </section>

      <div className={styles.bottom}>
        {/* ── Where it learns from ─────────────────────────────────────── */}
        <section className={styles.sourcesCard} data-testid="sources-section">
          <header className={styles.cardHead}>
            <h2 className={styles.cardTitle}>{t('sources.heading')}</h2>
            {sources !== null ? (
              <span className={styles.cardMeta} data-testid="counter-sources">
                {t('counters.sources', { count: sources.length })}
              </span>
            ) : null}
          </header>

          <div className={styles.cardBody}>
            {websiteListed ? null : rescanBlock}
            {sources === null ? (
              <p className={styles.degraded} data-testid="sources-unavailable">
                {t('sources.unavailable')}
              </p>
            ) : sources.length === 0 ? (
              <div className={styles.empty} data-testid="sources-none">
                <p className={styles.emptyLead}>{t('sources.none')}</p>
                <p className={styles.emptyBody}>{t('sources.noneBody')}</p>
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.way} data-testid={`way-${group.way}`}>
                  <p className={styles.wayHead}>
                    <WayIcon way={group.way} />
                    <span className={styles.wayName}>{t(`way.${group.way}` as 'way.website')}</span>
                    {/* Only where it is true: every document came from the scan. */}
                    {group.way === 'website' && group.sources.every(scannedOnly) ? (
                      <span className={styles.wayNote}>{t('way.scanned')}</span>
                    ) : null}
                  </p>
                  {/* 02's "Your website · scanned automatically" - and its rescan. */}
                  {group.way === 'website' ? rescanBlock : null}
                  <ul className={styles.sources}>
                    {group.sources.map((source) => {
                      const refreshed = date(lastRefreshed(source));
                      const pending = notReadyCount(source);
                      return (
                        <li
                          key={source.id}
                          className={styles.source}
                          data-testid={`source-${source.id}`}
                        >
                          <span className={styles.sourceText}>
                            <span className={styles.sourceName}>
                              {source.name || t('sources.unnamed')}
                              {/* A shared name says what tells the two apart. */}
                              {hasAmbiguousName(source, sources) ? (
                                <span
                                  className={styles.disambiguate}
                                  data-testid={`same-name-${source.id}`}
                                >
                                  {t('sources.sameName')}
                                </span>
                              ) : null}
                            </span>
                            {/* WHEN, not whether that is good: no staleness policy exists. */}
                            <span className={styles.sourceMeta} data-testid={`docs-${source.id}`}>
                              {t('sources.documents', { count: source.documents.length })}
                              {refreshed
                                ? ` · ${t('sources.refreshed', { date: refreshed })}`
                                : null}
                            </span>
                          </span>
                          {pending > 0 ? (
                            <span className={styles.pending} data-testid={`pending-${source.id}`}>
                              {t('sources.pending', { count: pending })}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))
            )}
          </div>

          {/* "We cannot tell when this was read" is not "this is old": said apart. */}
          {undated.length > 0 ? (
            <p className={styles.cardFoot} data-testid="counter-undated">
              {t('counters.undated', { count: undated.length })}
            </p>
          ) : null}
        </section>

        {/* ── What it could not answer ─────────────────────────────────── */}
        {/* `tabIndex` -1: an address can send focus here (`?section=gaps`), a Tab cannot. */}
        <section
          className={styles.gapsCard}
          data-testid="gaps-section"
          tabIndex={-1}
          aria-labelledby="knowledge-gaps-heading"
        >
          <header className={styles.cardHead}>
            <h2 className={styles.cardTitle} id="knowledge-gaps-heading">
              {t('gaps.heading')}
            </h2>
          </header>

          <div className={styles.cardBody}>
            {unanswered === null ? (
              <p className={styles.degraded} data-testid="gaps-unavailable">
                {t('gaps.unavailable')}
              </p>
            ) : unanswered.length === 0 ? (
              <p className={styles.none} data-testid="gaps-none">
                {t('gaps.none')}
              </p>
            ) : (
              <ul className={styles.gaps}>
                {unanswered.map((question) => (
                  <GapRow
                    key={question.id}
                    question={question}
                    asked={t('gaps.asked', {
                      times: question.timesAsked,
                      people: question.distinctAskers,
                    })}
                  />
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/** How a source came in - from its documents' own `sourceType`. */
export type WayIn =
  'website' | 'uploaded' | 'drive' | 'confluence' | 'conversations' | 'answers' | 'mixed' | 'other';

/**
 * The writers' vocabulary, read from their write sites: `url` and
 * `onboarding_scan` (the website), `file` and `text` (uploaded or typed),
 * `google_drive` and `drive`, `confluence`, `historical_conversations`,
 * `readiness_answer` (answers given during setup). Anything else - `ad`
 * included - is "other" rather than a guess. A source whose documents came
 * in different ways is "mixed"; one with none is "other".
 */
export function wayIn(source: KnowledgeSource): WayIn {
  const of = (type: string): WayIn => {
    switch (type) {
      case 'url':
      case 'onboarding_scan':
        return 'website';
      case 'file':
      case 'text':
        return 'uploaded';
      case 'google_drive':
      case 'drive':
        return 'drive';
      case 'confluence':
        return 'confluence';
      case 'historical_conversations':
        return 'conversations';
      case 'readiness_answer':
        return 'answers';
      default:
        return 'other';
    }
  };
  const ways = new Set(source.documents.map((document) => of(document.sourceType)));
  if (ways.size === 0) return 'other';
  return ways.size === 1 ? [...ways][0]! : 'mixed';
}

const WAY_ORDER: readonly WayIn[] = [
  'website',
  'uploaded',
  'drive',
  'confluence',
  'conversations',
  'answers',
  'mixed',
  'other',
];

/** Sources grouped by how they came in, in 02's order; empty groups left out. */
export function groupByWayIn(
  sources: readonly KnowledgeSource[],
): readonly { readonly way: WayIn; readonly sources: readonly KnowledgeSource[] }[] {
  return WAY_ORDER.map((way) => ({ way, sources: sources.filter((s) => wayIn(s) === way) })).filter(
    (group) => group.sources.length > 0,
  );
}

/** A source every one of whose documents came from the website scan. */
function scannedOnly(source: KnowledgeSource): boolean {
  return (
    source.documents.length > 0 &&
    source.documents.every((document) => document.sourceType === 'onboarding_scan')
  );
}

const WAY_ICONS = {
  website: Globe,
  uploaded: Upload,
  drive: FolderSync,
  confluence: BookOpen,
  conversations: MessagesSquare,
  answers: ListChecks,
  mixed: Layers,
  other: Shapes,
} as const;

function WayIcon({ way }: { readonly way: WayIn }) {
  const Icon = WAY_ICONS[way];
  return <Icon className={styles.wayIcon} size={13} aria-hidden="true" />;
}
