import { ArrowUp, Check, CircleAlert, Clock, Sparkles } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { channelName } from '@/api/contracts/inbox';
import { Logo } from '@/design-system/brand/Logo';
import { UserText } from '@/design-system/primitives/text/UserText';
import { PersonName } from '@/features/customers/PersonName';
import { clockTime, describe } from '@/features/home/ActivityCard';
import { homeFace } from '@/features/home/first-steps';
import { loadHomeData, loadViewerFirstName } from '@/features/home/load-home-data';
import { waitLabel } from '@/features/home/queue-row';
import { TenantGateNotice } from '@/features/tenant-gate/TenantGateNotice';
import { Link } from '@/i18n/navigation';

import ui from '../mobile-ui.module.css';
import styles from './mobile-home.module.css';
import { greetingKey, rowTone } from './mobile-home';

const OUTCOME_ICON = {
  completed: Check,
  failed: CircleAlert,
  awaiting_approval: Clock,
} as const;

/**
 * The phone's Home, as `GOTCHA Mobile App.dc.html` draws it: the mark and the
 * wordmark, the greeting, the day on a dark card, who needs you, and what
 * GOTCHA did.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE WEBSITE'S LOADER, AND ONLY WHAT IT LOADS
 * ════════════════════════════════════════════════════════════════════════════
 * `loadHomeData` and `loadViewerFirstName`, the reads the desktop Home makes,
 * so a figure here is the figure there. The design's card says "since last
 * night" over sales and a response time; the overview is today's and has no
 * sales, so the card says "today" over today's counts. The bell and the
 * avatar are not drawn: the notifications are a website panel with no phone
 * screen behind it, and the account menu is the bar's end. The ask bar is
 * drawn (Omer, 2026-11-03) and opens `/m/home/ask`: the website's own
 * assistant thread, on a phone screen.
 *
 * ★ Unknown is not empty. A failed queue read says it failed; an empty one
 *   says nobody is waiting. A failed overview drops the card rather than
 *   showing zeros. "Updates" is always there: empty says so, failed says so.
 */
