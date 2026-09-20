import { getFormatter, getTranslations } from 'next-intl/server';

import {
  isStoppable,
  openedWithoutReplying,
  shareOfSent,
  type Campaign,
} from '@/api/contracts/outreach';

import styles from './Outreach.module.css';
import { StopCampaign } from './StopCampaign';

/**
 * One campaign, on screen 05 and again as the result card on 05b.
 *
 * ── THE FIVE NUMBERS, AND THE FIFTH IS THE POINT ──
 * Sent, delivered, opened, replied — all four genuinely written — **and
 * failed**, which the design never asked for. A card showing only successes
 * is the same screen that showed twenty-seven approvals as "Approved" when
 * thirteen of them never ran.
 *
 * `converted` is absent because it is not a concept anywhere in this platform.
 * So *"41 bought"*, *"63 people bought"* and the `Bought · 5%` row are gone,
 * along with attributed revenue, the stock projection, the per-campaign
 * opt-out counter, the hourly reply chart and the reply categories.
 *
 * ── AND THE LINE THE DESIGN DID NOT ASK FOR ──
 * *"opened it and said nothing"* is `readCount − repliedCount`: a segment you
 * can act on, from two numbers that exist. The third time on this project that
 * subtracting two real numbers has beaten a fictional metric.
 */
export async function CampaignCard({
  campaign,
  detailed,
}: {
  readonly campaign: Campaign;
  /** 05b shows the rates; 05's in-flight list shows the headline only. */
  readonly detailed: boolean;
}) {
  const t = await getTranslations('outreach');
  const format = await getFormatter();

  const pct = (value: number) => {
    const share = shareOfSent(value, campaign);
    // null, not 0%: "nothing sent yet" and "0% of what was sent" are
    // different facts, and a row of 0% on a campaign that has not started is
    // the kind of number somebody screenshots.
    return share === null ? null : format.number(share, { style: 'percent' });
  };

  const silent = openedWithoutReplying(campaign);

  return (
    <article
      className={styles.card}
      data-testid={`campaign-${campaign.id}`}
      data-status={campaign.status}
    >
      <header className={styles.cardHead}>
        <h3 className={styles.cardName}>{campaign.name}</h3>
        <p className={styles.cardMeta}>
          {t(`status.${campaign.status}` as 'status.SENDING')}
          {campaign.channel ? ` · ${campaign.channel}` : null}
        </p>
      </header>

      {/*
        Why it stopped, where the platform knows. The model's own comment
        calls this "the last error when a broadcast halted", so a halted
        campaign says why instead of merely being halted.
      */}
      {campaign.lastError ? (
        <p className={styles.cardError} data-testid={`error-${campaign.id}`}>
          {t('card.halted', { reason: campaign.lastError })}
        </p>
      ) : null}

      <dl className={styles.counters}>
        <div className={styles.counter} data-testid={`sent-${campaign.id}`}>
          <dt>{t('counter.sent')}</dt>
          <dd>{format.number(campaign.sentCount)}</dd>
        </div>

        {detailed ? (
          <>
            <Counter label={t('counter.delivered')} value={campaign.deliveredCount} pct={pct} />
            <Counter label={t('counter.opened')} value={campaign.readCount} pct={pct} />
            <Counter label={t('counter.replied')} value={campaign.repliedCount} pct={pct} />
          </>
        ) : null}

        {/*
          Always shown, including when zero — "nothing failed" is a fact worth
          stating on a screen about messages reaching people, and hiding it at
          zero would make its appearance a surprise rather than a reading.
        */}
        <div className={styles.counter} data-testid={`failed-${campaign.id}`}>
          <dt>{t('counter.failed')}</dt>
          <dd>{format.number(campaign.failedCount)}</dd>
        </div>
      </dl>

      {detailed && silent > 0 ? (
        <p className={styles.silent} data-testid={`silent-${campaign.id}`}>
          {t('card.openedNoReply', { count: silent })}
        </p>
      ) : null}

      {isStoppable(campaign) ? <StopCampaign id={campaign.id} name={campaign.name} /> : null}
    </article>
  );
}

function Counter({
  label,
  value,
  pct,
}: {
  readonly label: string;
  readonly value: number;
  readonly pct: (value: number) => string | null;
}) {
  const share = pct(value);
  return (
    <div className={styles.counter}>
      <dt>{label}</dt>
      <dd>
        {new Intl.NumberFormat().format(value)}
        {share ? <span className={styles.share}>{share}</span> : null}
      </dd>
    </div>
  );
}
