import { getLocale, getTranslations } from 'next-intl/server';

import { loadApprovalCustomers } from '@/features/approvals/approval-customers';
import { handledToday } from '@/features/approvals/handled';
import { loadApprovals, requesterName } from '@/features/approvals/load-approvals';
import { ApprovalsLive } from '@/features/mobile/approvals/ApprovalsLive';
import { MobileApprovalList } from '@/features/mobile/approvals/MobileApprovalList';
import { MobileDecidedList } from '@/features/mobile/approvals/MobileDecidedList';
import { decidedOn, requestersOf } from '@/features/mobile/approvals/mobile-approvals';
import styles from '@/features/mobile/approvals/mobile-approvals.module.css';
import ui from '@/features/mobile/mobile-ui.module.css';
import { OnWebsite } from '@/features/mobile/OnWebsite';
import { Link } from '@/i18n/navigation';
import { appPath } from '@/lib/base-path';
import { MobileBar } from '@/shell/mobile/MobileBar';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * The mobile approvals: what is waiting on you, one card each, decided here -
 * and, one chip over, what was decided today.
 *
 * ★ THE DESKTOP'S LOADER, the same reads in the same order (`loadApprovals`,
 *   then `loadApprovalCustomers` for the names), so a request reads the same
 *   on the phone and on the website.
 *
 * ★ A failed read is said as one. An empty queue means nothing needs you; a
 *   failed read means you do not know - opposite facts, never one screen.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly view?: string }>;
}) {
  const { view } = await searchParams;
  const t = await getTranslations('mobile');
  const ta = await getTranslations('approvals');
  const locale = await getLocale();
  const data = await loadApprovals();
  const { pending, aiEmployees, readAt, viewerId } = data;

  const bar = <MobileBar title={t('approvals.title')} />;

  if (pending === null) {
    return (
      <div className={ui.screen} data-testid="mobile-approvals">
        {bar}
        <div className={styles.scroll}>
          <p className={styles.note} role="status" data-testid="mobile-approvals-unavailable">
            {ta('unavailable')}
          </p>
          <OnWebsite path="/approvals" label={t('approvals.website')} />
        </div>
      </div>
    );
  }

  const now = new Date(readAt);
  const today = data.decided === null ? null : decidedOn(data.decided, now);
  const showDecided = view === 'decided';

  const { names, aiAsked } = requestersOf(
    pending,
    (approval) => requesterName(approval, aiEmployees),
    (aiEmployees ?? []).map((ai) => ai.name),
  );
  const customers = showDecided ? {} : await loadApprovalCustomers(pending);
  const customerNames = Object.fromEntries(
    Object.entries(customers)
      .map(([id, customer]) => [id, customer.name] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== null),
  );
  // What ran without asking today, for the foot: `null` when it cannot be told.
  const handled = handledToday(data.usageToday, data.decided, now)?.total ?? null;

  return (
    <div className={ui.screen} data-testid="mobile-approvals">
      {/* Renders nothing: re-reads the queue when a request is written or decided. */}
      <ApprovalsLive />
      {bar}
      <div className={styles.scroll}>
        <p className={ui.lead} data-testid="mobile-approvals-count">
          {pending.length > 0
            ? t('approvals.lead', { count: pending.length })
            : t('approvals.leadNone')}
        </p>

        <nav className={ui.chips} aria-label={t('approvals.views')}>
          <Link
            href="/m/approvals"
            className={ui.chip}
            aria-current={showDecided ? undefined : 'page'}
            data-testid="mobile-approvals-chip-pending"
          >
            <span>{t('approvals.pending')}</span>
            <span className={ui.chipCount}>{pending.length}</span>
          </Link>
          <Link
            href={{ pathname: '/m/approvals', query: { view: 'decided' } }}
            className={ui.chip}
            aria-current={showDecided ? 'page' : undefined}
            data-testid="mobile-approvals-chip-decided"
          >
            <span>{t('approvals.decided')}</span>
            {today === null ? null : <span className={ui.chipCount}>{today.length}</span>}
          </Link>
        </nav>

        {showDecided ? (
          <MobileDecidedList decided={today} customerNames={data.customerNames} />
        ) : (
          <>
            <MobileApprovalList
              pending={pending}
              requesters={names}
              aiAsked={aiAsked}
              customerNames={customerNames}
              serverNow={readAt}
              viewerId={viewerId}
            />
            {/* The design's foot: what never reaches you, and where to change it. */}
            <p className={styles.foot} data-testid="mobile-approvals-foot">
              {data.refundLimit !== null ? (
                <span>
                  {ta('queueFoot.under', {
                    limit: new Intl.NumberFormat(locale).format(data.refundLimit),
                  })}{' '}
                </span>
              ) : null}
              {handled !== null && handled > 0 ? (
                <span>{ta('queueFoot.handled', { count: handled })} </span>
              ) : null}
              {/* The website: the native shell opens it in the browser (`OnWebsite`). */}
              <a href={appPath(`/${locale}/studio/capabilities`)} className={ui.footLink}>
                {ta('queueFoot.change')}
              </a>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export const generateMetadata = pageMetadata('primary.approvals');
