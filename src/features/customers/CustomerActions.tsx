import { getFormatter, getTranslations } from 'next-intl/server';

import {
  coverageGaps,
  outcomeOf,
  toolOf,
  unrecordedHint,
  type ActionOutcome,
  type AuditEvent,
} from '@/api/contracts/customer-actions';
import type { AuditRead } from './load-customer';

import styles from './Customers.module.css';

/**
 * Screen 04e — what was done in this customer's context.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ WHAT THE PLATFORM ACTUALLY WRITES, CHECKED ROW BY ROW
 * ════════════════════════════════════════════════════════════════════════════
 * The endpoint returns rows whose `targetType` is `conversation` (this
 * person's conversations) or `customer` (their provider id). Everything
 * else is unreachable here by construction, so the vocabulary this screen
 * can meet is small and finite — and it is NOT the vocabulary the route's
 * own comment advertises.
 *
 * Reachable, verified at the write sites:
 *
 *   conversation   ai.responded · ai.bot_turn · ai.paused_for_approval
 *                  ai.tool_call.<tool> · ai.budget.aborted.<scope>
 *                  message.sent · shopify_live_chat.product_message_sent
 *                  security.cross_customer_access_denied
 *                  adapter.ok.<tool> · adapter.err.<tool>
 *   customer       commerce.customer_action_executed · _failed
 *                  _denied · _unverified
 *
 * ── `crm.link.linked` IS NOT WRITTEN ANYWHERE ──
 * It appears in the route's header as an example of the "rich set", and in
 * one test's query string, and in **no write site in the platform**. Our own
 * contract repeated it because that header was read as evidence. It was a
 * description, and a description is not a fact about what the code does.
 *
 * ── AND MOST ROWS HAVE NO RECORDED OUTCOME ──
 * ★★ `commerce.customer_action_executed` AND `..._failed` BOTH WRITE NO
 * `metadata.ok`. So `succeeded` is null on every customer-keyed row, and
 * `outcomeOf` says `not_recorded` beside an event whose NAME says it failed.
 *
 * That is not a bug to route around. The name is not the verdict — that is
 * the exact resolution-by-naming-convention Backend caught in `outcomeOf`'s
 * first version — so the name is SHOWN, through the lookup below, and the
 * outcome stays unrecorded. Showing and deciding are different acts, and
 * only one of them is ours to perform.
 *
 * ── TWO BRANCHES HERE ARE UNREACHABLE TODAY, AND ARE KEPT ANYWAY ──
 * `contradicts` needs `succeeded` and the name to disagree. The only writer
 * of a `.ok.`/`.err.` action is `auditAdapterCall`, which sets BOTH from the
 * same `opts.ok` — so they cannot disagree, and no other writer produces an
 * action with an `ok.`/`err.` segment. `unrecordedHint` is dead for the
 * same reason: the only rows with a name-implication always record a
 * verdict.
 *
 * They stay because the contract is the server's, not ours, and a future
 * emitter can produce both. They are named here and in the tests as
 * **unreached** rather than left to look like coverage — and deliberately
 * NOT fabricated into the capture fixture, which would photograph a row the
 * platform cannot currently create.
 */

/**
 * The platform's event names, rendered legibly.
 *
 * ★ A LOOKUP, NOT A REWRITE. Every key here is a string this platform
 * actually writes against a conversation or a customer. An action with no
 * entry is rendered **verbatim** — an unknown event is still evidence, and a
 * screen that hid what it could not label would quietly shorten the record.
 */
const ACTION_KEYS: Readonly<Record<string, string>> = {
  'ai.responded': 'aiResponded',
  'ai.bot_turn': 'aiBotTurn',
  'ai.paused_for_approval': 'aiPausedForApproval',
  'message.sent': 'messageSent',
  'shopify_live_chat.product_message_sent': 'productMessageSent',
  'security.cross_customer_access_denied': 'crossCustomerDenied',
  'commerce.customer_action_executed': 'commerceExecuted',
  'commerce.customer_action_failed': 'commerceFailed',
  'commerce.customer_action_denied': 'commerceDenied',
  'commerce.customer_action_unverified': 'commerceUnverified',
};

/** `ai.tool_call.<tool>` and `ai.budget.aborted.<scope>` carry their tail. */
const PREFIX_KEYS: readonly (readonly [string, string])[] = [
  ['ai.tool_call.', 'aiToolCall'],
  ['ai.budget.aborted.', 'aiBudgetAborted'],
];

