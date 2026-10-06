import { getTranslations } from 'next-intl/server';

import { channelName } from '@/api/contracts/inbox';
import { loadChannels } from '@/features/channels/load-channels';
import { displayHandle } from '@/features/customers/phone';
import type { SendingAccount } from '@/features/outreach/CampaignForm';
import { loadTemplates } from '@/features/outreach/load-templates';
import { wabaConnected } from '@/features/outreach/waba';
import { TemplateForm } from '@/features/outreach/TemplateForm';
import { Link } from '@/i18n/navigation';
import { Drawer } from '@/shell/Drawer';
import styles from '@/features/outreach/Outreach.module.css';
import {
  RejectedCard,
  selectedGroup,
  TemplatePreview,
  TemplateTable,
  templateGroups,
  WorthKnowing,
} from '@/features/outreach/TemplateList';
import { OutreachTabs } from '@/features/outreach/OutreachTabs';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';
import { ltr } from '@/lib/bidi';

/**
 * Screen 05c - message templates.
 *
 * Measured: the table card and a 440 column inside `padding:22px 40px 30px`,
 * `gap:14px`, each card filling the panel's height and scrolling inside
 * itself. `?template=` chooses the preview, and the URL keeps it.
 *
 * Every state draws the same frame: a failed read and an empty list each say
 * so in the table's body, and the column keeps its cards.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{
    readonly template?: string;
    /** 05c's "New template": the draft drawer. */
    readonly create?: string;
  }>;
}) {
  const t = await getTranslations('templates');
  const tch = await getTranslations('channels');
  const { template: wanted, create } = (await searchParams) ?? {};
  const creating = create === '1';
  const [{ templates }, channelData] = await Promise.all([
    loadTemplates(),
    creating ? loadChannels() : Promise.resolve(null),
  ]);
  const accounts: SendingAccount[] = (channelData?.channels ?? [])
    .filter((c) => c.connectionStatus === 'CONNECTED' && c.channel === 'WHATSAPP')
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
  const groups = templates === null ? null : templateGroups(templates);
  const selected = groups === null ? null : selectedGroup(groups, wanted);

  return (
    <PageContainer
      layout="screen"
      flush
      title={t('title')}
      description={t('description')}
      actions={
        <OutreachTabs current="templates">
          <Link
            href={{ pathname: '/outreach/templates', query: { create: '1' } }}
            className={styles.createButton}
            scroll={false}
            data-testid="new-template"
          >
            {t('newTemplate')}
          </Link>
        </OutreachTabs>
      }
    >
      <div className={styles.tplScreen} data-testid="templates-screen">
        <TemplateTable groups={groups} selectedId={selected?.primary.id ?? null} />
        <div className={styles.tplColumn}>
          <TemplatePreview group={selected} waba={await wabaConnected()} />
          {groups ? <RejectedCard groups={groups} /> : null}
          <WorthKnowing />
        </div>
      </div>
      {creating ? (
        <Drawer
          title={t('create.title')}
          line={t('create.line')}
          closeHref="/outreach/templates"
          width={560}
          testId="drawer-template"
        >
          <TemplateForm accounts={accounts} />
        </Drawer>
      ) : null}
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.outreach');
