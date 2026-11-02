import { getTranslations } from 'next-intl/server';

import { ListLive } from '@/features/inbox/ListLive';
import { loadInbox } from '@/features/inbox/load-inbox';
import { type InboxView, parseInboxView, shownView } from '@/features/inbox/inbox-views';
import { MobileConversationList } from '@/features/mobile/inbox/MobileConversationList';
import styles from '@/features/mobile/inbox/mobile-inbox.module.css';
import { Link } from '@/i18n/navigation';
import { MobileBar } from '@/shell/mobile/MobileBar';
import { pageMetadata } from '@/shell/page-metadata';

/*
 * The desktop rail's views, minus "All": on a phone the question is what needs
 * me, and "All" is a report. Same ids, same `?view=`, same loader, so a view
 * means here what it means on the website.
 */
const MOBILE_VIEWS: readonly InboxView[] = ['mine', 'queue', 'active', 'gotcha', 'resolved'];

/**
 * The mobile inbox: the conversations as a WhatsApp chat list.
 *
 * ★ Nothing is opened here. `loadInbox` with no id opens nothing (Omer,
 *   2026-10-06), so this page pays for the list only; a tap goes to
 *   `/m/inbox/<id>`, which is its own screen, as on WhatsApp.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly view?: string; readonly cursor?: string }>;
}) {
  const t = await getTranslations('mobile');
  const nav = await getTranslations('navigation');
  const { view: rawView, cursor } = await searchParams;
  const askedView = parseInboxView(rawView);
  const explicit = rawView === askedView;
  const data = await loadInbox(undefined, cursor, askedView, null, null, explicit);
  const view = shownView(askedView, explicit, data.meId !== null);
  const now = new Date();

  return (
    <div className={styles.screen} data-testid="mobile-inbox">
      {/* Renders nothing: re-reads this page when a message arrives or a conversation changes. */}
      <ListLive openId={null} />
      <MobileBar title={t('inbox.title')}>
        <nav className={styles.chips} aria-label={t('inbox.views')}>
          {MOBILE_VIEWS.map((id) => (
            <Link
              key={id}
              href={{ pathname: '/m/inbox', query: { view: id } }}
              className={styles.chip}
              aria-current={id === view ? 'page' : undefined}
              replace
              data-testid={`mobile-view-${id}`}
            >
              {nav(`inbox.${id}`)}
            </Link>
          ))}
        </nav>
      </MobileBar>
      <div className={styles.scroll}>
        <MobileConversationList rows={data.rows} now={now} />
        {data.hasMore && data.nextCursor !== null ? (
          <Link
            href={{ pathname: '/m/inbox', query: { view, cursor: data.nextCursor } }}
            className={styles.more}
          >
            {t('inbox.more')}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export const generateMetadata = pageMetadata('primary.inbox');
