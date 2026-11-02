import { Lock } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { channelName } from '@/api/contracts/inbox';
import { ListLive } from '@/features/inbox/ListLive';
import { loadFilterChips } from '@/features/inbox/load-filter-chips';
import { loadInbox } from '@/features/inbox/load-inbox';
import {
  type InboxView,
  parseChannelFilter,
  parseInboxView,
  shownView,
} from '@/features/inbox/inbox-views';
import { MobileChannelFilter } from '@/features/mobile/inbox/MobileChannelFilter';
import { MobileConversationList } from '@/features/mobile/inbox/MobileConversationList';
import { MobileInboxSearch } from '@/features/mobile/inbox/MobileInboxSearch';
import ui from '@/features/mobile/mobile-ui.module.css';
import { Link } from '@/i18n/navigation';
import { MobileBar } from '@/shell/mobile/MobileBar';
import { MobileViewCount } from '@/shell/mobile/MobileViewCount';
import { pageMetadata } from '@/shell/page-metadata';
import { RailUnreadCounts } from '@/shell/rail-counts';

/*
 * The design's chips, in its order: All, then the desktop rail's views with
 * the rail's own ids and `?view=`, so a view means here what it means on the
 * website.
 */
const MOBILE_VIEWS: readonly InboxView[] = ['all', 'queue', 'mine', 'active', 'gotcha', 'resolved'];

/** Longest search sent: a name or a phone number, not a paragraph. */
const SEARCH_MAX = 80;

/**
 * The mobile inbox (`GOTCHA Mobile App.dc.html`): the wordmark, the channel
 * filter, a search, the views as chips with their sizes, the conversations.
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
  const askedView = parseInboxView(rawView);
  const explicit = rawView === askedView;
  const channel = parseChannelFilter(rawChannel);
  const q = (rawQ ?? '').trim().slice(0, SEARCH_MAX);
  const [data, chips] = await Promise.all([
    loadInbox(undefined, cursor, askedView, channel, null, explicit, q === '' ? null : q),
    loadFilterChips(channel),
  ]);
  const view = shownView(askedView, explicit, data.meId !== null);
  const now = new Date();

  const keepFilter = { view, ...(q === '' ? {} : { q }) };
  const keepSearch = { view, ...(channel === null ? {} : { channel }) };
  const keepView = { ...(channel === null ? {} : { channel }), ...(q === '' ? {} : { q }) };
  const names = Object.fromEntries(
    chips.map((chip) => [chip.channel, channelName(chip.channel, channelNames) ?? chip.channel]),
  );

  return (
    <div className={ui.screen} data-testid="mobile-inbox">
      {/* Renders nothing: re-reads this page when a message arrives or a conversation changes. */}
      <ListLive openId={null} />
      {/* Renders nothing: each view's size, for the chips, kept current by the platform's events. */}
      <RailUnreadCounts views={MOBILE_VIEWS} />
      <MobileBar
        brand
        actions={<MobileChannelFilter chips={chips} current={channel} names={names} keep={keepFilter} />}
      />
      <div className={ui.scroll}>
        <MobileInboxSearch value={q} keep={keepSearch} placeholder={t('inbox.search')} />
        <nav className={ui.chips} aria-label={t('inbox.views')}>
          {MOBILE_VIEWS.map((id) => (
            <Link
              key={id}
              href={{ pathname: '/m/inbox', query: { ...keepView, view: id } }}
              className={ui.chip}
              aria-current={id === view ? 'page' : undefined}
              replace
              data-testid={`mobile-view-${id}`}
            >
              <span>{id === 'all' ? t('inbox.all') : nav(`inbox.${id}`)}</span>
              {id === 'all' ? null : <MobileViewCount view={id} className={ui.chipCount} />}
            </Link>
          ))}
        </nav>
        <MobileConversationList
          rows={data.rows}
          now={now}
          meId={data.meId}
          colleagues={data.colleagues}
          filtered={channel !== null || q !== ''}
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
