import { PhoneIncoming, PhoneMissed, PhoneOutgoing } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';

import { wasAnswered, type Call, type CallSummary } from '@/api/contracts/calls';
import type { CustomerRow } from '@/api/contracts/customers';
import { initialsOf } from '@/features/customers/CustomerScreen';
import { displayHandle } from '@/features/customers/phone';
import { Link } from '@/i18n/navigation';

import { CallButton } from './CallButton';
import { dialable, pastedNumber } from './dial';
import styles from './Calls.module.css';

/**
 * Screen 05d — phone calls, measured.
 *
 * A 400 dialer card (02 draws it in focus, `#C9BCF7`) beside a 724 column:
 * the week's four figures, then the recent calls with their filters and a
 * foot. `padding:22px 40px 30px`, `gap:14px`, each card scrolling inside.
 *
 * ⚠ NOTHING HERE PLACES A CALL. "Start a call", "Call Dana" and "Let GOTCHA
 * call her" would ring a real phone; like Send, that waits on Omer. The
 * search is live — it reads the customers list's own search — and the
 * buttons are drawn and not live.
 */

export const CALL_FILTERS = ['all', 'incoming', 'outgoing', 'missed'] as const;
export type CallFilter = (typeof CALL_FILTERS)[number];

export function parseCallFilter(raw: string | undefined): CallFilter {
  return (CALL_FILTERS as readonly string[]).includes(raw ?? '') ? (raw as CallFilter) : 'all';
}

/** Missed: an inbound call nobody answered. `answeredAt`, never `status` — see `wasAnswered`. */
export function isMissed(call: Call): boolean {
  return call.direction === 'inbound' && !wasAnswered(call);
}

export function keepCall(call: Call, filter: CallFilter): boolean {
  if (filter === 'incoming') return call.direction === 'inbound';
  if (filter === 'outgoing') return call.direction === 'outbound';
  if (filter === 'missed') return isMissed(call);
  return true;
}

