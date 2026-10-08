import { Bell } from 'lucide-react';
import { getLocale, getTimeZone, getTranslations } from 'next-intl/server';

import { humaniseCode } from '@/api/contracts/capabilities';
import { isRunning, workDone, type ImportStatus } from '@/api/contracts/historical-import';
import {
  groupOf,
  knowledgeDocumentOf,
  readyToAdd,
  variantsOf,
  type Candidate,
  type CandidateEvidence,
  type ImportedThread,
} from '@/api/contracts/knowledge-candidates';
import drawer from '@/design-system/styles/drawer.module.css';
import { Link } from '@/i18n/navigation';

import { RerunFailed, ReportFoot } from './ReportFootActions';
import { SuggestionActions } from './SuggestionActions';
import styles from './Channels.module.css';
import { UserText } from '@/design-system/primitives/text/UserText';

const href = (view: 'progress' | 'report', importId: string, tab?: string) => ({
  pathname: '/settings/channels',
  query: { panel: 'whatsapp', import: importId, view, ...(tab ? { tab } : {}) },
});

/** 13f's "See the chats" for one suggestion - and, with `conversation`, one chat open. */
export const chatsHref = (importId: string, candidateId: string, conversation?: string) => ({
  pathname: '/settings/channels' as const,
  query: {
    panel: 'whatsapp',
    import: importId,
    view: 'chats',
    candidate: candidateId,
    ...(conversation ? { conversation } : {}),
  },
});

/** A failure reason in words: the platform's sentence, or a code made readable. */
function reasonInWords(reason: string): string {
  return /^[a-z0-9_.-]+$/.test(reason) ? humaniseCode(reason) : reason;
}

/**
 * 13b's way into 13e / 13f: one row under the number card while there is an
 * import - "Learning in progress · 64%", "Report ready · 151 answers",
 * "Stopped", or "No history to learn from".
 */
export async function LearningRow({ status }: { readonly status: ImportStatus }) {
  const t = await getTranslations('channels.whatsapp');
  const view = status.stage === 'ready' ? 'report' : 'progress';
  return (
    <Link
      href={href(view, status.id)}
      className={styles.learningRow}
      data-stage={status.stage}
      data-testid="learning-row"
      scroll={false}
    >
      <span className={styles.learningRowText}>
        {status.stage === 'ready'
          ? t('learn.rowReady', { count: status.knowledgeCandidateCount })
          : status.stage === 'transferring'
            ? t('learn.rowImporting', { percent: status.percent })
            : status.stage === 'analyzing'
              ? t('learn.rowLearning', { percent: status.analysisPercent })
              : t(`import.stage.${status.stage}`)}
      </span>
      <span aria-hidden="true">›</span>
    </Link>
  );
}

type StepState = 'done' | 'active' | 'waiting' | 'failed';

/**
 * 13e, measured: "Setting up {number}" - the stepper (Where it lives ✓ ·
 * Meta ✓ · Number ✓ · ④ Learn), whether messages already arrive, a
 * timeline, "So far", and the way out.
 *
 * The timeline is the platform's two stages, not five steps. `transferring`
 * is "History imported"; `analyzing` is ONE stage in which learning how you
 * write, finding answers and remembering customers happen together - so
 * those three rows share its state and each carries its own measured count,
 * and none is drawn as waiting on the one before.
 */
