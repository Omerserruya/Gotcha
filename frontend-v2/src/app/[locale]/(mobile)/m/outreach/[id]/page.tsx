import { getTranslations } from 'next-intl/server';

import { loadCampaign } from '@/features/outreach/load-outreach';
import { MobileCampaignSummary } from '@/features/mobile/outreach/MobileCampaigns';
import styles from '@/features/mobile/outreach/mobile-outreach.module.css';
import { OnWebsite } from '@/features/mobile/OnWebsite';
import { MobileBar } from '@/shell/mobile/MobileBar';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * One campaign on the phone: what it is and what reached people.
 *
 * ★ `loadCampaign`, the desktop's, with its three answers: the campaign;
 *   `missing` (no such campaign here - a fact); `failed` (we could not read
 *   it - ours). Never one sentence for two of them.
 */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations('mobile');
  const to = await getTranslations('outreach');
  const read = await loadCampaign(id);
  const back = { href: '/m/outreach', label: t('outreach.back') } as const;

  if (read.state !== 'ok') {
    return (
      <div className={styles.screen}>
        <MobileBar back={back} title={t('outreach.title')} />
        <div className={styles.scroll}>
          <p className={styles.note} role="status" data-testid={`mobile-campaign-${read.state}`}>
            {read.state === 'missing' ? to('results.missing') : to('results.unavailable')}
          </p>
          <OnWebsite path="/outreach" label={t('outreach.website')} />
        </div>
      </div>
    );
  }

  const { campaign } = read;
  return (
    <div className={styles.screen} data-testid="mobile-campaign">
      <MobileBar back={back} title={t('outreach.title')} />
      <div className={styles.scroll}>
        <MobileCampaignSummary campaign={campaign} now={new Date()} />
        <OnWebsite
          path={`/outreach?campaign=${encodeURIComponent(campaign.id)}`}
          label={t('outreach.websiteOne')}
        />
      </div>
    </div>
  );
}

export const generateMetadata = pageMetadata('primary.outreach');
