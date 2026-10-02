import { getTranslations } from 'next-intl/server';

import type { Approval } from '@/api/contracts/approvals';
import { ApprovalsScreen } from '@/features/approvals/ApprovalsScreen';
import { DecisionStats, NothingWaiting } from '@/features/approvals/NothingWaiting';
import { decisionStats, loadApprovals, requesterName } from '@/features/approvals/load-approvals';
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
 * **The customer card is not built, and this is settled rather than pending.**
 * The premise check came back against it on cost and on truthfulness:
 *
 *   - `customer-commerce-facts.service.ts` has **one consumer**, inside
 *     `services/ai`, and **no route exposes it**. Approvals live in
 *     `services/conversation`, so this is a new endpoint plus a cross-service
 *     hop, not a join anyone can ask for.
 *   - the facts resolve to `shopify.get_customer` + `shopify.get_customer_orders`
 *     — **two live vendor calls per customer, uncached**. A queue of twenty is
 *     forty Shopify round trips, so the card can never live in the list.
 *   - **"Previous refunds: None" must not ship at all.** Refunds exist only
 *     per order, and three states collapse into that one word: we asked and
 *     there were none; we could not ask; we did not ask. On an approval about
 *     a refund that is the fact most likely to swing the decision, and the
 *     failure mode renders identically to the reassuring answer.
 *   - **tenure** is the store relationship (`firstSeenOrderAt`), not
 *     `Contact.createdAt` — which is when *we* first saw them in a
 *     conversation, and reads a year late for a long-standing customer.
 *   - **sentiment** is per-conversation, absent for 90% of this tenant's
 *     conversations and 48+ days old where present, and structurally absent
 *     for Copilot approvals.
 *
 * So the card is a costed decision for Omer, not a gap to close quietly.
 *
 * The requester is resolved to a name here rather than in the browser:
 * `requestedBy` is `ai-agent:<cuid>` for every AI employee and the list route
 * refuses to resolve it, so the raw id would otherwise reach the page.
 */
export default async function Page() {
  const t = await getTranslations('approvals');
  const { pending, decided, decidedMayBeIncomplete, aiEmployees, readAt } = await loadApprovals();

  const nameFor = (list: readonly Approval[] | null) =>
    Object.fromEntries(
      (list ?? [])
        .map((approval) => [approval.id, requesterName(approval, aiEmployees)] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] !== null),
    );

  // A failed read and an empty queue are opposite facts here: one means
  // nothing needs you, the other means you do not know whether anything does.
  if (pending === null) {
    return (
      <PageContainer layout="screen" title={t('title')} description={t('description')}>
        <p data-testid="approvals-unavailable">{t('unavailable')}</p>
      </PageContainer>
    );
  }

  /*
   * Screen 03c. An empty queue is the delegation WORKING, so this is a
   * first-class state rather than a blank — and it is where the record of
   * what you already decided lives.
   */
  if (pending.length === 0) {
    return (
      /*
        ★ 03c's title is the STATE, not the page's name — "Nothing waiting on
          you" — with 02's figures on the right.
      */
      <PageContainer
        layout="screen"
        title={t('rest.title')}
        description={t('rest.lead')}
        actions={<DecisionStats stats={decisionStats(decided, decidedMayBeIncomplete)} />}
      >
        <NothingWaiting
          decided={decided}
          mayBeIncomplete={decidedMayBeIncomplete}
          requesterNames={nameFor(decided)}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer layout="screen" title={t('title')} description={t('description')}>
      {/*
        The legend lists exactly the keys the screen honours — no `E`, because
        editing is not built, and `A` only focuses Approve. A legend that
        advertises a key that does nothing is the same defect as offering an
        event that nothing raises.
      */}
      <p data-testid="approvals-keys">{t('keys')}</p>

      <ApprovalsScreen
        pending={pending}
        requesterNames={nameFor(pending)}
        // The moment the queue was read, not the moment this rendered —
        // and it starts the client's clock at exactly the server's value, so
        // the first client render cannot disagree about what has lapsed.
        serverNow={readAt}
      />
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.approvals');
