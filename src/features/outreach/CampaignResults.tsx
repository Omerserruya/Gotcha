import { getFormatter, getTranslations } from 'next-intl/server';

import { channelName } from '@/api/contracts/inbox';
import type { Campaign } from '@/api/contracts/outreach';

import styles from './Outreach.module.css';

/**
 * Screen 05b - after it went out, measured.
 *
 * A dark card (what it brought in) and a violet one (who read it and said
 * nothing) side by side; a six-figure strip; then "When people replied" and
 * "What they wrote back". `padding:24px 40px 30px`, `gap:16px`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ ONLY THE SEND IS RECORDED
 * ════════════════════════════════════════════════════════════════════════════
 * The worker writes a recipient `queued`, `sent` (with `sentAt`), `failed` or
 * `skipped` - and nothing writes `delivered`, `read` or `replied`, per
 * recipient or in the campaign's counters. Revenue is not attributed, replies
 * are not linked to the campaign, and nothing classifies them. So every part
 * of 05b is drawn, and the parts made of those are "-" in their shape:
 * a figure is a figure or a dash, never a confident zero.
 *
 * ⚠ "Send this again", "Pause the rest" and "Let it follow up" would create
 * outreach; that waits on Omer. They are drawn and not live.
 */

/** Sent, and of the rest: didn't arrive (failed) and never sent (skipped or not reached). */
export function sendFigures(campaign: Campaign): {
  readonly sent: number;
  readonly failed: number;
  readonly notSent: number;
} {
  const notSent = Math.max(0, campaign.totalRecipients - campaign.sentCount - campaign.failedCount);
  return { sent: campaign.sentCount, failed: campaign.failedCount, notSent };
}

/**
 * The hours the campaign went out over, one column each - from the hour it
 * started to the hour it finished, at most twelve. Empty when either time is
 * missing: an axis needs both ends.
 */
export function sendHours(campaign: Campaign): readonly Date[] {
  if (!campaign.startedAt || !campaign.completedAt) return [];
  const start = new Date(campaign.startedAt);
  const end = new Date(campaign.completedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  start.setMinutes(0, 0, 0);
  const hours: Date[] = [];
  for (let at = start.getTime(); at <= end.getTime() && hours.length < 12; at += 3_600_000) {
    hours.push(new Date(at));
  }
  return hours;
}

export async function BroughtIn({ campaign }: { readonly campaign: Campaign }) {
  const t = await getTranslations('outreach');
  const format = await getFormatter();
  return (
    <section className={styles.resBrought} data-testid="results-brought">
      <p className={styles.resBroughtEyebrow}>{t('results.brought.eyebrow')}</p>
      <p className={styles.resBroughtFigure}>
        {/* Revenue is not attributed to campaigns. */}
        <span className={styles.resBroughtValue}>-</span>
        <span className={styles.resBroughtFrom}>
          {t('results.brought.from', { count: format.number(campaign.sentCount) })}
        </span>
      </p>
      <p className={styles.resBroughtLine}>{t('results.brought.none')}</p>
      <div className={styles.resActions}>
        <span className={styles.resLight} aria-disabled="true">
          {t('results.brought.pause')}
        </span>
        <span className={styles.resDarkOutline} aria-disabled="true">
          {t('results.brought.again')}
        </span>
      </div>
    </section>
  );
}

export async function SaidNothing() {
  const t = await getTranslations('outreach');
  return (
    <section className={styles.resQuiet} data-testid="results-quiet">
      <p className={styles.resQuietTitle}>{t('results.quiet.title')}</p>
      <p className={styles.resQuietBody}>{t('results.quiet.none')}</p>
      <div className={styles.resActions}>
        <span className={styles.resPrimary} aria-disabled="true">
          {t('results.quiet.follow')}
        </span>
        <span className={styles.resVioletOutline} aria-disabled="true">
          {t('results.quiet.leave')}
        </span>
      </div>
    </section>
  );
}

export async function ResultStrip({ campaign }: { readonly campaign: Campaign }) {
  const t = await getTranslations('outreach');
  const format = await getFormatter();
  const { sent, failed } = sendFigures(campaign);
  const cells = [
    {
      key: 'sent',
      value: format.number(sent),
      note: failed > 0 ? t('results.strip.failed', { count: format.number(failed) }) : null,
    },
    // Nothing writes these: per recipient or in the counters.
    { key: 'delivered', value: '-', note: null },
    { key: 'opened', value: '-', note: null },
    { key: 'replied', value: '-', note: null },
    { key: 'bought', value: '-', note: null },
    { key: 'optedOut', value: '-', note: null },
  ] as const;
  return (
    <dl className={styles.resStrip} data-testid="results-strip">
      {cells.map((cell) => (
        <div key={cell.key} className={styles.resCell} data-testid={`results-${cell.key}`}>
          <dt>{t(`results.strip.${cell.key}`)}</dt>
          <dd>
            <span className={styles.resCellValue}>{cell.value}</span>
            {cell.note ? <span className={styles.resCellNote}>{cell.note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 02's "When people replied": a bar per hour the campaign went out over.
 * The axis is real - the hours it was sending - and the bars are empty,
 * because nothing records a reply against the campaign.
 */
export async function RepliesByHour({ campaign }: { readonly campaign: Campaign }) {
  const t = await getTranslations('outreach');
  const format = await getFormatter();
  const hours = sendHours(campaign);
  const clock = (at: Date) =>
    format.dateTime(at, { hour: '2-digit', minute: '2-digit', hour12: false });
  return (
    <section className={styles.resChart} data-testid="results-hours">
      <header className={styles.resChartHead}>
        <h2 className={styles.resCardTitle}>{t('results.hours.title')}</h2>
        {hours.length > 0 ? (
          <span className={styles.resCardMeta}>
            {t('results.hours.span', { count: hours.length, from: clock(hours[0]!) })}
          </span>
        ) : null}
      </header>
      {hours.length > 0 ? (
        <ol className={styles.resBars}>
          {hours.map((hour) => (
            <li key={hour.toISOString()} className={styles.resBar}>
              <span className={styles.resBarTrack} aria-hidden="true" />
              <span className={styles.resBarLabel}>{clock(hour)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <div className={styles.resBarsEmpty} />
      )}
      <p className={styles.resChartFoot}>{t('results.hours.none')}</p>
    </section>
  );
}

/** 02's "What they wrote back": replies grouped by what they asked. Nothing classifies them yet. */
export async function WroteBack() {
  const t = await getTranslations('outreach');
  return (
    <section className={styles.resReplies} data-testid="results-replies">
      <header className={styles.resRepliesHead}>
        <h2 className={styles.resCardTitle}>{t('results.replies.title')}</h2>
        <span className={styles.resCardMeta}>-</span>
      </header>
      <p className={styles.resRepliesNone}>{t('results.replies.none')}</p>
      <p className={styles.resRepliesFoot}>{t('results.replies.foot')}</p>
    </section>
  );
}

/** The header's line: "Finished 40 minutes ago · WhatsApp", or the state it is in. */
export async function resultsLine(campaign: Campaign, now: Date): Promise<string> {
  const t = await getTranslations('outreach');
  const channels = await getTranslations('channels');
  const format = await getFormatter();
  const channel = channelName(campaign.channel, channels) ?? campaign.channel;
  const when =
    campaign.status === 'COMPLETED' && campaign.completedAt
      ? t('results.finished', { when: format.relativeTime(new Date(campaign.completedAt), now) })
      : t(`status.${campaign.status}` as 'status.SENDING');
  return [when, channel].filter(Boolean).join(' · ');
}
