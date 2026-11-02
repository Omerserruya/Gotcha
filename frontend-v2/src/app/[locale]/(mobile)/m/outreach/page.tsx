import { getTranslations } from 'next-intl/server';

import { loadOutreach } from '@/features/outreach/load-outreach';
import { MobileCampaignList } from '@/features/mobile/outreach/MobileCampaigns';
import styles from '@/features/mobile/outreach/mobile-outreach.module.css';
import { OnWebsite } from '@/features/mobile/OnWebsite';
import { MobileBar } from '@/shell/mobile/MobileBar';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * The mobile outreach: the campaigns, to look at - VIEW ONLY.
 *
 * ★ The desktop's loader (`loadOutreach`), so a campaign's status and
 *   numbers are the website's. Creating, sending and stopping stay there,
 *   behind the one link at the foot.
 *
 * ★ A failed read and no campaigns are opposite facts: one means nothing
 *   has gone out, the other that you do not know whether anything is going
 *   out right now. Each is its own sentence, as on the desktop.
 */
export default async function Page() {
  const t = await getTranslations('mobile');
  const to = await getTranslations('outreach');
  const { inFlight, finished, unavailable } = await loadOutreach();
  const website = <OnWebsite path="/outreach" label={t('outreach.website')} />;

  return (
    <div className={styles.screen} data-testid="mobile-outreach">
      <MobileBar title={t('outreach.title')} />
      <div className={styles.scroll}>
        {unavailable || inFlight === null || finished === null ? (
          <p className={styles.note} role="status" data-testid="mobile-outreach-unavailable">
            {to('unavailable')}
          </p>
        ) : inFlight.length === 0 && finished.length === 0 ? (
          <div data-testid="mobile-outreach-empty">
            <p className={styles.note}>{to('none')}</p>
            <p className={styles.noteBody}>{to('noneBody')}</p>
          </div>
        ) : (
          <>
            <p className={styles.lead}>
              {to('statusLine', {
                running: inFlight.filter((c) => c.status === 'SENDING').length,
                scheduled: inFlight.filter((c) => c.status === 'SCHEDULED').length,
              })}
            </p>
            <MobileCampaignList campaigns={[...inFlight, ...finished]} now={new Date()} />
          </>
        )}
        {website}
      </div>
    </div>
  );
}

export const generateMetadata = pageMetadata('primary.outreach');