export async function ImportPanel({
  status,
  receiving,
  coexistence = false,
}: {
  readonly status: ImportStatus;
  /** Does the number already receive? Only then is "Connected" said. */
  readonly receiving: boolean;
  /** The number stays on the Business app (coexistence) - said under "Number connected". */
  readonly coexistence?: boolean;
}) {
  const t = await getTranslations('channels.whatsapp');
  const locale = await getLocale();
  const n = new Intl.NumberFormat(locale);
  const pctOf = (value: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
      Math.max(0, Math.min(100, value)) / 100,
    );
  const done = workDone(status);
  const failed = status.stage === 'failed';
  const failedAt = status.failedStage?.toLowerCase() ?? '';

  const importState: StepState =
    status.stage === 'transferring'
      ? 'active'
      : failed && failedAt.includes('transfer')
        ? 'failed'
        : status.stage === 'unavailable'
          ? 'waiting'
          : 'done';
  const learnState: StepState =
    status.stage === 'analyzing'
      ? 'active'
      : status.stage === 'ready'
        ? 'done'
        : failed && importState !== 'failed'
          ? 'failed'
          : 'waiting';

  const step = (
    key: string,
    state: StepState,
    title: string,
    sub: string | null,
    extra: React.ReactNode = null,
    figure: string | null = null,
  ) => (
    <li
      key={key}
      className={styles.timelineStep}
      data-state={state}
      data-testid={`learn-step-${key}`}
    >
      <span className={styles.timelineDot} aria-hidden="true" />
      <span className={styles.timelineBody}>
        <span className={styles.timelineHead}>
          <span className={styles.timelineTitle}>{title}</span>
          {figure ? <span className={styles.timelineFigure}>{figure}</span> : null}
        </span>
        {sub ? <span className={styles.timelineSub}>{sub}</span> : null}
        {extra}
      </span>
    </li>
  );

  const bar = (percent: number) => (
    <span className={styles.timelineBar} aria-hidden="true">
      <span style={{ inlineSize: `${Math.max(0, Math.min(100, percent))}%` }} />
    </span>
  );

  const topics = status.topTopics
    .map((topic) =>
      typeof topic === 'string'
        ? topic
        : typeof topic === 'object' && topic !== null
          ? ((topic as { topic?: unknown; label?: unknown }).topic ??
            (topic as { label?: unknown }).label)
          : null,
    )
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .slice(0, 5);

  return (
    <>
      <div className={drawer.drawerBody} data-testid="import-panel" data-stage={status.stage}>
        <ol className={`${styles.stepper} ${styles.stepperRuled}`} aria-label={t('learn.steps')}>
          {(['where', 'meta', 'number'] as const).map((s) => (
            <li key={s} className={styles.stepperStep} data-state="done">
              <span className={styles.stepperMark} aria-hidden="true">
                ✓
              </span>
              {t(`learn.step.${s}`)}
            </li>
          ))}
          <li className={styles.stepperStep} data-state="current">
            <span className={styles.stepperMark} aria-hidden="true">
              4
            </span>
            {t('learn.step.learn')}
          </li>
        </ol>

        {receiving ? (
          <p className={styles.connectedLine} data-testid="import-live">
            {t('learn.connected')}
          </p>
        ) : null}

        {status.stage === 'unavailable' ? (
          <p className={styles.timelineSub} data-testid="import-unavailable">
            {t('import.unavailableBody')}
          </p>
        ) : (
          <ol className={styles.timeline} data-testid="learn-timeline">
            {step(
              'connected',
              'done',
              t('learn.connectedStep'),
              coexistence ? t('learn.coexistence') : null,
            )}
            {step(
              'imported',
              importState,
              t('learn.imported'),
              importState === 'active'
                ? null
                : done.conversationsTotal
                  ? t('learn.conversations', { count: n.format(done.conversationsTotal) })
                  : null,
              importState === 'active' ? bar(status.percent) : null,
              importState === 'active' ? pctOf(status.percent) : null,
            )}
            <li className={styles.timelineGroup} title={t('import.noOrder')}>
              <ol className={styles.timeline}>
                {step(
                  'learning',
                  learnState,
                  t('learn.learning'),
                  t('learn.learningSub'),
                  learnState === 'active' ? bar(status.analysisPercent) : null,
                  learnState === 'active' ? pctOf(status.analysisPercent) : null,
                )}
                {step(
                  'answers',
                  learnState,
                  t('learn.answers'),
                  done.answersFound > 0
                    ? t('import.answers', { count: done.answersFound })
                    : t('learn.answersSub'),
                )}
                {step(
                  'customers',
                  learnState,
                  t('learn.customers'),
                  done.customersTotal
                    ? t('import.customers', {
                        read: n.format(done.customersRead),
                        total: n.format(done.customersTotal),
                      })
                    : null,
                )}
              </ol>
            </li>
          </ol>
        )}

        {failed ? (
          <p className={styles.learnFailed} data-testid="import-failed">
            {status.failureReason
              ? reasonInWords(status.failureReason)
              : status.failedStage
                ? t('import.failedWithStage', { stage: status.failedStage })
                : t('import.failedBare')}
          </p>
        ) : null}

        {topics.length > 0 ? (
          <section className={styles.soFar} data-testid="learn-so-far">
            <h3 className={styles.soFarTitle}>{t('learn.soFar')}</h3>
            <p className={styles.soFarRow}>
              <span className={styles.soFarLabel}>{t('learn.mostAsked')}</span>
              <span>{topics.join(' · ')}</span>
            </p>
          </section>
        ) : null}

        {isRunning(status) ? (
          // 02's foot sentence. No estimate is reported, so no "N minutes left".
          <p className={styles.learnFoot} data-testid="import-foot">
            <Bell size={14} aria-hidden="true" />
            {t('learn.closeAnytime')}
          </p>
        ) : null}
      </div>

      <footer className={drawer.drawerFoot}>
        <Link
          href={{ pathname: '/settings/channels', query: { panel: 'whatsapp' } }}
          className={styles.learnSecondary}
          title={isRunning(status) ? t('import.emailNeedsAddress') : undefined}
          data-testid="import-close"
          scroll={false}
        >
          {t('learn.close')}
        </Link>
        {failed ? (
          status.sourceCompletedAt ? (
            // The history is all here: the analysis can be run again.
            <RerunFailed importId={status.id} />
          ) : (
            // The transfer itself broke: there is nothing whole to analyse again.
            <span
              className={styles.learnPrimary}
              aria-disabled="true"
              title={t('learn.rerunNoHistory')}
              data-testid="import-rerun"
            >
              {t('learn.rerun')}
            </span>
          )
        ) : status.stage === 'ready' ? (
          <Link
            href={href('report', status.id)}
            className={styles.learnPrimary}
            data-testid="import-review"
            scroll={false}
          >
            {t('learn.review')}
          </Link>
        ) : (
          <span
            className={styles.learnPrimary}
            aria-disabled="true"
            title={t('learn.reviewWhenReady')}
            data-testid="import-review"
          >
            {t('learn.review')}
          </span>
        )}
      </footer>
    </>
  );
}