export async function CustomerActions({ actions }: { readonly actions: AuditRead }) {
  const t = await getTranslations('customers');
  const format = await getFormatter();

  if (actions.state === 'not_asked') {
    /*
     * Reached only when the timeline read failed, in which case the page is
     * already its own error and this component is not mounted. Rendering
     * nothing is the honest answer to "we never asked".
     */
    return null;
  }

  if (actions.state === 'forbidden') {
    // A permission to be granted, not a fault to be reported. Saying "we
    // couldn't read it" would send somebody to check a system that is fine.
    return (
      <section className={styles.actions} data-testid="customer-actions-forbidden">
        <h2 className={styles.detailHeading}>{t('actions.title')}</h2>
        <p className={styles.unavailable}>{t('actions.forbidden')}</p>
      </section>
    );
  }

  if (actions.state === 'failed') {
    return (
      <section className={styles.actions} data-testid="customer-actions-failed">
        <h2 className={styles.detailHeading}>{t('actions.title')}</h2>
        <p className={styles.unavailable}>{t('actions.failed')}</p>
      </section>
    );
  }

  const { audit, supplied } = actions;
  const gaps = coverageGaps(audit.coverage, supplied);

  const label = (event: AuditEvent): string => {
    const key = ACTION_KEYS[event.action];
    if (key) return t(`actions.name.${key}` as 'actions.name.aiResponded');
    const tool = toolOf(event);
    if (tool) return t('actions.name.adapterCall', { tool });
    for (const [prefix, k] of PREFIX_KEYS) {
      if (event.action.startsWith(prefix)) {
        return t(`actions.name.${k}` as 'actions.name.aiToolCall', {
          detail: event.action.slice(prefix.length),
        });
      }
    }
    // Verbatim. An event we have no words for is still something that
    // happened, and dropping it would shorten somebody's record silently.
    return event.action;
  };

  return (
    <section className={styles.actions} data-testid="customer-actions">
      <h2 className={styles.detailHeading}>{t('actions.title')}</h2>

      {audit.data.length === 0 ? (
        <p className={styles.actionsEmpty} data-testid="actions-empty">
          {t('actions.none')}
        </p>
      ) : (
        <ol className={styles.actionList}>
          {audit.data.map((event) => {
            const outcome: ActionOutcome = outcomeOf(event);
            const hint = unrecordedHint(event);
            return (
              <li key={event.id} className={styles.actionRow} data-testid={`action-${event.id}`}>
                <span className={styles.actionWho} data-testid={`action-who-${event.id}`}>
                  {t(`actions.actor.${event.actorType ?? 'unknown'}` as 'actions.actor.ai')}
                </span>
                <span className={styles.actionWhat}>{label(event)}</span>
                <time className={styles.actionWhen} dateTime={event.createdAt}>
                  {format.dateTime(new Date(event.createdAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </time>
                {/*
                  ★ FOUR OUTCOMES AND THE UNRECORDED ONE IS NOT STYLED AS A
                  FAILURE. It is the most common state on this screen — no
                  customer-keyed row records a verdict at all — so dressing
                  it as bad would paint the whole log red.
                */}
                <span
                  className={styles.actionOutcome}
                  data-outcome={outcome}
                  data-testid={`action-outcome-${event.id}`}
                >
                  {t(`actions.outcome.${outcome}` as 'actions.outcome.worked')}
                </span>
                {hint ? (
                  <span className={styles.actionHint} data-testid={`action-hint-${event.id}`}>
                    {t(`actions.hint.${hint}` as 'actions.hint.named_ok')}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {/*
        ★★ WHAT THIS LIST IS NOT. An empty or short log cannot say why it is
        short, and "nothing was done" is the wrong thing for a screen to
        imply. The endpoint declares its own gaps; they are printed rather
        than trusted to be noticed.
      */}
      {gaps.length > 0 ? (
        <ul className={styles.actionGaps} data-testid="actions-gaps">
          {gaps.map((gap) => (
            <li key={gap.target} data-testid={`actions-gap-${gap.target}`}>
              {gap.detail}
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        A bounded read that discloses its bound is fine; one that quietly
        drops the oldest is the defect. The same distinction the timeline
        makes, and the endpoint hands us the flag to make it with.
      */}
      {audit.scope.conversationScanTruncated ? (
        <p className={styles.actionGaps} data-testid="actions-truncated">
          {t('actions.truncated', { count: audit.scope.conversations })}
        </p>
      ) : null}

      {audit.nextCursor ? (
        <p className={styles.actionGaps} data-testid="actions-more">
          {t('actions.more')}
        </p>
      ) : null}
    </section>
  );
}
