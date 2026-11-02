import { getFormatter, getTranslations } from 'next-intl/server';

import { channelName } from '@/api/contracts/inbox';
import type { Campaign } from '@/api/contracts/outreach';
import { ChannelMark } from '@/design-system/brand/channel-marks';
import { campaignWhen } from '@/features/outreach/when';
import { Link } from '@/i18n/navigation';

import ui from '../mobile-ui.module.css';
import styles from './mobile-outreach.module.css';
import {
  audienceWords,
  CAMPAIGN_GROUPS,
  groupOf,
  sentShare,
  statusTone,
  whenWords,
  type CampaignGroup,
} from './mobile-outreach';

/** The status tag, in the design's tones. */
async function StatusTag({ status }: { readonly status: Campaign['status'] }) {
  const t = await getTranslations('outreach');
  return (
    <span className={ui.tag} data-tone={statusTone(status)} data-status={status}>
      {t(`status.${status}` as 'status.SENDING')}
    </span>
  );
}

/**
 * The chips over the list: all, running, scheduled, finished - each counted
 * from the whole list, which `GET /api/broadcasts` returns in one read.
 */
export async function MobileCampaignChips({
  campaigns,
  show,
}: {
  readonly campaigns: readonly Campaign[];
  readonly show: CampaignGroup | null;
}) {
  const t = await getTranslations('mobile');
  const format = await getFormatter();
  const chips: readonly (CampaignGroup | 'all')[] = ['all', ...CAMPAIGN_GROUPS];

  return (
    <nav
      className={ui.chips}
      aria-label={t('outreach.chipsLabel')}
      data-testid="mobile-campaign-chips"
    >
      {chips.map((key) => {
        const count =
          key === 'all' ? null : campaigns.filter((c) => groupOf(c.status) === key).length;
        const current = key === 'all' ? show === null : show === key;
        return (
          <Link
            key={key}
            href={key === 'all' ? '/m/outreach' : { pathname: '/m/outreach', query: { show: key } }}
            className={ui.chip}
            aria-current={current ? 'page' : undefined}
            replace
            data-testid={`mobile-campaign-chip-${key}`}
          >
            <span>{t(`outreach.chips.${key}`)}</span>
            {count === null ? null : <span className={ui.chipCount}>{format.number(count)}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The campaigns as a phone list - VIEW ONLY.
 *
 * ★ The design's row: the channel's mark on a white tile, the name and its
 *   status, a line of who and when, and while it runs the bar of sent over
 *   recipients. A tap opens the campaign's own screen. Nothing here creates,
 *   sends or stops: that is the website's, one link away.
 *
 * ⚠ ONLY SENT AND FAILED ARE COUNTED. Delivered, read and replied are
 *   initialised to zero and never written, so they are never printed as
 *   numbers - the desktop's rule, kept.
 */
export async function MobileCampaignList({
  campaigns,
  now,
}: {
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
          t('list.people', { count: campaign.totalRecipients }),
          campaign.status === 'SCHEDULED'
            ? campaignWhen(campaign.scheduledAt, now, format)
            : channelName(campaign.channel, channels),
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
              <span className={styles.tile} aria-hidden="true">
                <ChannelMark channel={campaign.channel || null} size={24} decorative />
              </span>
              <span className={styles.body}>
                <span className={styles.top}>
                  <span className={styles.name} dir="auto">
                    {campaign.name}
                  </span>
                  <StatusTag status={campaign.status} />
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
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One campaign on the phone, as the design's campaign sheet: the channel
 * tile, the name and status, then who, where, when and what reached people.
 *
 * ★ The desktop card's fields (`CampaignCard`, `detailed`) without its
 *   controls - no Stop, no Send. Sent and "didn't arrive" are always shown,
 *   zero included ("nothing failed" is a fact). Delivered and replied are
 *   said as not counted yet, in the desktop's words, never as zeroes.
 *
 * ⚠ NO MESSAGE PREVIEW. The sheet draws the message as a bubble; the
 *   campaign contract carries no body, so there is nothing true to draw.
 */
export async function MobileCampaignSummary({
  campaign,
  now,
}: {
  readonly campaign: Campaign;
  readonly now: Date;
}) {
  const t = await getTranslations('outreach');
  const m = await getTranslations('mobile');
  const channels = await getTranslations('channels');
  const format = await getFormatter();
  const channel = channelName(campaign.channel, channels);
  const when = whenWords(campaign, (iso) => campaignWhen(iso, now, format));
  const audience = audienceWords(campaign.audience, (c) => channelName(c, channels));

  return (
    <article className={styles.summary} data-testid={`mobile-campaign-summary-${campaign.id}`}>
      <header className={styles.summaryHead}>
        <span className={styles.summaryTile} aria-hidden="true">
          <ChannelMark channel={campaign.channel || null} size={22} decorative />
        </span>
        <span className={styles.summaryTitle}>
          <h1 className={styles.summaryName} dir="auto">
            {campaign.name}
          </h1>
          <StatusTag status={campaign.status} />
        </span>
      </header>

      {campaign.lastError ? (
        <p className={styles.error} data-testid="mobile-campaign-error">
          {t('card.halted', { reason: campaign.lastError })}
        </p>
      ) : null}

      <dl className={styles.fields}>
        <div className={styles.field}>
          <dt>{t('detail.who')}</dt>
          <dd>
            {t(audience.key as 'detail.audience.everyone', audience.values as never)}
            {' · '}
            {t('list.people', { count: campaign.totalRecipients })}
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
          <dd>
            <span className={styles.counts}>
              <span>
                <span className={ui.figure} data-testid="mobile-campaign-sent">
                  {format.number(campaign.sentCount)}
                </span>{' '}
                {t('results.strip.sent')}
              </span>
              <span>
                <span className={ui.figure} data-testid="mobile-campaign-failed">
                  {format.number(campaign.failedCount)}
                </span>{' '}
                {t('counter.failed')}
              </span>
            </span>
            <span className={styles.absent}>{t('detail.deliveredShort')}</span>
          </dd>
        </div>
        <div className={styles.field}>
          <dt>{m('outreach.replies')}</dt>
          <dd className={styles.absent}>{t('detail.repliedShort')}</dd>
        </div>
      </dl>
    </article>
  );
}