/**
 * 02's tabs: Needs a look · Ready to add · Rejected - and Already covered
 * only when there is any. What has been approved is in use, not to review.
 */
const TABS = ['needs_a_look', 'ready_to_add', 'rejected', 'already_covered'] as const;
type ReportTab = (typeof TABS)[number];

function tabOf(c: Candidate, floor: number | undefined): ReportTab | null {
  const group = groupOf(c);
  if (group === 'rejected' || group === 'already_covered') return group;
  if (group !== 'needs_a_look') return null;
  return readyToAdd(c, floor) ? 'ready_to_add' : 'needs_a_look';
}

/**
 * 13f, measured: "What GOTCHA learned from {number}" · "Nothing is used
 * until you approve it." - the strip of four, three cards, the tabs, the
 * candidates as cards in two columns, the ready-in-bulk card, the footer.
 *
 * Approve, a variant to use, Edit and Reject are live (Omer, decision 13);
 * adding the ready ones in bulk and running the analysis again too (Omer,
 * 2026-10-05) - each asks before it acts.
 */
export async function ReportPanel({
  status,
  candidates,
  bulkMinConfidence,
  tab,
}: {
  readonly status: ImportStatus;
  readonly candidates: readonly Candidate[];
  readonly bulkMinConfidence: number | undefined;
  readonly tab: string | undefined;
}) {
  const t = await getTranslations('channels.whatsapp');
  const locale = await getLocale();
  const n = new Intl.NumberFormat(locale);
  const pct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  const inTab = (g: ReportTab) => candidates.filter((c) => tabOf(c, bulkMinConfidence) === g);
  const tabs = TABS.filter((g) => g !== 'already_covered' || inTab(g).length > 0);
  const current: ReportTab = (tabs as readonly string[]).includes(tab ?? '')
    ? (tab as ReportTab)
    : 'needs_a_look';
  const shown = inTab(current);
  const ready = inTab('ready_to_add');

  /* 02: a chip only for a reason to look - never a figure, which sits on the right. */
  const chipOf = (c: Candidate): { text: string; tone: string } | null =>
    c.conflict
      ? { text: t('learn.chip.conflict'), tone: 'warn' }
      : c.requiresLiveLookup
        ? { text: t('learn.chip.live'), tone: 'quiet' }
        : bulkMinConfidence !== undefined && c.confidence < bulkMinConfidence
          ? { text: t('learn.chip.low'), tone: 'warn' }
          : null;

  return (
    <>
      <div className={drawer.drawerBody} data-testid="report-panel">
        <dl className={styles.reportStrip}>
          {[
            [
              'conversations',
              status.conversationsExtracted > 0 ? n.format(status.conversationsExtracted) : '-',
            ],
            ['customers', status.customersTotal > 0 ? n.format(status.customersTotal) : '-'],
            ['period', '-'],
            ['answers', n.format(status.knowledgeCandidateCount)],
          ].map(([key, value]) => (
            <div key={key} className={styles.reportStat} data-testid={`report-stat-${key}`}>
              <dd className={styles.reportFigure}>{value}</dd>
              <dt className={styles.reportLabel}>{t(`learn.stat.${key}`)}</dt>
            </div>
          ))}
        </dl>

        <div className={styles.reportCards}>
          <section className={styles.reportCard} title={t('learn.noImportData')}>
            <h3 className={styles.soFarTitle}>{t('learn.card.languages')}</h3>
            <p className={styles.timelineSub}>-</p>
          </section>
          <section className={styles.reportCard} title={t('learn.noImportData')}>
            <h3 className={styles.soFarTitle}>{t('learn.card.sound')}</h3>
            <p className={styles.timelineSub}>-</p>
          </section>
          <section className={styles.reportCard}>
            <h3 className={styles.soFarTitle}>{t('learn.card.customers')}</h3>
            <p className={styles.timelineSub} data-testid="report-customers">
              {status.customersAnalyzed > 0
                ? t('learn.customersRead', { count: n.format(status.customersAnalyzed) })
                : '-'}
            </p>
            {/* 02's "Preview five" - no route returns the profiles yet. */}
            <span
              className={styles.reportPreview}
              aria-disabled="true"
              title={t('learn.previewNotYet')}
              data-testid="report-preview"
            >
              {t('learn.previewFive')}
            </span>
          </section>
        </div>

        <nav className={styles.reportTabs} aria-label={t('review.heading')}>
          {tabs.map((g) => (
            <Link
              key={g}
              href={href('report', status.id, g)}
              className={styles.reportTab}
              aria-current={g === current ? 'page' : undefined}
              data-testid={`report-tab-${g}`}
              scroll={false}
            >
              {t(`learn.tab.${g}`)}
              <span className={styles.reportTabCount}>{n.format(inTab(g).length)}</span>
            </Link>
          ))}
          <span className={styles.reportTabsLabel}>{t('learn.qa')}</span>
        </nav>

        {shown.length === 0 ? (
          <p className={styles.timelineSub} data-testid="report-empty">
            {t('review.empty')}
          </p>
        ) : (
          <ul className={styles.reportGrid} title={t('review.evidenceNotTruth')}>
            {shown.map((c) => {
              const chip = chipOf(c);
              // Most-seen first: the first is the one to use, the rest beside it.
              const variants = [...variantsOf(c)].sort(
                (x, y) => y.occurrenceCount - x.occurrenceCount,
              );
              const split = c.conflict && variants.length > 1;
              return (
                <li key={c.id} className={styles.reportItem} data-testid={`candidate-${c.id}`}>
                  <p className={styles.reportItemHead}>
                    {chip ? (
                      <span
                        className={styles.reportChip}
                        data-tone={chip.tone}
                        title={
                          c.conflict
                            ? t('review.conflict')
                            : c.requiresLiveLookup
                              ? t('review.liveLookup')
                              : undefined
                        }
                      >
                        {chip.text}
                      </span>
                    ) : null}
                    {/* A count of nothing is not drawn: no "0 chats". */}
                    <span className={styles.reportItemMeta}>
                      {[
                        c.occurrenceCount > 0
                          ? t('learn.chats', { count: c.occurrenceCount })
                          : null,
                        c.conflict ? null : pct.format(c.confidence),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </p>
                  <p className={styles.reportQuestion}>
                    <UserText>{c.question}</UserText>
                  </p>
                  {split ? (
                    // 02: "Your replies said 14 days in 61 chats and 30 days in 12."
                    <p className={styles.reportAnswer} data-testid={`said-${c.id}`}>
                      {t('learn.saidLead')}{' '}
                      {variants.map((v, i) => (
                        <span key={v.key}>
                          {i > 0 ? ` ${t('learn.saidAnd')} ` : null}
                          <strong className={styles.reportSaid}>{v.answer}</strong>{' '}
                          {i === 0
                            ? t('learn.saidIn', { count: v.occurrenceCount })
                            : t('learn.saidInShort', { count: v.occurrenceCount })}
                        </span>
                      ))}
                      .
                    </p>
                  ) : (
                    <p className={styles.reportAnswer}>{t('learn.quoted', { answer: c.answer })}</p>
                  )}
                  {tabOf(c, bulkMinConfidence) === 'needs_a_look' ||
                  tabOf(c, bulkMinConfidence) === 'ready_to_add' ? (
                    // Live (Omer, decision 13): approve, use a variant, edit, reject.
                    <SuggestionActions
                      id={c.id}
                      question={c.question}
                      answer={c.answer}
                      reasoning={c.reasoning}
                      liveLookup={c.requiresLiveLookup}
                      variants={split ? variants.map((v) => v.answer) : []}
                      seeChats={
                        split
                          ? { label: t('learn.seeChats'), href: chatsHref(status.id, c.id) }
                          : null
                      }
                    />
                  ) : null}
                </li>
              );
            })}
            {current === 'needs_a_look' && ready.length > 0 ? (
              <li className={styles.reportReady} data-testid="report-ready-card">
                <p className={styles.reportItemMeta}>
                  {t('learn.readyCard', { count: ready.length })}
                </p>
                {ready.slice(0, 2).map((c) => (
                  <p key={c.id} className={styles.reportReadyRow}>
                    <span className={styles.reportReadyQ}>
                      <UserText>{c.question}</UserText>
                    </span>
                    <span>{c.answer}</span>
                  </p>
                ))}
              </li>
            ) : null}
          </ul>
        )}
      </div>

      <footer className={drawer.drawerFoot}>
        {/* Live (Omer): each asks first; Run again's question takes the whole row. */}
        <ReportFoot
          importId={status.id}
          ready={ready.map((c) => ({
            id: c.id,
            document: knowledgeDocumentOf(c.question, c.answer, c.reasoning, c.requiresLiveLookup),
          }))}
          noteClassName={drawer.drawerFootNote}
          later={
            <Link
              href={{ pathname: '/settings/channels', query: { panel: 'whatsapp' } }}
              className={drawer.drawerCancel}
              scroll={false}
            >
              {t('learn.later')}
            </Link>
          }
        />
      </footer>
    </>
  );
}

/**
 * 13f's "See the chats" (Omer, decision 13): the real exchanges behind one
 * suggestion, newest first (the route keeps up to 50), each opening its
 * imported chat in place - for the reviewer who wants to check rather than
 * trust. Reading only: nothing here decides or sends.
 *
 * Private contacts were never imported (`isInboundExcluded` at ingest), so
 * none of their chats can appear.
 */
export async function ChatsPanel({
  status,
  candidate,
  evidence,
  open,
  thread,
}: {
  readonly status: ImportStatus;
  readonly candidate: Candidate;
  /** `null`: the evidence could not be read. */
  readonly evidence: readonly CandidateEvidence[] | null;
  /** The chat asked for (`?conversation=`), if any. */
  readonly open: string | null;
  /** That chat's messages; `null` when it could not be read. */
  readonly thread: ImportedThread | null;
}) {
  const t = await getTranslations('channels.whatsapp.chats');
  const locale = await getLocale();
  const timeZone = await getTimeZone();
  const when = new Intl.DateTimeFormat(locale, { timeZone, dateStyle: 'medium' });
  const at = new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
    hourCycle: 'h23',
  });

  return (
    <>
      <div className={drawer.drawerBody} data-testid="chats-panel">
        <Link
          href={href('report', status.id)}
          className={styles.chatsBack}
          data-testid="chats-back"
          scroll={false}
        >
          {t('back')}
        </Link>
        <p className={styles.reportQuestion}>
          <UserText>{candidate.question}</UserText>
        </p>

        {open ? (
          <section className={styles.chatThread} data-testid="chat-thread">
            <header className={styles.chatThreadHead}>
              <h3 className={styles.soFarTitle}>
                {thread?.conversation.customerName
                  ? t('threadWith', { name: thread.conversation.customerName })
                  : t('thread')}
              </h3>
              <Link
                href={chatsHref(status.id, candidate.id)}
                className={styles.chatsBack}
                data-testid="chat-close"
                scroll={false}
              >
                {t('close')}
              </Link>
            </header>
            {thread === null ? (
              <p className={styles.timelineSub} data-testid="chat-unread">
                {t('threadUnread')}
              </p>
            ) : (
              <ol className={styles.chatMessages}>
                {thread.messages
                  .filter((m) => m.body?.trim())
                  .map((m) => (
                    <li
                      key={m.id}
                      className={styles.chatMessage}
                      data-from={m.direction === 'INBOUND' ? 'customer' : 'team'}
                      data-testid={`chat-message-${m.id}`}
                    >
                      <span className={styles.chatWho}>
                        {m.direction === 'INBOUND' ? t('customer') : t('team')} ·{' '}
                        {at.format(new Date(m.createdAt))}
                      </span>
                      <span dir="auto">{m.body}</span>
                    </li>
                  ))}
              </ol>
            )}
          </section>
        ) : evidence === null ? (
          <p className={styles.timelineSub} data-testid="chats-unread">
            {t('unread')}
          </p>
        ) : evidence.length === 0 ? (
          <p className={styles.timelineSub} data-testid="chats-none">
            {t('none')}
          </p>
        ) : (
          <>
            <p className={styles.timelineSub} data-testid="chats-count">
              {t('count', { count: evidence.length })}
            </p>
            <ul className={styles.chatsList}>
              {evidence.map((e, i) => (
                <li key={i} className={styles.chatsItem} data-testid={`chats-item-${i}`}>
                  <span className={styles.chatWho}>
                    {e.occurredAt ? when.format(new Date(e.occurredAt)) : '-'}
                  </span>
                  <span>
                    <span className={styles.chatWho}>{t('customer')}: </span>
                    <UserText>{e.question}</UserText>
                  </span>
                  <span>
                    <span className={styles.chatWho}>{t('reply')}: </span>
                    <UserText>{e.answer}</UserText>
                  </span>
                  {e.conversationId ? (
                    <Link
                      href={chatsHref(status.id, candidate.id, e.conversationId)}
                      className={styles.chatsOpen}
                      data-testid={`chats-open-${i}`}
                      scroll={false}
                    >
                      {t('open')}
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