/** "3m 12s", "52s" — 02's mono duration. Null is "—", never "0s". */
export function callDuration(ms: number | null): string {
  if (ms === null) return '—';
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

/** The dialer: who do you want to call. */
export async function DialerCard({
  query,
  results,
  line = 'ok',
  quiet = null,
}: {
  readonly query: string;
  /**
   * Whether the workspace can place a call at all: voice off, or on with no
   * number, is said on the Call button rather than refused after the click.
   * Unknown is not a refusal — the route says.
   */
  readonly line?: 'ok' | 'off' | 'noNumber';
  /** `null` when the search failed; empty when nobody matched. */
  readonly results: readonly CustomerRow[] | null;
  /** Who went quiet — 02's first list; `null` when unread. */
  readonly quiet?: { readonly count: number; readonly capped: boolean } | null;
}) {
  const t = await getTranslations('calls');
  const chosen = results?.[0] ?? null;
  const chosenName = chosen
    ? (chosen.displayName ?? displayHandle('VOICE', chosen.phone ?? ''))
    : null;

  return (
    <section className={styles.dialer} data-testid="calls-dialer">
      <header className={styles.dialerHead}>
        <h2 className={styles.dialerTitle}>{t('dialer.title')}</h2>
        <p className={styles.dialerSub}>{t('dialer.sub')}</p>
      </header>

      {/* A GET form: the query lives in the URL, as the customers list's does. */}
      <form className={styles.dialerSearch} role="search" action="" method="get">
        <label className="srOnly" htmlFor="dialer-q">
          {t('dialer.title')}
        </label>
        <input
          id="dialer-q"
          name="q"
          type="search"
          defaultValue={query}
          placeholder={t('dialer.placeholder')}
          className={styles.dialerInput}
          data-testid="dialer-q"
        />
      </form>

      <div className={styles.dialerBody}>
        <p className={styles.dialerEyebrow}>{t('dialer.customers')}</p>
        {query.trim() === '' ? (
          <p className={styles.dialerNone}>{t('dialer.typeToSearch')}</p>
        ) : results === null ? (
          <p className={styles.dialerNone} data-testid="dialer-failed">
            {t('dialer.searchFailed')}
          </p>
        ) : results.length === 0 ? (
          <p className={styles.dialerNone} data-testid="dialer-no-match">
            {t('dialer.noMatch')}
          </p>
        ) : (
          <ul className={styles.dialerList} data-testid="dialer-results">
            {results.slice(0, 6).map((row, index) => (
              <li key={row.id}>
                <Link
                  href={`/customers/${row.id}`}
                  className={styles.dialerRow}
                  aria-current={index === 0 ? 'true' : undefined}
                  data-testid={`dialer-${row.id}`}
                >
                  <span className={styles.dialerDisc} aria-hidden="true">
                    {initialsOf(row.displayName)}
                  </span>
                  <span className={styles.dialerWho}>
                    <span className={styles.dialerName}>
                      {row.displayName ?? displayHandle('VOICE', row.phone ?? row.externalId)}
                    </span>
                    <span className={styles.dialerLine}>
                      {row.phone ? displayHandle('VOICE', row.phone) : (row.email ?? '—')}
                    </span>
                  </span>
                  {/* 02's "Trade": the merchant's own tag on the person. */}
                  {row.tags[0] ? <span className={styles.dialerTag}>{row.tags[0]}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        )}

        {/*
          02's "Or have GOTCHA call a list". The list is real — who went quiet
          — and opens on Customers; GOTCHA calling it is not built, so the row
          names the people and promises no call ("It asks one question…").
        */}
        <p className={`${styles.dialerEyebrow} ${styles.dialerEyebrowRule}`}>{t('dialer.lists')}</p>
        {quiet && quiet.count > 0 ? (
          <ul className={styles.dialerList} data-testid="dialer-lists">
            <li>
              <Link
                href={{ pathname: '/customers', query: { segment: 'quiet' } }}
                className={styles.dialerListRow}
                title={t('dialer.listNotYet')}
                data-testid="dialer-list-quiet"
              >
                <span className={styles.dialerWho}>
                  <span className={styles.dialerListName}>
                    {t(quiet.capped ? 'dialer.listQuietCapped' : 'dialer.listQuiet', {
                      count: quiet.count,
                    })}
                  </span>
                  <span className={styles.dialerLine}>{t('dialer.listQuietLine')}</span>
                </span>
                <span className={styles.dialerChevron} aria-hidden="true">
                  ›
                </span>
              </Link>
            </li>
          </ul>
        ) : (
          <p className={styles.dialerNone} data-testid="dialer-lists">
            {t('dialer.listsNone')}
          </p>
        )}
      </div>

      <footer className={styles.dialerFoot}>
        {/* 05d: live — the chosen person's phone, or a number pasted as it is. */}
        <CallButton
          to={chosen ? dialable(chosen.phone) : pastedNumber(query)}
          blocked={
            line === 'off' ? t('notEnabled') : line === 'noNumber' ? t('noNumber') : undefined
          }
          label={
            chosenName
              ? t('dialer.call', { name: chosenName.split(/\s+/)[0]! })
              : pastedNumber(query)
                ? t('dialer.call', { name: pastedNumber(query)! })
                : t('dialer.callSomeone')
          }
        />
        <span className={styles.dialerHand} aria-disabled="true" title={t('dialer.notYet')}>
          {t('dialer.letGotcha')}
        </span>
      </footer>
    </section>
  );
}

/** 02's four figures, for the week the summary was asked for. */
export async function CallStats({ week }: { readonly week: CallSummary | null }) {
  const t = await getTranslations('calls');
  const format = await getFormatter();
  const cells = [
    { key: 'week', value: week ? format.number(week.total) : '—' },
    // Nothing records who answered: GOTCHA or a person.
    { key: 'gotchaAnswered', value: '—' },
    {
      key: 'average',
      value: week && week.averageDurationMs !== null ? callDuration(week.averageDurationMs) : '—',
    },
    // Nothing ties a call to a sale.
    { key: 'sale', value: '—' },
  ] as const;
  return (
    <dl className={styles.stats} data-testid="call-stats">
      {cells.map((cell) => (
        <div key={cell.key} className={styles.statCell} data-testid={`stat-${cell.key}`}>
          <dt>{t(`stats.${cell.key}`)}</dt>
          <dd>{cell.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What the recent-calls card says when it has no rows, by reason. */
export type CallsState = 'unknown' | 'off' | 'failed' | 'noNumber' | 'none' | 'ok';

/**
 * 02's recent calls: direction, the person, the length, what came of it,
 * when, and the transcript.
 *
 * ⚠ "What came of it" is the call's own fact, not 02's summary sentence —
 * no outcome summary is stored per call. Nobody picked up, it failed, or it
 * was answered and nothing more is known ("—").
 */
export async function RecentCalls({
  calls,
  state,
  filter,
}: {
  readonly calls: readonly Call[];
  readonly state: CallsState;
  readonly filter: CallFilter;
}) {
  const t = await getTranslations('calls');
  const format = await getFormatter();
  const now = new Date();
  const shown = calls.filter((call) => keepCall(call, filter));

  const when = (iso: string | null) => {
    if (!iso) return '—';
    const at = new Date(iso);
    const days = Math.floor(
      (new Date(now.toDateString()).getTime() - new Date(at.toDateString()).getTime()) / 86_400_000,
    );
    if (days <= 0)
      return format.dateTime(at, { hour: '2-digit', minute: '2-digit', hour12: false });
    if (days === 1) return t('when.yesterday');
    if (days < 7) return format.dateTime(at, { weekday: 'long' });
    return `${format.dateTime(at, { day: 'numeric' })} ${format.dateTime(at, { month: 'short' })}`;
  };

  const outcome = (call: Call): { text: string; tone: 'ok' | 'missed' | 'other' } => {
    if (isMissed(call)) return { text: t('outcome.missed'), tone: 'missed' };
    if (call.status === 'failed') return { text: t('outcome.failed'), tone: 'other' };
    if (call.direction === 'outbound' && !wasAnswered(call)) {
      return { text: t('outcome.notAnswered'), tone: 'missed' };
    }
    return { text: '—', tone: 'ok' };
  };

  return (
    <section className={styles.recent} data-testid="recent-calls">
      <header className={styles.recentHead}>
        <h2 className={styles.recentTitle}>{t('recent.title')}</h2>
        <nav className={styles.recentFilters} aria-label={t('recent.title')}>
          {CALL_FILTERS.map((key) => (
            <Link
              key={key}
              href={{ pathname: '/outreach/calls', query: key === 'all' ? {} : { calls: key } }}
              className={styles.recentFilter}
              aria-current={filter === key ? 'true' : undefined}
              data-testid={`call-filter-${key}`}
            >
              {t(`recent.filter.${key}`)}
            </Link>
          ))}
        </nav>
      </header>

      <div className={styles.recentBody}>
        {state !== 'ok' ? (
          /* The reason in one line; what would change it, its tooltip. */
          <p
            className={styles.recentNone}
            data-testid={`calls-${state}`}
            title={
              state === 'off'
                ? t('notEnabledBody')
                : state === 'noNumber'
                  ? t('noNumberBody')
                  : state === 'none'
                    ? t('noneBody')
                    : undefined
            }
          >
            {state === 'unknown'
              ? t('availabilityUnknown')
              : state === 'off'
                ? t('notEnabled')
                : state === 'failed'
                  ? t('unavailable')
                  : state === 'noNumber'
                    ? t('noNumber')
                    : t('none')}
          </p>
        ) : shown.length === 0 ? (
          <p className={styles.recentNone} data-testid="calls-filter-empty">
            {t('recent.filterEmpty')}
          </p>
        ) : (
          <ul className={styles.recentList}>
            {shown.map((call) => {
              const result = outcome(call);
              const Icon = isMissed(call)
                ? PhoneMissed
                : call.direction === 'outbound'
                  ? PhoneOutgoing
                  : PhoneIncoming;
              const who = displayHandle('VOICE', call.customerNumber) || t('recent.unknownNumber');
              return (
                <li key={call.id} className={styles.recentRow} data-testid={`call-${call.id}`}>
                  <span className={styles.recentIcon} data-missed={isMissed(call) ? '' : undefined}>
                    <Icon size={13} strokeWidth={2} aria-hidden="true" />
                    <span className="srOnly">
                      {isMissed(call)
                        ? t('recent.filter.missed')
                        : t(`direction.${call.direction}` as 'direction.inbound')}
                    </span>
                  </span>
                  <span className={styles.recentWho}>
                    {call.customerId ? (
                      <Link href={`/customers/${call.customerId}`} className={styles.recentName}>
                        {who}
                      </Link>
                    ) : (
                      <span className={styles.recentName}>{who}</span>
                    )}
                  </span>
                  <span className={styles.recentLength}>{callDuration(call.durationMs)}</span>
                  <span className={styles.recentOutcome} data-tone={result.tone}>
                    <span className={styles.recentDot} aria-hidden="true" />
                    {result.text}
                  </span>
                  <span className={styles.recentWhen}>{when(call.startedAt)}</span>
                  {/* The call's conversation holds its transcript. */}
                  <Link
                    href={{ pathname: '/inbox', query: { c: call.conversationId } }}
                    className={styles.recentTranscript}
                  >
                    {t('recent.transcript')}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* True of every call: each has its conversation. Nothing states a retention period. */}
      <p className={styles.recentFoot}>{t('recent.foot')}</p>
    </section>
  );
}

export { dialable, pastedNumber } from './dial';
