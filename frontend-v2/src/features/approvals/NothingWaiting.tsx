import { getFormatter, getTranslations } from 'next-intl/server';

import { decisionStance, isOutcomeUnknown, type Approval } from '@/api/contracts/approvals';

import { humaniseCode } from '@/api/contracts/capabilities';
import { Link } from '@/i18n/navigation';

import { decisionSentence } from './decision-sentence';
import { isolated } from './isolate';
import { reasonKeyOf } from './reason-words';
import type { HandledToday } from './handled';
import type { decisionStats } from './load-approvals';

import fill from '@/design-system/styles/fill.module.css';

import styles from './Approvals.module.css';

/**
 * Screen 03c - *"nothing waiting"*.
 *
 * Not a separate route: this **is** the Approvals screen when the queue is
 * empty, which is the point of the design note - *"the product working, not an
 * empty box"*. An empty approvals queue is the delegation succeeding, and it
 * must not read as a failure or as an absence.
 *
 * ── WHAT THE DESIGN LEADS WITH, AND WHY THIS DOES NOT ──
 * The design opens on *"31 actions, ₪2,840 of value, handled without asking
 * you today"* with a by-type breakdown. **The data for that exists and is
 * exactly right** - `PolicyDecision` is an append-only audit of every policy
 * evaluation, carrying `decision`, `actionKind`, `tool`, `maxAmount` and
 * `inputFacts`, indexed on `[tenantId, createdAt]`.
 *
 * **No route reads it.** Verified across every route file in the platform. So
 * the headline is unbuilt rather than fictional - a distinction worth keeping,
 * because it is one endpoint over correct data rather than machinery that does
 * not exist. It is requested, and until it lands this screen does not invent a
 * number, estimate one, or imply the figure is zero.
 *
 * ── AND WHAT IS REMOVED ──
 * Every row in the design carries **Undo**, and the header says *"all still
 * reversible for 24h"*. There is no undo in this platform. Both are gone
 * rather than disabled: a greyed-out Undo still tells you one existed.
 *
 * *"What GOTCHA learned from your rejections"* is also absent - nothing
 * anywhere derives a threshold change from a rejection. The reason itself is
 * real and is shown; the learning claimed about it is not.
 */
