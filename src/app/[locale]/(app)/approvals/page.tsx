import { getTranslations } from 'next-intl/server';

import { ApprovalsScreen } from '@/features/approvals/ApprovalsScreen';
import { loadApprovals, requesterName } from '@/features/approvals/load-approvals';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Approvals — screen 03.
 *
 * *"Understand a request and decide in seconds. The cleanest screen in the
 * product, and the one that should shrink itself over time."*
 *
 * ── WHAT IS ABSENT, AND WHY ──
 * **"Reversible · Yes — within 24h"** is gone, not softened. There is no undo
 * anywhere in this platform — no route, no gateway path, no `undoneAt` or
 * `reversalOf` field, enumerated across the repository. That sentence is read
 * **before** the irreversible act, and it would make someone approve a refund
 * they would otherwise have questioned.
 *
 * **Edit amount / `E`** is gone. `TenantToolPermission.allowModification`
 * governs it, defaults to false, and is read by nobody — so building it would
 * make an unenforced permission routinely exercised rather than theoretical.
 *
 * **The customer card** is not drawn yet. Three of its five fields — tenure,
 * lifetime value, prior refunds — have had no premise check, and drawing them
 * on an assumption is how a plan key reached the billing screen.
 *
 * The requester is resolved to a name here rather than in the browser:
 * `requestedBy` is `ai-agent:<cuid>` for every AI employee and the list route
 * refuses to resolve it, so the raw id would otherwise reach the page.
 */
export default async function Page() {
  const t = await getTranslations('approvals');
  const { pending, aiEmployees, readAt } = await loadApprovals();

  // A failed read and an empty queue are opposite facts here: one means
  // nothing needs you, the other means you do not know whether anything does.
  if (pending === null) {
    return (
      <PageContainer title={t('title')} description={t('description')}>
        <p data-testid="approvals-unavailable">{t('unavailable')}</p>
      </PageContainer>
    );
  }

  if (pending.length === 0) {
    return (
      <PageContainer title={t('title')} description={t('description')}>
        <p data-testid="approvals-empty">{t('empty')}</p>
      </PageContainer>
    );
  }

  const requesterNames = Object.fromEntries(
    pending
      .map((approval) => [approval.id, requesterName(approval, aiEmployees)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== null),
  );

  return (
    <PageContainer title={t('title')} description={t('description')}>
      {/*
        The legend lists exactly the keys the screen honours — no `E`, because
        editing is not built, and `A` only focuses Approve. A legend that
        advertises a key that does nothing is the same defect as offering an
        event that nothing raises.
      */}
      <p data-testid="approvals-keys">{t('keys')}</p>

      <ApprovalsScreen
        pending={pending}
        requesterNames={requesterNames}
        // The moment the queue was read, not the moment this rendered —
        // and it starts the client's clock at exactly the server's value, so
        // the first client render cannot disagree about what has lapsed.
        serverNow={readAt}
      />
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.approvals');
