import { getTranslations } from 'next-intl/server';

import { loadCampaign } from '@/features/outreach/load-outreach';
import { MobileCampaignSummary } from '@/features/mobile/outreach/MobileCampaigns';
import styles from '@/features/mobile/outreach/mobile-outreach.module.css';
import ui from '@/features/mobile/mobile-ui.module.css';
import { OnWebsite } from '@/features/mobile/OnWebsite';
import { MobileBar } from '@/shell/mobile/MobileBar';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * One campaign on the phone: the design's campaign sheet, as its own screen.
 *
 * ★ A PAGE, NOT A SHEET OVER THE LIST, so `/m/outreach/<id>` - the link a
 *   push notification carries - opens straight onto the campaign.
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
      <div className={ui.screen}>
        <MobileBar back={back} title={t('outreach.title')} />
        <div className={ui.scroll}>
          <p className={ui.empty} role="status" data-testid={`mobile-campaign-${read.state}`}>
            {read.state === 'missing' ? to('results.missing') : to('results.unavailable')}
          </p>
          <p className={ui.foot}>
            <OnWebsite path="/outreach" label={t('outreach.website')} className={ui.footLink} />
          </p>
        </div>
      </div>
    );
  }

  const { campaign } = read;
  return (
    <div className={ui.screen} data-testid="mobile-campaign">
      <MobileBar back={back} title={t('outreach.title')} />
      <div className={ui.scroll}>
        <div className={styles.sheet}>
          <MobileCampaignSummary campaign={campaign} now={new Date()} />
          <OnWebsite
            path={`/outreach?campaign=${encodeURIComponent(campaign.id)}`}
            label={t('outreach.websiteOne')}
            className={styles.cta}
          />
        </div>
      </div>
    </div>
  );
}

export const generateMetadata = pageMetadata('primary.outreach');
