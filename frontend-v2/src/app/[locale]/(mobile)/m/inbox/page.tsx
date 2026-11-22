import { Lock } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { channelName } from '@/api/contracts/inbox';
import { inboxRelevanceOn } from '@/api/client/inbox-relevance';
import { ListLive } from '@/features/inbox/ListLive';
import { loadFilterChips } from '@/features/inbox/load-filter-chips';
import { loadInbox } from '@/features/inbox/load-inbox';
import {
  parseChannelFilters,
  parseInboxView,
  phoneCountView,
  phoneCountViews,
  phoneViewQuery,
  phoneViews,
  withRelevance,
  shownView,
  soloView,
} from '@/features/inbox/inbox-views';
import { MobileChannelFilter } from '@/features/mobile/inbox/MobileChannelFilter';
import { MobileConversationList } from '@/features/mobile/inbox/MobileConversationList';
import { searchQuery } from '@/features/mobile/inbox/inbox-search';
import { MobileInboxSearch } from '@/features/mobile/inbox/MobileInboxSearch';
import ui from '@/features/mobile/mobile-ui.module.css';
import { Link, redirect } from '@/i18n/navigation';
import { MobileBar } from '@/shell/mobile/MobileBar';
import { MobileViewCount } from '@/shell/mobile/MobileViewCount';
import { pageMetadata } from '@/shell/page-metadata';
import { RailUnreadCounts } from '@/shell/rail-counts';

/**
 * The mobile inbox (`GOTCHA Mobile App.dc.html`): the wordmark, the channel
 * filter, a search, the views as chips with their sizes, the conversations.
 *
 * ★ CHANNELS ARE SEVERAL HERE (`?channel=a,b`, `parseChannelFilters`), and
 *   "Assigned to me" leaves out what was resolved (`phoneViewQuery`). The
 *   website keeps one channel and its own "mine".
 *
 * ★ Nothing is opened here. `loadInbox` with no id opens nothing (Omer,
 *   2026-10-06), so this page pays for the list only; a tap goes to
 *   `/m/inbox/<id>`, which is its own screen.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly view?: string;
    readonly cursor?: string;
    readonly channel?: string;
    readonly q?: string;
  }>;
}) {
  const t = await getTranslations('mobile');
  const nav = await getTranslations('navigation');
  const channelNames = await getTranslations('channels');
  const { view: rawView, cursor, channel: rawChannel, q: rawQ } = await searchParams;
  const relevance = inboxRelevanceOn();
  const askedView = parseInboxView(rawView, relevance);
  const explicit = rawView === askedView;
  const channels = parseChannelFilters(rawChannel);
  const channelParam = channels.join(',');
  const q = searchQuery(rawQ ?? '');
  const [data, chips] = await Promise.all([
    loadInbox(
      undefined,
      cursor,
      askedView,
      channels,
      null,
      explicit,
      q === '' ? null : q,
      withRelevance(phoneViewQuery, relevance),
    ),
    loadFilterChips(channels),
  ]);
  /*
   * One person: a named queue, "mine" or "active" is "Open", as on the
   * website - the address says so, and the chip lit is the list shown.
   */
  const solo = explicit ? soloView(askedView, data.soleHuman) : null;
  if (solo !== null) {
    redirect({
      href: {
        pathname: '/m/inbox',
        query: {
          view: solo,
          ...(channelParam === '' ? {} : { channel: channelParam }),
          ...(q === '' ? {} : { q }),
        },
      },
      locale: await getLocale(),
    });
  }
  const view = shownView(askedView, explicit, data.meId !== null, data.soleHuman);
  const now = new Date();

  const keepFilter = { view, ...(q === '' ? {} : { q }) };
  const keepSearch = { view, ...(channelParam === '' ? {} : { channel: channelParam }) };
  const keepView = {
    ...(channelParam === '' ? {} : { channel: channelParam }),
    ...(q === '' ? {} : { q }),
  };
  const names = Object.fromEntries(
    chips.map((chip) => [chip.channel, channelName(chip.channel, channelNames) ?? chip.channel]),
  );

  return (
    <div className={ui.screen} data-testid="mobile-inbox">
      {/* Renders nothing: re-reads this page when a message arrives or a conversation changes. */}
      <ListLive openId={null} />
      {/* Renders nothing: each view's size, for the chips, kept current by the platform's events. */}
      <RailUnreadCounts
        views={phoneCountViews(data.soleHuman, relevance)}
        hideIrrelevant={relevance}
      />
      <MobileBar
        brand
        actions={
          <MobileChannelFilter chips={chips} current={channels} names={names} keep={keepFilter} />
        }
      />
      <div className={ui.scroll}>
        <MobileInboxSearch value={q} keep={keepSearch} placeholder={t('inbox.search')} />
        <nav className={ui.chips} aria-label={t('inbox.views')}>
          {phoneViews(data.soleHuman, relevance).map((id) => (
            <Link
              key={id}
              href={{ pathname: '/m/inbox', query: { ...keepView, view: id } }}
              className={ui.chip}
              aria-current={id === view ? 'page' : undefined}
              replace
              data-testid={`mobile-view-${id}`}
            >
              <span>{id === 'all' ? t('inbox.all') : nav(`inbox.${id}`)}</span>
              {id === 'all' ? null : (
                <MobileViewCount view={phoneCountView(id)} className={ui.chipCount} />
              )}
            </Link>
          ))}
        </nav>
        <MobileConversationList
          rows={data.rows}
          now={now}
          meId={data.meId}
          colleagues={data.colleagues}
          filtered={channels.length > 0 || q !== ''}
          soleHuman={data.soleHuman}
          relevance={relevance}
          role={data.role}
        />
        {data.hasMore && data.nextCursor !== null ? (
          <Link
            href={{ pathname: '/m/inbox', query: { ...keepView, view, cursor: data.nextCursor } }}
            className={ui.more}
          >
            {t('inbox.more')}
          </Link>
        ) : null}
        <p className={ui.foot}>
          <Lock aria-hidden size={12} strokeWidth={2} />
          <span>{t('inbox.grounded')}</span>
        </p>
      </div>
    </div>
  );
}

export const generateMetadata = pageMetadata('primary.inbox');
