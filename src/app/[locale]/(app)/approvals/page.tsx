import { getTranslations } from 'next-intl/server';

import type { Approval } from '@/api/contracts/approvals';
import { ApprovalsScreen } from '@/features/approvals/ApprovalsScreen';
import { handledToday } from '@/features/approvals/handled';
import { DecisionStats, HandledCard, NothingWaiting } from '@/features/approvals/NothingWaiting';
import { decisionStats, loadApprovals, requesterName } from '@/features/approvals/load-approvals';
import styles from '@/features/approvals/Approvals.module.css';
import { Link } from '@/i18n/navigation';
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
export default async function Page({
  searchParams,
}: {
  /** `?view=decided` — the history, reachable while items are pending too. */
  readonly searchParams?: Promise<{ readonly view?: string }>;
} = {}) {
  const t = await getTranslations('approvals');
  const { view } = (await searchParams) ?? {};
  const {
    pending,
    decided,
    decidedMayBeIncomplete,
    aiEmployees,
    readAt,
    usageToday,
    customerNames,
  } = await loadApprovals();

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
   * The history, asked for from the queue's "Decided earlier today" row.
   * The same card as 03c, with the way back to what is waiting.
   */
  if (view === 'decided' && pending.length > 0) {
    return (
      <PageContainer
        layout="screen"
        fill
        title={t('decided.heading')}
        description={t('pending.title', { count: pending.length })}
        actions={
          <Link href="/approvals" className={styles.keys} data-testid="back-to-queue">
            {t('queue.backToQueue', { count: pending.length })}
          </Link>
        }
      >
        <NothingWaiting
          decided={decided}
          mayBeIncomplete={decidedMayBeIncomplete}
          requesterNames={nameFor(decided)}
          customerNames={customerNames}
        />
      </PageContainer>
    );
  }

  /*
   * Screen 03c. An empty queue is the delegation WORKING, so this is a
   * first-class state rather than a blank — and it is where the record of
   * what you already decided lives.
   */
  const now = new Date(readAt);
  const handled = handledToday(usageToday, decided, now);
  const decidedToday = (decided ?? []).filter(
    (approval) =>
      approval.decidedAt !== null &&
      new Date(approval.decidedAt).toDateString() === now.toDateString(),
  ).length;

  if (pending.length === 0) {
    return (
      /*
        ★ 03c's title is the STATE, not the page's name — "Nothing waiting on
          you" — with 02's figures on the right.
      */
      <PageContainer
        layout="screen"
        /* A window: the header stays, the decisions scroll inside their card. */
        fill
        title={t('rest.title')}
        /* "Inside the limits you set" only when something came up today. */
        description={
          (handled?.total ?? 0) > 0 || decidedToday > 0 ? t('rest.busy') : t('rest.lead')
        }
        actions={<DecisionStats stats={decisionStats(decided, decidedMayBeIncomplete)} />}
      >
        <div className={styles.rest}>
          <HandledCard handled={handled} />
          <NothingWaiting
            decided={decided}
            mayBeIncomplete={decidedMayBeIncomplete}
            requesterNames={nameFor(decided)}
            customerNames={customerNames}
          />
        </div>
      </PageContainer>
    );
  }

  /*
   * ★ 03's subline names the soonest deadline — `expiresAt` is real on every
   *   row. Measured from the moment the queue was read, as the screen is.
   */
  const soonest = pending
    .map((approval) => Date.parse(approval.expiresAt) - readAt)
    .filter((left) => Number.isFinite(left) && left > 0)
    .sort((x, y) => x - y)[0];
  const inWords = (ms: number) => {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    if (minutes < 60) return t('time.minutes', { n: minutes });
    const hours = Math.round(minutes / 60);
    return hours < 48
      ? t('time.hours', { n: hours })
      : t('time.days', { n: Math.round(hours / 24) });
  };

  return (
    <PageContainer
      layout="screen"
      flush
      /* 03: the title is how many need you, not the page's name. */
      title={t('pending.title', { count: pending.length })}
      description={
        soonest === undefined
          ? t('pending.description')
          : t('pending.soonest', { in: inWords(soonest) })
      }
      actions={
        <>
          <DecisionStats stats={decisionStats(decided, decidedMayBeIncomplete)} />
          {/*
            The legend lists exactly the keys the screen honours — no `E`,
            because editing is not built, and `A` only focuses Approve. A
            legend that advertises a key that does nothing is the same defect
            as offering an event that nothing raises.
          */}
          <p className={styles.keys} data-testid="approvals-keys">
            {t('keys')}
          </p>
        </>
      }
    >
      <ApprovalsScreen
        pending={pending}
        requesterNames={nameFor(pending)}
        // The moment the queue was read, not the moment this rendered —
        // and it starts the client's clock at exactly the server's value, so
        // the first client render cannot disagree about what has lapsed.
        serverNow={readAt}
        /* 03b's "That's the twelfth like it" — counted from the history, by tool. */
        decidedHistory={(decided ?? []).map(({ id, tool, status }) => ({ id, tool, status }))}
        /* 02's "Decided earlier today · N", counted where the history is. */
        decidedToday={
          decided === null
            ? null
            : decided.filter(
                (approval) =>
                  approval.decidedAt !== null &&
                  new Date(approval.decidedAt).toDateString() === new Date(readAt).toDateString(),
              ).length
        }
      />
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.approvals');
