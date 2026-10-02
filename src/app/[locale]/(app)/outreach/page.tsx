import { getTranslations } from 'next-intl/server';

import { CampaignCard } from '@/features/outreach/CampaignCard';
import { loadOutreach } from '@/features/outreach/load-outreach';
import styles from '@/features/outreach/Outreach.module.css';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Outreach — screens 05 and 05b.
 *
 * Both states on one route: a campaign that is sending and one that has
 * finished are the same object at different moments, and the design splits
 * them into two screens mostly to show the results layout. The card carries
 * the rates once there is something to rate.
 *
 * ── WHAT IS ABSENT, AND WHY ──
 * **No "Pause the rest".** There is no `PAUSED` status and no resume route.
 * `cancel` is terminal — it drains the queue, marks every pending recipient
 * `"skipped"` and sets `completedAt`. The control says **stop**, and its
 * confirmation names the two things that are lost.
 *
 * **No "converted", no "bought", no attributed revenue.** Conversion is not a
 * concept in this platform and revenue has no inputs — its third appearance
 * across three screens.
 *
 * **No approval state.** `Broadcast` has no approval field, and
 * `ApprovalRequest` cannot carry it: its own schema comment says it is
 * exclusively the bot path.
 *
 * **No channel fallback.** One `channel`, one `channelAccountId`. So
 * *"WhatsApp, falls back to email after 24h"* is unbacked in both places the
 * design states it.
 *
 * **No quiet-hours control.** `outboundQuietHours` is validated and stored in
 * the workspace policy and **read by no send path** — so a tenant could set
 * it, see it saved, and have GOTCHA message their customers at 02:00. Drawing
 * the control would make a promise the product breaks on someone else's
 * behalf.
 *
 * Also absent: the per-campaign opt-out counter, the hourly reply chart and
 * the recommendation derived from it, the stock projection, and reply
 * categories. None has a field.
 */
export default async function Page() {
  const t = await getTranslations('outreach');
  const { inFlight, finished, unavailable } = await loadOutreach();

  if (unavailable || inFlight === null || finished === null) {
    return (
      <PageContainer layout="screen" title={t('title')} description={t('description')}>
        <p data-testid="outreach-unavailable">{t('unavailable')}</p>
      </PageContainer>
    );
  }

  if (inFlight.length === 0 && finished.length === 0) {
    // Nothing has ever been sent. A real state, and the one this tenant is in.
    return (
      <PageContainer layout="screen" title={t('title')} description={t('description')}>
        <div className={styles.empty} data-testid="outreach-empty">
          <p className={styles.emptyLead}>{t('none')}</p>
          <p className={styles.emptyBody}>{t('noneBody')}</p>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer layout="screen" title={t('title')} description={t('description')}>
      <div className={styles.screen} data-testid="outreach-screen">
        {inFlight.length > 0 ? (
          <section className={styles.section} data-testid="section-in-flight">
            <h2 className={styles.sectionHeading}>{t('heading.inFlight')}</h2>
            <div className={styles.cards}>
              {inFlight.map((campaign) => (
                // Not detailed: a campaign still sending has rates that move
                // under the reader, and a percentage of a partial send invites
                // a conclusion the finished number will not support.
                <CampaignCard key={campaign.id} campaign={campaign} detailed={false} />
              ))}
            </div>
          </section>
        ) : null}

        {finished.length > 0 ? (
          <section className={styles.section} data-testid="section-finished">
            <h2 className={styles.sectionHeading}>{t('heading.finished')}</h2>
            <div className={styles.cards}>
              {finished.map((campaign) => (
                <CampaignCard key={campaign.id} campaign={campaign} detailed />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.outreach');
