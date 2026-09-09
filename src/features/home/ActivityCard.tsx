import { getFormatter, getTranslations } from 'next-intl/server';

import type { ActivityEvent, InFlight, TimeSaved, UsageAllowance } from '@/api/contracts/analytics';

import { ABSENT, eventMessage } from './activity-event';
import styles from './Home.module.css';

/**
 * "GOTCHA is working" — the dark card on Home.
 *
 * The server sends `kind` + `values` and never a rendered sentence, so the
 * wording, the order of the clauses and the direction of the text are decided
 * here. That is what makes the card work in Hebrew at all.
 */

const DOT_CLASS = {
  completed: '',
  failed: styles.activityEventDotFailed,
  awaiting_approval: styles.activityEventDotAwaiting,
} as const;

export async function ActivityCard({
  events,
  timeSaved,
  inFlight,
  allowance,
  now,
}: {
  /** Null means the call failed; empty means GOTCHA has done nothing yet. */
  events: readonly ActivityEvent[] | null;
  timeSaved: TimeSaved | null;
  inFlight: InFlight | null;
  allowance: UsageAllowance | null;
  /** The render instant, decided once by the screen. See QueueList. */
  now: Date;
}) {
  const t = await getTranslations('home.working');
  const format = await getFormatter();

  return (
    <section className={styles.activityCard}>
      <div className={styles.activityTitle}>
        <span className={styles.activityDot} aria-hidden="true" />
        {t('title')}
      </div>

      {inFlight ? <p className={styles.activityLead}>{rightNow(inFlight, t, format)}</p> : null}

      {events === null ? (
        <p className={styles.activityLead}>{t('unavailable')}</p>
      ) : events.length === 0 ? (
        <p className={styles.activityLead}>{t('empty')}</p>
      ) : (
        <ul className={styles.activityList}>
          {events.map((event) => (
            <li key={event.id} className={styles.activityEvent}>
              <span
                className={[styles.activityEventDot, DOT_CLASS[event.outcome]].join(' ').trim()}
                aria-hidden="true"
              />
              <span className={styles.activityEventText}>{describe(event, t, format)}</span>
              <time className={styles.activityEventTime} dateTime={event.at}>
                {clockTime(event.at, format)}
              </time>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.activityFooter}>
        {timeSaved ? (
          <div>
            <span className={styles.activityTimeSaved}>
              {t('timeSaved')}{' '}
              <span className={styles.activityTimeSavedValue}>
                {formatDuration(timeSaved.secondsSaved, t, format)}
              </span>
            </span>
            <p className={styles.activityBasis}>
              {timeSaved.basis?.source === 'measured'
                ? t('timeSavedMeasured')
                : t('timeSavedDefault')}
            </p>
          </div>
        ) : null}

        <Allowance allowance={allowance} now={now} t={t} format={format} />
      </div>
    </section>
  );
}

type Translate = (key: string, values?: Record<string, string>) => string;
type Format = Awaited<ReturnType<typeof getFormatter>>;

/**
 * Turns `kind` + `values` into a line.
 *
 * `eventMessage` decides the key and the blanks; this only formats the money
 * with the viewer's locale and hands both to the translator.
 */
function describe(event: ActivityEvent, t: Translate, format: Format): string {
  const { key, values } = eventMessage(event);
  return t(key, { ...values, amount: money(event.values, format) });
}

/** Locale-aware currency. Formatting a number is not composing a sentence. */
function money(values: Record<string, unknown>, format: Format): string {
  const amount = values.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return ABSENT;
  const currency = typeof values.currency === 'string' ? values.currency : 'ILS';
  try {
    return format.number(amount, { style: 'currency', currency, maximumFractionDigits: 0 });
  } catch {
    // An unrecognised currency code must not take the whole card down.
    return String(amount);
  }
}

function clockTime(at: string, format: Format): string {
  const when = new Date(at);
  return Number.isNaN(when.getTime()) ? '' : format.dateTime(when, { timeStyle: 'short' });
}

/**
 * `22800` → `6h 20m`, as the design writes it.
 *
 * The unit words come from the messages, not from literals: "h" and "m" are
 * English, and this card is read in Hebrew as often as not.
 */
function formatDuration(seconds: number, t: Translate, format: Format): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts = [
    hours > 0 ? t('duration.hours', { count: String(hours) }) : null,
    rest > 0 || hours === 0 ? t('duration.minutes', { count: String(rest) }) : null,
  ].filter((part): part is string => part !== null);
  return format.list(parts, { type: 'unit' });
}

/**
 * The card's opening line.
 *
 * Built by translating each clause and letting `format.list` join them: that is
 * locale-aware punctuation, not a sentence composed in code. Hebrew's
 * conjunction is not ", and", and hard-coding one would be visible.
 */
function rightNow(inFlight: InFlight, t: Translate, format: Format): string {
  const parts: string[] = [];

  if (inFlight.conversationsHandling > 0) {
    parts.push(t('now.conversations', { count: String(inFlight.conversationsHandling) }));
  }
  for (const tool of inFlight.toolsRunning) {
    if (tool.count <= 0 || !KNOWN_SUBJECTS.has(tool.subject)) continue;
    parts.push(t(`now.tool.${tool.subject}`, { count: String(tool.count) }));
  }
  if (inFlight.awaitingApproval > 0) {
    parts.push(t('now.approvals', { count: String(inFlight.awaitingApproval) }));
  }

  // Idle is a real state and worth saying, not an empty line.
  if (parts.length === 0) return t('now.idle');
  return t('now.lead', { summary: format.list(parts, { type: 'conjunction' }) });
}

/** Subjects with their own wording. An unmapped one is left out, not guessed. */
const KNOWN_SUBJECTS = new Set(['order', 'customer', 'contact', 'lead', 'deal', 'conversation']);

/**
 * Conversation headroom for the period.
 *
 * The bar shows what is LEFT, which is what the label counts. An uncapped plan
 * gets a sentence rather than a full bar: a meter at 100% would read as "nearly
 * out" to anyone who glanced at it.
 */
function Allowance({
  allowance,
  now,
  t,
  format,
}: {
  allowance: UsageAllowance | null;
  now: Date;
  t: Translate;
  format: Format;
}) {
  if (!allowance) return <p className={styles.activityBasis}>{t('allowance.unavailable')}</p>;
  if (allowance.limit === null || allowance.limit === undefined) {
    return <p className={styles.activityBasis}>{t('allowance.uncapped')}</p>;
  }

  const left = Math.max(0, allowance.limit - allowance.used);
  const fraction = allowance.limit > 0 ? left / allowance.limit : 0;
  const exhaustion = allowance.projectedExhaustionAt
    ? new Date(allowance.projectedExhaustionAt)
    : null;
  // The design turns the bar amber under a week of headroom.
  const isLow = exhaustion !== null && exhaustion.getTime() - now.getTime() < 7 * 86_400_000;

  return (
    <div>
      <div className={styles.allowanceHeader}>
        <span>{t('allowance.label')}</span>
        <span className={styles.allowanceValue}>{format.number(left)}</span>
      </div>
      <div
        className={styles.allowanceTrack}
        role="meter"
        aria-valuenow={left}
        aria-valuemin={0}
        aria-valuemax={allowance.limit}
        aria-label={t('allowance.label')}
      >
        <div
          className={[styles.allowanceFill, isLow ? styles.allowanceFillLow : ''].join(' ').trim()}
          style={{ inlineSize: `${Math.round(fraction * 100)}%` }}
        />
      </div>
      <p className={styles.allowanceProjection}>
        {exhaustion && !Number.isNaN(exhaustion.getTime())
          ? t('allowance.projection', {
              date: format.dateTime(exhaustion, { day: 'numeric', month: 'long' }),
            })
          : t('allowance.projectionNone')}
      </p>
    </div>
  );
}
