import { getFormatter, getTranslations } from 'next-intl/server';

import { channelName } from '@/api/contracts/inbox';
import type { Campaign } from '@/api/contracts/outreach';
import { Link } from '@/i18n/navigation';

import styles from './Outreach.module.css';

/**
 * 05's "In flight" — one card, one row per campaign.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ MEASURED, AND WHAT EACH PART IS MADE OF
 * ════════════════════════════════════════════════════════════════════════════
 * Rows at `padding:15px 18px`, `gap:16px`, `#F0EDE7` between them, a 3px
 * edge in the status's colour (sending green, scheduled stone, finished none).
 * Each: the name at 13.5/500 over a 12px line — the channel and how many
 * people — then a 170px progress bar with its caption, and a status pill.
 *
 * ⚠ THE BAR IS SENT OF RECIPIENTS, AND THE CAPTION SAYS ONLY THAT. 02 writes
 *   "794 sent · 312 opened · 41 bought". `sentCount` and `failedCount` are
 *   the only counters the platform increments; delivered, read and replied
 *   are initialised to zero and never written (see `CampaignCard`), so
 *   printing them would be three confident zeroes.
 *
 * A row is a link to `?campaign=<id>`: the right-hand column shows the one
 * selected, and the URL keeps it across a reload.
 */
export async function InFlightList({
  campaigns,
  selectedId,
}: {
  readonly campaigns: readonly Campaign[];
  readonly selectedId: string | null;
}) {
  const t = await getTranslations('outreach');
  const channels = await getTranslations('channels');
  const format = await getFormatter();
  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }) : null;

  return (
    <section className={styles.listSection} data-testid="section-in-flight">
      <h2 className={styles.listHeading}>{t('list.heading')}</h2>
      <ol className={styles.listCard}>
        {campaigns.map((campaign) => {
          const channel = channelName(campaign.channel, channels);
          const share =
            campaign.totalRecipients > 0
              ? Math.min(1, campaign.sentCount / campaign.totalRecipients)
              : null;
          const line = [channel, t('list.people', { count: campaign.totalRecipients })]
            .filter(Boolean)
            .join(' · ');
          return (
            <li key={campaign.id} className={styles.listItem}>
              <Link
                href={{ pathname: '/outreach', query: { campaign: campaign.id } }}
                className={styles.listRow}
                data-testid={`row-${campaign.id}`}
                data-status={campaign.status}
                aria-current={campaign.id === selectedId ? 'true' : undefined}
              >
                <span className={styles.listText}>
                  <span className={styles.listName}>{campaign.name}</span>
                  <span className={styles.listLine}>{line}</span>
                </span>

                <span className={styles.listProgress}>
                  {campaign.status === 'SCHEDULED' ? (
                    <span className={styles.listCaption}>
                      {t('list.scheduledFor', { when: when(campaign.scheduledAt) ?? '' })}
                    </span>
                  ) : (
                    <>
                      {share === null ? null : (
                        <span className={styles.bar} aria-hidden="true">
                          <span
                            className={styles.barFill}
                            style={{ inlineSize: `${Math.round(share * 100)}%` }}
                          />
                        </span>
                      )}
                      <span className={styles.listCaption} data-testid={`progress-${campaign.id}`}>
                        {t('list.sentOf', {
                          sent: format.number(campaign.sentCount),
                          total: format.number(campaign.totalRecipients),
                        })}
                        {campaign.failedCount > 0
                          ? ` · ${t('list.didntArrive', { count: format.number(campaign.failedCount) })}`
                          : null}
                      </span>
                    </>
                  )}
                </span>

                <span className={styles.statusPill} data-status={campaign.status}>
                  {t(`status.${campaign.status}` as 'status.SENDING')}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * 05's "This month" strip — only the figures the platform writes.
 *
 * 02 draws Reached · Replied · Revenue · Opted out. Reached is `sentCount`,
 * summed over this month's campaigns. Replied is never recorded, revenue is
 * not attributed to campaigns, and opt-outs are not counted per period — so
 * the strip carries what is true: reached, how many campaigns, and how many
 * messages did not arrive.
 */
export async function MonthStrip({
  campaigns,
  now,
}: {
  readonly campaigns: readonly Campaign[];
  readonly now: Date;
}) {
  const t = await getTranslations('outreach');
  const format = await getFormatter();
  const month = campaigns.filter((campaign) => {
    const at = new Date(campaign.startedAt ?? campaign.createdAt);
    return at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth();
  });
  const cells = [
    { key: 'reached', value: month.reduce((sum, c) => sum + c.sentCount, 0) },
    { key: 'campaigns', value: month.length },
    { key: 'didntArrive', value: month.reduce((sum, c) => sum + c.failedCount, 0) },
  ] as const;
  return (
    <section className={styles.listSection} data-testid="section-month">
      <h2 className={styles.listHeading}>{t('month.heading')}</h2>
      <dl className={styles.monthStrip}>
        {cells.map((cell) => (
          <div key={cell.key} className={styles.monthCell} data-testid={`month-${cell.key}`}>
            <dt>{t(`month.${cell.key}`)}</dt>
            <dd>{format.number(cell.value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
