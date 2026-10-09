import { getTranslations } from 'next-intl/server';

import { channelName } from '@/api/contracts/inbox';
import { loadChannels } from '@/features/channels/load-channels';
import { displayHandle } from '@/features/customers/phone';
import { CampaignCard } from '@/features/outreach/CampaignCard';
import { wabaConnected } from '@/features/outreach/waba';
import { CampaignForm, type SendingAccount } from '@/features/outreach/CampaignForm';
import { loadTemplates } from '@/features/outreach/load-templates';
import { TaskCards } from '@/features/outreach/TaskCards';
import { Link } from '@/i18n/navigation';
import { Drawer } from '@/shell/Drawer';
import { loadOutreach } from '@/features/outreach/load-outreach';
import { InFlightList, MonthStrip } from '@/features/outreach/OutreachLists';
import styles from '@/features/outreach/Outreach.module.css';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';
import { ltr } from '@/lib/bidi';

/**
 * Outreach - screens 05 and 05b.
 *
 * Both states on one route: a campaign that is sending and one that has
 * finished are the same object at different moments, and the design splits
 * them into two screens mostly to show the results layout. The card carries
 * the rates once there is something to rate.
 *
 * ── WHAT IS ABSENT, AND WHY ──
 * **No "Pause the rest".** There is no `PAUSED` status and no resume route.
 * `cancel` is terminal - it drains the queue, marks every pending recipient
 * `"skipped"` and sets `completedAt`. The control says **stop**, and its
 * confirmation names the two things that are lost.
 *
 * **No "converted", no "bought", no attributed revenue.** Conversion is not a
 * concept in this platform and revenue has no inputs - its third appearance
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
 * the workspace policy and **read by no send path** - so a tenant could set
 * it, see it saved, and have GOTCHA message their customers at 02:00. Drawing
 * the control would make a promise the product breaks on someone else's
 * behalf.
 *
 * Also absent: the per-campaign opt-out counter, the hourly reply chart and
 * the recommendation derived from it, the stock projection, and reply
 * categories. None has a field.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<{
    /** `?campaign=<id>` - which campaign the right-hand column shows. */
    readonly campaign?: string;
    /** `?create=campaign[&channel=EMAIL][&template=<id>]` - the draft drawer. */
    readonly create?: string;
    readonly channel?: string;
    readonly template?: string;
    /** 04: the people picked there, comma-separated. */
    readonly contacts?: string;
  }>;
}) {
  const t = await getTranslations('outreach');
  const tch = await getTranslations('channels');
  const params = await searchParams;
  const creating = params.create === 'campaign';
  const [{ inFlight, finished, unavailable }, channelData, templateData] = await Promise.all([
    loadOutreach(),
    loadChannels(),
    // The drawer's templates, only when it is open.
    creating ? loadTemplates() : Promise.resolve(null),
  ]);
  const wanted = params.campaign;

  /*
    05's "Create outreach" (Omer, 2026-10-04: drafts). The accounts a
    campaign can go from are the connected ones, named as 13 names them.
  */
  const accounts: SendingAccount[] = (channelData.channels ?? [])
    .filter((c) => c.connectionStatus === 'CONNECTED' && SENDABLE.has(c.channel))
    .map((c) => ({
      id: c.id,
      channel: c.channel,
      label: [
        channelName(c.channel, tch) ?? c.channel,
        c.displayName ?? (c.externalId ? ltr(displayHandle(c.channel, c.externalId)) : null),
      ]
        .filter(Boolean)
        .join(' · '),
    }));
  const emailAccount = accounts.find((a) => EMAIL_CHANNELS.has(a.channel));
  const createAction = (
    <Link
      href={{ pathname: '/outreach', query: { create: 'campaign' } }}
      className={styles.createButton}
      scroll={false}
      data-testid="create-outreach"
    >
      {t('createOutreach')}
    </Link>
  );
  const tasks = <TaskCards hasEmail={emailAccount !== undefined} />;
  const drawer = creating ? (
    <Drawer
      title={t('create.title')}
      line={t('create.line')}
      closeHref="/outreach"
      width={560}
      testId="drawer-campaign"
    >
      <CampaignForm
        accounts={accounts}
        templates={(templateData?.templates ?? [])
          .filter((tpl) => tpl.status === 'APPROVED')
          .map((tpl) => ({
            id: tpl.id,
            name: tpl.name,
            language: tpl.language,
            channelAccountId: tpl.channelAccountId,
          }))}
        initialTemplateId={params.template}
        initialChannel={params.channel === 'EMAIL' ? emailAccount?.channel : undefined}
        contactIds={contactsOf(params.contacts)}
      />
    </Drawer>
  ) : null;

  if (unavailable || inFlight === null || finished === null) {
    return (
      <PageContainer
        layout="screen"
        title={t('screenTitle')}
        description={t('description')}
        actions={createAction}
      >
        <p data-testid="outreach-unavailable">{t('unavailable')}</p>
        {drawer}
      </PageContainer>
    );
  }

  if (inFlight.length === 0 && finished.length === 0) {
    return (
      <PageContainer
        layout="screen"
        title={t('screenTitle')}
        description={t('description')}
        actions={createAction}
      >
        {tasks}
        <div className={styles.empty} data-testid="outreach-empty">
          <p className={styles.emptyLead}>{t('none')}</p>
          <p className={styles.emptyBody}>{t('noneBody')}</p>
        </div>
        {drawer}
      </PageContainer>
    );
  }

  /*
   * 05's list is one card: what is going out first, then what already went -
   * 02's own list ends on "Finished yesterday".
   */
  const campaigns = [...inFlight, ...finished];
  const selected = campaigns.find((campaign) => campaign.id === wanted) ?? campaigns[0]!;

  return (
    <PageContainer
      layout="screen"
      /* Two columns to the panel's edges, each scrolling inside itself. */
      flush
      title={t('screenTitle')}
      actions={createAction}
      /* 02's subline is a status sentence, counted from the campaigns. */
      description={t('statusLine', {
        running: inFlight.filter((campaign) => campaign.status === 'SENDING').length,
        scheduled: inFlight.filter((campaign) => campaign.status === 'SCHEDULED').length,
      })}
    >
      <div className={styles.screen} data-testid="outreach-screen">
        {/* 02's main column: the four task cards, the list, the month. */}
        <div className={styles.main}>
          {tasks}
          <InFlightList campaigns={campaigns} selectedId={selected.id} />
          <MonthStrip campaigns={campaigns} now={new Date()} />
        </div>
        <aside className={styles.side} aria-label={selected.name}>
          <CampaignCard
            campaign={selected}
            detailed
            waba={
              selected.status === 'DRAFT' && selected.channel === 'WHATSAPP'
                ? await wabaConnected()
                : null
            }
          />
        </aside>
      </div>
      {drawer}
    </PageContainer>
  );
}

/** The channels a campaign can go out on. */
const EMAIL_CHANNELS = new Set(['EMAIL', 'GMAIL', 'OUTLOOK']);
const SENDABLE = new Set(['WHATSAPP', ...EMAIL_CHANNELS]);

export const generateMetadata = pageMetadata('primary.outreach');

/** `?contacts=a,b,c` from 04's selection - ids only, at most 200. */
function contactsOf(raw: string | undefined): readonly string[] {
  return (raw ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id))
    .slice(0, 200);
}
