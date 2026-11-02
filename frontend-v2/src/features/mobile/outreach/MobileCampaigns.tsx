import { getFormatter, getTranslations } from 'next-intl/server';

import { channelName } from '@/api/contracts/inbox';
import type { Campaign } from '@/api/contracts/outreach';
import { campaignWhen } from '@/features/outreach/when';
import { Link } from '@/i18n/navigation';

import styles from './mobile-outreach.module.css';
import { audienceWords, sentShare, whenWords } from './mobile-outreach';

/**
 * The campaigns as a phone list - VIEW ONLY.
 *
 * ★ The desktop list's facts (`InFlightList`): the name, the channel and how
 *   many people, the bar of sent over recipients and its caption, the status.
 *   A tap opens the campaign's own screen. Nothing here creates, sends or
 *   stops: that is the website's, one link away.
 *
 * ⚠ ONLY SENT AND FAILED ARE COUNTED. Delivered, read and replied are
 *   initialised to zero and never written, so they are never printed as
 *   numbers - the desktop's rule, kept.
 */
export async function MobileCampaignList({
  campaigns,
  now,
}: {
  /** In flight first, then what already went: the desktop's order. */
  readonly campaigns: readonly Campaign[];
  readonly now: Date;
}) {
  const t = await getTranslations('outreach');
  const channels = await getTranslations('channels');
  const format = await getFormatter();

  return (
    <ul className={styles.list} data-testid="mobile-campaigns">
      {campaigns.map((campaign) => {
        const share = sentShare(campaign);
        const line = [
          channelName(campaign.channel, channels),
          t('list.people', { count: campaign.totalRecipients }),
          campaign.status === 'SCHEDULED' ? campaignWhen(campaign.scheduledAt, now, format) : null,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <li key={campaign.id}>
            <Link
              href={`/m/outreach/${campaign.id}` as '/m/outreach'}
              className={styles.row}
              data-status={campaign.status}
              data-testid={`mobile-campaign-${campaign.id}`}
            >
              <span className={styles.top}>
                <span className={styles.name} dir="auto">
                  {campaign.name}
                </span>
                <span className={styles.pill} data-status={campaign.status}>
                  {t(`status.${campaign.status}` as 'status.SENDING')}
                </span>
              </span>
              {line ? <span className={styles.line}>{line}</span> : null}
              {campaign.status === 'SCHEDULED' || campaign.status === 'DRAFT' ? null : (
                <span className={styles.progress}>
                  {share === null ? null : (
                    <span className={styles.bar} aria-hidden="true">
                      <span
                        className={styles.barFill}
                        style={{ inlineSize: `${Math.round(share * 100)}%` }}
                      />
                    </span>
                  )}
                  <span className={styles.caption} data-testid={`mobile-progress-${campaign.id}`}>
                    {t('list.sentShort', {
                      sent: format.number(campaign.sentCount),
                      total: format.number(campaign.totalRecipients),
                    })}
                    {campaign.failedCount > 0
                      ? ` · ${t('list.failedShort', { count: format.number(campaign.failedCount) })}`
                      : null}
                  </span>
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One campaign on the phone: who, where, when, and what reached people.
 *
 * ★ The desktop card's fields (`CampaignCard`, `detailed`) without its
 *   controls - no Stop, no Send. Sent and "didn't arrive" are always shown,
 *   zero included ("nothing failed" is a fact). Delivered and replied are said as not counted yet, in the desktop's
 *   words, never as zeroes.
 */
export async function MobileCampaignSummary({
  campaign,
  now,
}: {
  readonly campaign: Campaign;
  readonly now: Date;
}) {
  const t = await getTranslations('outreach');
  const channels = await getTranslations('channels');
  const format = await getFormatter();
  const channel = channelName(campaign.channel, channels);
  const when = whenWords(campaign, (iso) => campaignWhen(iso, now, format));
  const audience = audienceWords(campaign.audience, (c) => channelName(c, channels));

  return (
    <article className={styles.summary} data-testid={`mobile-campaign-summary-${campaign.id}`}>
      <header className={styles.summaryHead}>
        <h1 className={styles.summaryName} dir="auto">
          {campaign.name}
        </h1>
        <span className={styles.pill} data-status={campaign.status}>
          {t(`status.${campaign.status}` as 'status.SENDING')}
        </span>
      </header>

      {campaign.lastError ? (
        <p className={styles.error} data-testid="mobile-campaign-error">
          {t('card.halted', { reason: campaign.lastError })}
        </p>
      ) : null}

      <dl className={styles.figures}>
        <div>
          <dt>{t('results.strip.sent')}</dt>
          <dd data-testid="mobile-campaign-sent">{format.number(campaign.sentCount)}</dd>
        </div>
        <div>
          <dt>{t('counter.failed')}</dt>
          <dd data-testid="mobile-campaign-failed">{format.number(campaign.failedCount)}</dd>
        </div>
      </dl>

      <dl className={styles.fields}>
        <div className={styles.field}>
          <dt>{t('detail.who')}</dt>
          <dd>
            {t(audience.key as 'detail.audience.everyone', audience.values as never)}
            <span className={styles.fieldStrong}>
              {t('list.people', { count: campaign.totalRecipients })}
            </span>
          </dd>
        </div>
        {channel ? (
          <div className={styles.field}>
            <dt>{t('detail.where')}</dt>
            <dd>{channel}</dd>
          </div>
        ) : null}
        <div className={styles.field}>
          <dt>{t('detail.when')}</dt>
          <dd data-testid="mobile-campaign-when">
            {t(when.key as 'list.startedOn', { when: when.when ?? '' })}
          </dd>
        </div>
        <div className={styles.field}>
          <dt>{t('detail.delivery')}</dt>
          <dd className={styles.absent}>
            <span>{t('detail.deliveredShort')}</span>
            <span>{t('detail.repliedShort')}</span>
          </dd>
        </div>
      </dl>
    </article>
  );
}
