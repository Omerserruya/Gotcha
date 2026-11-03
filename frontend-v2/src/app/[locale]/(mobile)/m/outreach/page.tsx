import { getTranslations } from 'next-intl/server';

import type { Campaign } from '@/api/contracts/outreach';
import { loadOutreach } from '@/features/outreach/load-outreach';
import {
  MobileCampaignChips,
  MobileCampaignList,
} from '@/features/mobile/outreach/MobileCampaigns';
import { groupOf, parseGroup } from '@/features/mobile/outreach/mobile-outreach';
import { MobileNewOutreach } from '@/features/mobile/outreach/MobileNewOutreach';
import ui from '@/features/mobile/mobile-ui.module.css';
import { OnWebsite } from '@/features/mobile/OnWebsite';
import { MobileBar } from '@/shell/mobile/MobileBar';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * The mobile outreach: the campaigns, to look at, and "New outreach" for
 * one person - a message in their conversation, or a phone call.
 *
 * ★ The desktop's loader (`loadOutreach`), so a campaign's status and
 *   numbers are the website's. Creating, sending and stopping a campaign
 *   stay there, behind the one link at the foot. The design's floating
 *   "New outreach" opens a sheet for one person (`MobileNewOutreach`,
 *   Omer 2026-11-03); a campaign from it is the website's too.
 *
 * ★ The chips filter by `?show=`, counted from the whole list (the route
 *   returns every campaign in one read). The design's figures card is not
 *   drawn: delivered and replied are never counted and revenue has no
 *   inputs, so its three numbers would be invented.
 *
 * ★ A failed read and no campaigns are opposite facts: one means nothing
 *   has gone out, the other that you do not know whether anything is going
 *   out right now. Each is its own sentence, as on the desktop.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly show?: string }>;
}) {
  const t = await getTranslations('mobile');
  const to = await getTranslations('outreach');
  const show = parseGroup((await searchParams).show);
  const { inFlight, finished, unavailable } = await loadOutreach();
  const website = (
    <p className={ui.foot}>
      <OnWebsite path="/outreach" label={t('outreach.website')} className={ui.footLink} />
    </p>
  );

  if (unavailable || inFlight === null || finished === null) {
    return (
      <div className={ui.screen} data-testid="mobile-outreach">
        <MobileBar title={t('outreach.title')} />
        <div className={ui.scroll}>
          <p className={ui.empty} role="status" data-testid="mobile-outreach-unavailable">
            {to('unavailable')}
          </p>
          {website}
        </div>
        <MobileNewOutreach />
      </div>
    );
  }

  const all = [...inFlight, ...finished];
  const shown = (list: readonly Campaign[]) =>
    show === null ? list : list.filter((c) => groupOf(c.status) === show);
  const now = new Date();
  const going = shown(inFlight);
  const earlier = shown(finished);

  return (
    <div className={ui.screen} data-testid="mobile-outreach">
      <MobileBar title={t('outreach.title')} />
      <div className={ui.scroll}>
        {all.length === 0 ? (
          <div className={ui.empty} data-testid="mobile-outreach-empty">
            <span className={ui.emptyTitle}>{to('none')}</span>
            <span>{to('noneBody')}</span>
          </div>
        ) : (
          <>
            <MobileCampaignChips campaigns={all} show={show} />
            {going.length > 0 ? (
              <section aria-labelledby="mobile-outreach-going">
                <h2 className={ui.section} id="mobile-outreach-going">
                  {t('outreach.going')}
                </h2>
                <MobileCampaignList campaigns={going} now={now} />
              </section>
            ) : null}
            {earlier.length > 0 ? (
              <section aria-labelledby="mobile-outreach-earlier">
                <h2 className={ui.section} id="mobile-outreach-earlier">
                  {t('outreach.earlier')}
                </h2>
                <MobileCampaignList campaigns={earlier} now={now} />
              </section>
            ) : null}
            {going.length === 0 && earlier.length === 0 ? (
              <p className={ui.empty} data-testid="mobile-outreach-none-here">
                {t('outreach.noneHere')}
              </p>
            ) : null}
          </>
        )}
        {website}
      </div>
      <MobileNewOutreach />
    </div>
  );
}

export const generateMetadata = pageMetadata('primary.outreach');
