import { getTranslations } from 'next-intl/server';

import { loadApprovalCustomers } from '@/features/approvals/approval-customers';
import { loadApprovals, requesterName } from '@/features/approvals/load-approvals';
import { MobileApprovalList } from '@/features/mobile/approvals/MobileApprovalList';
import { requestersOf } from '@/features/mobile/approvals/mobile-approvals';
import styles from '@/features/mobile/approvals/mobile-approvals.module.css';
import { OnWebsite } from '@/features/mobile/OnWebsite';
import { MobileBar } from '@/shell/mobile/MobileBar';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * The mobile approvals: what is waiting on you, one card each, decided here.
 *
 * ★ THE DESKTOP'S LOADER, the same reads in the same order (`loadApprovals`,
 *   then `loadApprovalCustomers` for the names), so a request reads the same
 *   on the phone and on the website. Pending only: the history, the figures
 *   and the editing stay on the website, one link away.
 *
 * ★ A failed read is said as one. An empty queue means nothing needs you; a
 *   failed read means you do not know - opposite facts, never one screen.
 */
export default async function Page() {
  const t = await getTranslations('mobile');
  const ta = await getTranslations('approvals');
  const { pending, aiEmployees, readAt, viewerId } = await loadApprovals();

  const bar = <MobileBar title={t('approvals.title')} />;
  const website = <OnWebsite path="/approvals" label={t('approvals.website')} />;

  if (pending === null) {
    return (
      <div className={styles.screen} data-testid="mobile-approvals">
        {bar}
        <div className={styles.scroll}>
          <p className={styles.note} role="status" data-testid="mobile-approvals-unavailable">
            {ta('unavailable')}
          </p>
          {website}
        </div>
      </div>
    );
  }

  const { names, aiAsked } = requestersOf(
    pending,
    (approval) => requesterName(approval, aiEmployees),
    (aiEmployees ?? []).map((ai) => ai.name),
  );
  const customers = await loadApprovalCustomers(pending);
  const customerNames = Object.fromEntries(
    Object.entries(customers)
      .map(([id, customer]) => [id, customer.name] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== null),
  );

  return (
    <div className={styles.screen} data-testid="mobile-approvals">
      {bar}
      <div className={styles.scroll}>
        {pending.length > 0 ? (
          <p className={styles.lead} data-testid="mobile-approvals-count">
            {ta('queue.waiting', { count: pending.length })}
          </p>
        ) : null}
        <MobileApprovalList
          pending={pending}
          requesters={names}
          aiAsked={aiAsked}
          customerNames={customerNames}
          serverNow={readAt}
          viewerId={viewerId}
        />
        {website}
      </div>
    </div>
  );
}

export const generateMetadata = pageMetadata('primary.approvals');