export async function MobileHome({ account }: { readonly account: ReactNode }) {
  const t = await getTranslations('mobile.home');
  const home = await getTranslations('home');
  const needsYou = await getTranslations('home.needsYou');
  const inbox = await getTranslations('inbox');
  const working = await getTranslations('home.working');
  const channelNames = await getTranslations('channels');
  const format = await getFormatter();

  const [data, firstName] = await Promise.all([loadHomeData(), loadViewerFirstName()]);
  const { overview, queue, queueItems, activity, isQuiet, setup, gate, open } = data;
  const now = new Date();

  const bar = <MobileHomeBar account={account} />;

  // The tenant is locked out: every figure would be absent for that one reason.
  if (homeFace({ setup, gate }) === 'gated' && gate) {
    return (
      <div className={ui.screen} data-testid="mobile-home">
        {bar}
        <div className={styles.scroll}>
          <TenantGateNotice gate={gate} inApp />
        </div>
      </div>
    );
  }

  /*
   * ★ ONE PERSON (Omer, 2026-11-15): the headline and "Needs you" are that
   *   person's Open conversations - the inbox's "Open" - as on the website.
   */
  const waiting = open ? open.count : (queue?.waiting ?? null);
  const needs = open
    ? { items: open.items, total: open.count ?? open.items?.length ?? 0, view: 'open' as const }
    : queueItems
      ? { items: queueItems.data, total: queueItems.totalWaiting, view: 'queue' as const }
      : { items: null, total: 0, view: 'queue' as const };
  const events = activity ?? [];
  const ask = (
    // The design's ask bar, floating over the screen's foot: a tap opens the full-screen chat.
    <Link href="/m/home/ask" className={styles.ask} data-testid="mobile-home-ask">
      <Sparkles size={19} strokeWidth={2} className={styles.askMark} aria-hidden="true" />
      <span className={styles.askText}>{t('ask')}</span>
      <span className={styles.askGo} aria-hidden="true">
        <ArrowUp size={18} strokeWidth={2} />
      </span>
    </Link>
  );

  return (
    <div className={ui.screen} data-testid="mobile-home">
      {bar}
      <div className={styles.scroll}>
        <header className={styles.greeting}>
          <span className={styles.date}>{format.dateTime(now, 'greeting')}</span>
          <h1 className={styles.hello}>
            {home(`greeting.${greetingKey(now.getHours(), isQuiet, firstName !== null)}`, {
              name: firstName ?? '',
            })}
          </h1>
        </header>

        {overview ? (
          <section className={styles.summary} data-testid="mobile-home-summary">
            <div className={styles.summaryHead}>
              <span className={styles.eyebrow}>{t('today')}</span>
              <p className={styles.headline}>
                {waiting === null
                  ? t('handled', { handled: overview.aiHandledCount })
                  : open
                    ? t('handledOpen', { handled: overview.aiHandledCount, open: waiting })
                    : t('handledWaiting', { handled: overview.aiHandledCount, waiting })}
              </p>
            </div>
            <div className={styles.tiles}>
              <Tile
                value={format.number(overview.totalConversations)}
                label={t('tiles.conversations')}
              />
              <Tile
                value={format.number(overview.humanHandledCount)}
                label={t('tiles.byYourTeam')}
              />
              <Tile
                value={format.number(overview.pendingApprovalCount)}
                label={t('tiles.approvals')}
              />
            </div>
          </section>
        ) : null}

        <section className={styles.block} data-testid="mobile-home-needs-you">
          <div className={styles.blockHead}>
            <h2 className={styles.blockTitle}>{t('needsYou')}</h2>
            {needs.items && needs.total > 0 ? (
              <span className={styles.blockCount}>{format.number(needs.total)}</span>
            ) : null}
          </div>
          <div className={ui.card}>
            {needs.items === null ? (
              <p className={styles.note} role="status">
                {needsYou(open ? 'open.unavailable' : 'unavailable')}
              </p>
            ) : needs.items.length === 0 ? (
              <p className={styles.note}>{needsYou(open ? 'open.empty' : 'empty')}</p>
            ) : (
              <>
                {needs.items.map((item) => (
                  <div key={item.conversationId} className={`${ui.cardRow} ${styles.need}`}>
                    <span
                      className={styles.needDot}
                      data-tone={item.intent === null ? 'neutral' : rowTone(item.intent)}
                      aria-hidden="true"
                    />
                    <div className={styles.needBody}>
                      <div className={styles.needTop}>
                        <span className={styles.needTitle}>
                          {/* No name means no contact record: the identifier as itself, as on the website. */}
                          {item.customer.name ? (
                            <PersonName name={item.customer.name} />
                          ) : (
                            item.customer.id || inbox('queue.unnamed')
                          )}
                        </span>
                        <span className={styles.needTime}>
                          {item.waitingSince === null
                            ? ''
                            : waitLabel(item.waitingSince, now.getTime(), needsYou)}
                        </span>
                      </div>
                      <span className={styles.needSub}>
                        <bdi dir="auto">
                          {channelName(item.channel, channelNames) ?? channelNames('name.other')}
                        </bdi>
                        {item.preview ? (
                          <>
                            {' · '}
                            <UserText>{item.preview}</UserText>
                          </>
                        ) : null}
                      </span>
                      <Link
                        href={`/m/inbox/${encodeURIComponent(item.conversationId)}` as '/m/inbox'}
                        className={styles.cta}
                        data-testid="mobile-home-need"
                      >
                        {t('open')}
                      </Link>
                    </div>
                  </div>
                ))}
                {needs.total > needs.items.length ? (
                  <Link
                    href={{ pathname: '/m/inbox', query: { view: needs.view } }}
                    className={`${ui.cardRow} ${ui.more}`}
                  >
                    {t(open ? 'moreOpen' : 'more', { count: needs.total - needs.items.length })}
                  </Link>
                ) : null}
              </>
            )}
          </div>
        </section>

        {/*
          Always drawn (Omer, 2026-11-03: "I see no updates"): a section that
          vanishes when empty reads as a screen that is missing a part. None
          is said as none, and a failed read as a failed read.
        */}
        <section className={styles.block} data-testid="mobile-home-updates">
          <h2 className={styles.blockTitle}>{t('updates')}</h2>
          {activity === null ? (
            <p
              className={`${ui.card} ${styles.note}`}
              role="status"
              data-testid="mobile-home-updates-unavailable"
            >
              {t('updatesUnavailable')}
            </p>
          ) : events.length === 0 ? (
            <p className={`${ui.card} ${styles.note}`} data-testid="mobile-home-updates-empty">
              {t('updatesEmpty')}
            </p>
          ) : (
            <ul className={styles.updates}>
              {events.map((event) => {
                const Icon = OUTCOME_ICON[event.outcome];
                const line = (
                  <>
                    <span className={styles.updateIcon} data-outcome={event.outcome}>
                      <Icon size={19} strokeWidth={2} aria-hidden="true" />
                    </span>
                    <span className={styles.updateText}>{describe(event, working, format)}</span>
                    <time className={styles.updateTime} dateTime={event.at}>
                      {clockTime(event.at, format)}
                    </time>
                  </>
                );
                return (
                  <li key={event.id}>
                    {/* Still waiting on a person: the one entry that can still be decided. */}
                    {event.outcome === 'awaiting_approval' ? (
                      <Link href="/m/approvals" className={styles.update}>
                        {line}
                      </Link>
                    ) : (
                      <div className={styles.update}>{line}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      {ask}
    </div>
  );
}

/**
 * Home's bar: the mark, the wordmark, the account menu at the end. Its own
 * function so the loading screen draws the same bar and nothing jumps.
 */
export function MobileHomeBar({ account }: { readonly account: ReactNode }) {
  return (
    <header className={styles.bar}>
      <span className={styles.brand}>
        <Logo size={30} />
        <span className={styles.wordmark}>GOTCHA</span>
      </span>
      <span className={styles.fill} />
      {account}
    </header>
  );
}

function Tile({ value, label }: { readonly value: string; readonly label: string }) {
  return (
    <div className={styles.tile}>
      <span className={`${ui.figure} ${styles.tileValue}`}>{value}</span>
      <span className={styles.tileLabel}>{label}</span>
    </div>
  );
}