export async function NothingWaiting({
  decided,
  mayBeIncomplete,
  requesterNames,
  customerNames = {},
  now = new Date(),
}: {
  readonly decided: readonly Approval[] | null;
  readonly mayBeIncomplete: boolean;
  readonly requesterNames: Readonly<Record<string, string>>;
  /** The customer of each row, by approval id, where its conversation names one. */
  readonly customerNames?: Readonly<Record<string, string>>;
  /** One `now` for the render: "today" decides whether a row shows a time or a date. */
  readonly now?: Date;
}) {
  const t = await getTranslations('approvals');
  const format = await getFormatter();

  /*
   * ★ A TIME FOR TODAY, A DATE FOR EARLIER. 02's column is `09:41` because
   *   its list is today's. Ours spans days, and a time alone on a list that
   *   does was the defect a walk found: 29 rows at "12:43 AM" and no day.
   */
  const today = now.toDateString();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString();
  const when = (iso: string) => {
    const at = new Date(iso);
    if (at.toDateString() === today) {
      return format.dateTime(at, { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    if (at.toDateString() === yesterday) return t('decided.yesterday');
    return format.dateTime(at, { day: 'numeric', month: 'short' });
  };
  const decidedToday = (decided ?? []).filter(
    (approval) => approval.decidedAt && new Date(approval.decidedAt).toDateString() === today,
  ).length;
  const amountOf = (approval: Approval) =>
    approval.facts.amount === null
      ? null
      : approval.facts.currency
        ? format.number(approval.facts.amount, {
            style: 'currency',
            currency: approval.facts.currency,
            maximumFractionDigits: 0,
          })
        : format.number(approval.facts.amount);
  /** One of our reasons in the reader's language; anyone's own words as written, isolated. */
  const reasonSaid = (text: string) => {
    const key = reasonKeyOf(text);
    return key === null
      ? isolated({ text }).text
      : key === 'tooGenerous'
        ? t('reject3.tooGenerous')
        : t(`action2.reasons.${key}`);
  };
  const sentence = (approval: Approval) => {
    const asked = amountOf(approval);
    // Edited: what ran, and what was asked - "Refunded 120 (was 179)".
    const ran =
      approval.editedAmount !== null && asked !== null
        ? t('decided.wasAmount', {
            now: amountOf({
              ...approval,
              facts: { ...approval.facts, amount: approval.editedAmount },
            })!,
            was: asked,
          })
        : asked;
    const { key, values } = decisionSentence(approval, customerNames[approval.id] ?? null, ran);
    return key === 'none'
      ? approval.summary
      : t(`decided.sentence.${key}` as 'decided.sentence.refunded', isolated(values) as never);
  };

  /*
   * ════════════════════════════════════════════════════════════════════════
   * ★★ 03c: THE STATE IS THE PAGE TITLE, AND THIS IS THE RECORD
   * ════════════════════════════════════════════════════════════════════════
   * 02 says "Nothing waiting on you" in the title and gives the body to the
   * record of decisions - one card, one row per decision: when, what, and
   * how it ended. Our two explanatory paragraphs above it are gone; 02 shows
   * states, it does not explain them.
   *
   * Not drawn, and why: the dark "handled without asking you" card needs an
   * auto-handled count and value nobody records; Undo has no route; the
   * footer's "Rejecting with a reason teaches GOTCHA" describes learning
   * nothing derives.
   */
  return (
    <section className={`${fill.fillCard} ${styles.decidedCard}`} data-testid="nothing-waiting">
      <header className={styles.decidedCardHeader}>
        <h2 className={styles.decidedHeading}>{t('decided.heading')}</h2>
        {/* 02: "7 today". Undo was ruled out (Omer, 2026-10-04), and with it the 24h. */}
        {decided !== null && decided.length > 0 ? (
          <span className={styles.decidedCount} data-testid="decided-today">
            {decidedToday > 0
              ? t('decided.today', { count: decidedToday })
              : t('decided.shown', { count: decided.length })}
          </span>
        ) : null}
      </header>

      {decided === null ? (
        <p className={styles.decidedNote} data-testid="decided-unavailable">
          {t('decided.unavailable')}
        </p>
      ) : decided.length === 0 ? (
        <p className={styles.decidedNote} data-testid="decided-empty">
          {t('decided.none')}
        </p>
      ) : (
        <ol className={`${fill.fillScroll} ${styles.decidedList}`} data-testid="decided-list">
          {decided.map((approval) => {
            const stance = decisionStance(approval);
            const failed = stance === 'approved' && approval.executionState === 'FAILED';
            const unknown = isOutcomeUnknown(approval);
            /*
             * ★ WHO DECIDED, ON HOVER. 02's row does not name the decider; the
             *   status's tooltip does.
             */
            /*
             * Who decided, and where - the status's tooltip. "someone" where the
             * platform holds no name: 26 of dev's 29 rows carry test-fixture
             * labels (`dev-e2e`, `qa-manager`), not user ids, and for those
             * "someone" is the truth.
             */
            const who = approval.decidedByName ?? t('decided.someone');
            const channel =
              approval.decisionChannel === 'whatsapp' || approval.decisionChannel === 'web'
                ? t(`decided.channel.${approval.decisionChannel}`)
                : null;
            const by =
              channel === null ? t('decided.by', { who }) : t('decided.byVia', { who, channel });
            const asked = requesterNames[approval.id];
            return (
              <li
                key={approval.id}
                className={styles.decidedRow}
                data-testid={`decided-${approval.id}`}
                data-stance={stance}
              >
                <span className={styles.decidedWhen}>
                  {approval.decidedAt ? (
                    <time dateTime={approval.decidedAt} data-testid={`when-${approval.id}`}>
                      {when(approval.decidedAt)}
                    </time>
                  ) : null}
                </span>
                <span
                  className={styles.decidedSummary}
                  title={asked ? t('decided.askedBy', { who: asked }) : undefined}
                >
                  {sentence(approval)}
                </span>
                {/*
                  ★★ HOW IT ENDED, IN ONE WORD - and the two endings 02's tidy
                  column could never show, said as plainly: approved and then
                  failed to run, and approved before anything recorded whether
                  it ran. The full sentence is the tooltip.
                */}
                {failed ? (
                  <span
                    className={styles.decidedStatus}
                    data-tone="problem"
                    data-testid={`failed-${approval.id}`}
                    title={t('decided.didNotRun')}
                  >
                    {t('decided.status.didNotRun')}
                  </span>
                ) : unknown ? (
                  <span
                    className={styles.decidedStatus}
                    data-tone="problem"
                    data-testid={`unknown-${approval.id}`}
                    title={t('decided.outcomeUnknown')}
                  >
                    {t('decided.status.outcomeUnknown')}
                  </span>
                ) : stance === 'approved' &&
                  (approval.editedAmount !== null || approval.editedPercentage !== null) ? (
                  <span
                    className={styles.decidedStatus}
                    data-tone="edited"
                    data-testid={`edited-${approval.id}`}
                    title={by}
                  >
                    {approval.editedPercentage !== null && approval.facts.percentage !== null
                      ? t('decided.status.editedPercent', {
                          was: format.number(approval.facts.percentage),
                          now: format.number(approval.editedPercentage),
                        })
                      : t('decided.status.edited')}
                  </span>
                ) : stance === 'rejected' && approval.decisionReason ? (
                  <span
                    className={styles.decidedStatus}
                    data-tone="rejected"
                    data-testid={`reason-${approval.id}`}
                    title={by}
                  >
                    {t('decided.status.rejectedBecause', {
                      reason: reasonSaid(approval.decisionReason),
                    })}
                  </span>
                ) : (
                  <span className={styles.decidedStatus} data-tone={stance} title={by}>
                    {t(`decided.status.${stance}` as 'decided.status.approved')}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {/*
        `GET /api/approvals` takes one status, has no date filter, and caps at
        100 per status - so the card says when it may be cut, in 02's footer
        bar, as one line.
      */}
      {/*
        02's foot says a reason "teaches GOTCHA". Nothing reads a rejection's
        reason (it is only ever written) - so the foot says what is true.
      */}
      {decided && decided.length > 0 ? (
        <p className={styles.decidedFooter} data-testid="decided-foot">
          {mayBeIncomplete ? t('decided.incompleteShort') : t('decided.kept')}
        </p>
      ) : null}
    </section>
  );
}

/** `shopify` → "Shopify": the brand's own casing, from the shared humaniser. */
const systemName = (slug: string) => humaniseCode(slug);

/**
 * 03c's dark card - what GOTCHA did today with nobody asked. See
 * `handledToday` for how it is counted; never a value nobody recorded.
 */
export async function HandledCard({
  handled,
  refundLimit = null,
}: {
  readonly handled: HandledToday | null;
  /** The REFUND policy's approval threshold, when one is set. */
  readonly refundLimit?: number | null;
}) {
  const t = await getTranslations('approvals.handled');
  const format = await getFormatter();
  const figures = [
    ['refunds', handled?.refunds],
    ['lookups', handled?.lookups],
    ['returns', handled?.returns],
  ] as const;
  return (
    <section className={styles.handled} data-testid="handled-today">
      <p className={styles.handledEyebrow}>{t('eyebrow')}</p>
      {handled === null ? (
        <p className={styles.handledLead} title={t('unread')} data-testid="handled-unread">
          <span className={styles.handledNumber}>-</span>
        </p>
      ) : handled.total === 0 && handled.failed === 0 ? (
        <p className={styles.handledLead} data-testid="handled-none">
          <span className={styles.handledQuiet}>{t('none')}</span>
        </p>
      ) : (
        <p className={styles.handledLead} data-testid="handled-total">
          <span className={styles.handledNumber}>{format.number(handled.total)}</span>
          <span className={styles.handledUnit}>{t('actions', { count: handled.total })}</span>
        </p>
      )}
      {/*
        Tried and failed today: said, with the repair - never hidden behind
        "nothing ran". One system named and linked; several, the systems page.
      */}
      {handled !== null && handled.failed > 0 ? (
        <p className={styles.handledFailed} data-testid="handled-failed">
          {handled.failingSystems.length === 1
            ? t('failedOne', {
                count: handled.failed,
                system: systemName(handled.failingSystems[0]!),
              })
            : t('failedMany', { count: handled.failed })}{' '}
          <Link
            href={
              handled.failingSystems.length === 1
                ? {
                    pathname: '/studio/capabilities',
                    query: { system: handled.failingSystems[0]! },
                  }
                : '/studio/capabilities'
            }
            className={styles.handledRepair}
          >
            {t('reconnect')}
          </Link>
        </p>
      ) : null}
      <dl className={styles.handledFigures}>
        {figures.map(([key, value]) => (
          <div key={key} className={styles.handledFigure} data-testid={`handled-${key}`}>
            <dt>
              {key === 'refunds' && refundLimit !== null
                ? t('refundsUnder', { limit: format.number(refundLimit) })
                : t(key)}
            </dt>
            {/* No figure of nothing: on a quiet day, or unread, each is "-". */}
            <dd title={value === undefined ? t('unread') : undefined}>
              {value === undefined || !value ? '-' : format.number(value)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * 02's header figures - "Approved this week 42 · Avg decision 16s" - for the
 * page's `actions` slot. Nothing when they cannot be stood behind.
 */
export async function DecisionStats({
  stats,
}: {
  readonly stats: ReturnType<typeof decisionStats>;
}) {
  if (stats === null) return null;
  const t = await getTranslations('approvals');
  const seconds = stats.avgDecisionSeconds;
  const avg =
    seconds === null
      ? null
      : seconds < 60
        ? t('stats.seconds', { n: seconds })
        : seconds < 3600
          ? t('stats.minutes', { n: Math.round(seconds / 60) })
          : t('stats.hours', { n: Math.round(seconds / 3600) });
  return (
    <p className={styles.headerStats} data-testid="decision-stats">
      <span>
        {t('stats.approvedWeek')} <strong>{stats.approvedThisWeek}</strong>
      </span>
      <span>
        {t('stats.avgDecision')} <strong>{avg ?? '-'}</strong>
      </span>
    </p>
  );
}
