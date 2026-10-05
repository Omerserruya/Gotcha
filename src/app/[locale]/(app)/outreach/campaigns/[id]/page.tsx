import { getTranslations } from 'next-intl/server';

import {
  BroughtIn,
  RepliesByHour,
  ResultStrip,
  resultsLine,
  SaidNothing,
  WroteBack,
} from '@/features/outreach/CampaignResults';
import { loadCampaign } from '@/features/outreach/load-outreach';
import styles from '@/features/outreach/Outreach.module.css';
import { Link } from '@/i18n/navigation';
import { isInFlight } from '@/api/contracts/outreach';
import { OutreachTabs } from '@/features/outreach/OutreachTabs';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Screen 05b — a campaign after it went out: what it did, and the next move.
 *
 * Its own route rather than a state of 05, because it is a page you return
 * to ("not a report you read once") and its URL is the campaign's. 05's card
 * for a finished campaign links here.
 */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const t = await getTranslations('outreach');
  const { id } = await params;
  const read = await loadCampaign(id);
  const back = (
    <Link href="/outreach" className={styles.resBack} data-testid="results-back">
      {t('results.back')}
    </Link>
  );

  if (read.state !== 'ok') {
    return (
      <PageContainer layout="screen" title={t('screenTitle')} actions={back}>
        <p data-testid={`results-${read.state}`}>
          {read.state === 'missing' ? t('results.missing') : t('results.unavailable')}
        </p>
      </PageContainer>
    );
  }

  const { campaign } = read;
  return (
    <PageContainer
      layout="screen"
      flush
      title={campaign.name}
      description={await resultsLine(campaign, new Date())}
      // 05b: the pills, "Finished" open once it went out; "In flight" is the way back.
      actions={<OutreachTabs current={isInFlight(campaign) ? 'inFlight' : 'finished'} />}
    >
      <div className={styles.resScreen} data-testid="results-screen">
        <div className={styles.resTop}>
          <BroughtIn campaign={campaign} />
          <SaidNothing />
        </div>
        <ResultStrip campaign={campaign} />
        <div className={styles.resBottom}>
          <RepliesByHour campaign={campaign} />
          <WroteBack />
        </div>
      </div>
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.outreach');
