import { getLocale, getTranslations } from 'next-intl/server';

import { loadApprovalCustomers } from '@/features/approvals/approval-customers';
import { loadApprovals, requesterName } from '@/features/approvals/load-approvals';
import { editTarget, reversibilityOf } from '@/features/approvals/request-words';
import { MobileApprovalDetail } from '@/features/mobile/approvals/MobileApprovalDetail';
import { requestersOf } from '@/features/mobile/approvals/mobile-approvals';
import styles from '@/features/mobile/approvals/mobile-approvals.module.css';
import ui from '@/features/mobile/mobile-ui.module.css';
import { OnWebsite } from '@/features/mobile/OnWebsite';
import { appPath } from '@/lib/base-path';
import { MobileBar } from '@/shell/mobile/MobileBar';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * One waiting request on the phone, full screen, decided at the bottom.
 *
 * ★ READ AS THE LIST READS IT (`loadApprovals`): the route has no single-row
 *   read, so the request is found in the queue. Not waiting any more - decided
 *   by someone, or lapsed and swept - is said as that, never as an error.
 *
 * The bar's end says whether it can be put back (`reversibilityOf`), and
 * nothing where that is not known. There is no Undo; this is not one.
 */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations('mobile');
  const ta = await getTranslations('approvals');
  const locale = await getLocale();
  const { pending, aiEmployees, readAt, viewerId } = await loadApprovals();
  const back = { href: '/m/approvals', label: t('approvals.back') } as const;

  const approval = pending?.find((row) => row.id === id) ?? null;
  if (approval === null) {
    return (
      <div className={ui.screen} data-testid="mobile-approval-missing">
        <MobileBar back={back} />
        <div className={styles.scroll}>
          <p className={styles.note} role="status">
            {pending === null ? ta('unavailable') : t('approvals.gone')}
          </p>
          <OnWebsite path="/approvals" label={t('approvals.website')} />
        </div>
      </div>
    );
  }

  const { names, aiAsked } = requestersOf(
    [approval],
    (row) => requesterName(row, aiEmployees),
    (aiEmployees ?? []).map((ai) => ai.name),
  );
  const customer = (await loadApprovalCustomers([approval]))[approval.id] ?? null;
  const reversible = reversibilityOf(approval.tool);
  // Editing an amount is the website's: offered only where there is one to edit.
  const editHref =
    editTarget(approval)?.original != null
      ? appPath(`/${locale}/approvals?id=${encodeURIComponent(approval.id)}`)
      : null;

  return (
    <div className={ui.screen} data-testid="mobile-approval">
      <MobileBar
        back={back}
        actions={
          reversible ? (
            <span
              className={styles.reversible}
              data-reversible={reversible}
              data-testid="mobile-reversible"
            >
              {ta('detail3.reversible')}:{' '}
              {reversible === 'yes' ? ta('detail3.reversibleYes') : ta('detail3.reversibleNo')}
            </span>
          ) : null
        }
      />
      <MobileApprovalDetail
        approval={approval}
        customer={customer}
        requesters={names}
        aiAsked={aiAsked}
        viewerId={viewerId}
        serverNow={readAt}
        editHref={editHref}
      />
    </div>
  );
}

export const generateMetadata = pageMetadata('primary.approvals');
