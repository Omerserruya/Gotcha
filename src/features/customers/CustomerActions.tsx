import { getFormatter, getTranslations } from 'next-intl/server';

import { Cog, User, Workflow } from 'lucide-react';

import { humanizeTag, type Approval } from '@/api/contracts/approvals';
import {
  POLICY_KINDS,
  policyLines,
  type BusinessPolicies,
  type PolicyLine,
} from '@/api/contracts/business-policies';
import {
  coverageGaps,
  outcomeOf,
  toolOf,
  unrecordedHint,
  type ActionOutcome,
  type AuditEvent,
} from '@/api/contracts/customer-actions';
import { Link } from '@/i18n/navigation';

import { shortDate } from './CustomerScreen';
import { PromiseCard } from './CustomerSubtabs';
import type { AuditRead } from './load-customer';
import styles from './Customers.module.css';
import { DecideHere } from './DecideHere';

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
 * entry is kept, in words (`humanizeTag`), with its key as the tooltip — an
 * unknown event is still evidence, and a screen that hid what it could not
 * label would quietly shorten the record. (It was rendered verbatim until
 * 2026-10-02: no code reaches the screen raw.)
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
  /*
   * GOTCHA's own guards, from `ai-bot.service.ts` and
   * `output-validator.service.ts`, each said as what it DOES. The two claim
   * checks strip the claim only when they can clean the reply, and otherwise
   * let it go out — so "was stopped" would be false; "claimed" is always true.
   */
  'ai.unsupported_outcome_claim': 'unsupportedOutcomeClaim',
  'ai.unsupported_action_claim': 'unsupportedActionClaim',
  'ai.exit_criteria_blocked': 'exitCriteriaBlocked',
  'ai.output_validator.blocked': 'outputValidatorBlocked',
};

/** `ai.tool_call.<tool>` and `ai.budget.aborted.<scope>` carry their tail. */
const PREFIX_KEYS: readonly (readonly [string, string])[] = [
  ['ai.tool_call.', 'aiToolCall'],
  ['ai.budget.aborted.', 'aiBudgetAborted'],
];

/**
 * ★★ THE CONVERSATION IS NOT AN ACTION ON THE ACCOUNT.
 *
 * A reply, a bot turn, a message sent: these are the conversation itself,
 * which has its own tab. Drawn one per row they drowned 04e — "GOTCHA
 * replied · Outcome not recorded", dozens deep — and inflated "by GOTCHA" to
 * 54. So they collapse to one row per day ("GOTCHA replied 12 times") with no
 * outcome chip, and stay out of the counts. Collapsed, not dropped: the record
 * keeps its length.
 */
const CONVERSATION_ACTIONS: ReadonlySet<string> = new Set([
  'ai.responded',
  'ai.bot_turn',
  'message.sent',
]);

export function isConversationActivity(event: AuditEvent): boolean {
  return CONVERSATION_ACTIONS.has(event.action);
}

/**
 * Does this row have an outcome to report? A tool GOTCHA used, an adapter
 * call, a change to the customer's record in the store — yes. A pause, a
 * refusal, a budget stop is itself the outcome; a chip there says nothing.
 */
export function expectsOutcome(event: AuditEvent): boolean {
  return (
    toolOf(event) !== null ||
    event.action.startsWith('ai.tool_call.') ||
    event.action.startsWith('commerce.customer_action_')
  );
}

/**
 * The approval's `reason` is the bot's stated reasoning — or, from the
 * policy engine, a log line: "policy requires approval (catalog=always)".
 * A `key=value` in it is the log, and the line is left empty rather than
 * shown.
 */
export function humanReason(reason: string): string | null {
  const text = reason.trim();
  return text && !/\w=\S/.test(text) ? text : null;
}

/** The budget scopes `cost-budget.service.ts` writes, in words. */
const BUDGET_SCOPES: ReadonlySet<string> = new Set(['turn', 'conversation', 'tenant_day']);

export const ACTION_FILTERS = ['all', 'gotcha', 'team', 'money'] as const;
export type ActionFilter = (typeof ACTION_FILTERS)[number];

export function parseActionFilter(raw: string | undefined): ActionFilter {
  return (ACTION_FILTERS as readonly string[]).includes(raw ?? '') ? (raw as ActionFilter) : 'all';
}

/** Who acted, as 04e's disc draws it. `flow` is an automation's approval request. */
type Who = 'ai' | 'user' | 'flow' | 'system' | 'unknown';

/**
 * Money-moving, by the platform's own names: a refund, a cancel, a
 * discount, or any commerce action on the customer's record.
 */
const MONEY = /refund|cancel|discount|commerce\./i;

/** `requestedBy` is `"bot"`, `"flow:<id>"` or `"ai-agent:<id>"` — never a person. */
function whoAsked(approval: Approval): Who {
  return approval.requestedBy.startsWith('flow:') ? 'flow' : 'ai';
}

const OUTCOME_TONE: Readonly<Record<ActionOutcome, string>> = {
  worked: 'positive',
  failed: 'danger',
  contradicts: 'warning',
  not_recorded: 'neutral',
};

const APPROVAL_TONE: Readonly<Record<Approval['status'], string>> = {
  PENDING: 'waiting',
  APPROVED: 'positive',
  REJECTED: 'neutral',
  EXPIRED: 'neutral',
  CANCELLED: 'neutral',
};

interface Row {
  readonly key: string;
  readonly at: string;
  readonly who: Who;
  readonly title: string;
  readonly chip: {
    readonly label: string;
    readonly tone: string;
    readonly outcome?: ActionOutcome;
    readonly testid?: string;
  } | null;
  readonly line: string | null;
  /** The platform's key, as the title's tooltip, when the title is our humanising of it. */
  readonly rawKey?: string;
  readonly lineTestid?: string;
  readonly whoTestid?: string;
  readonly testid: string;
  readonly pending: boolean;
  readonly money: boolean;
  /** A pending approval's id — decided on the row. */
  readonly approvalId?: string;
}

/**
 * 04e — everything done on their account, one spine, newest first.
 *
 * Two records feed it, each the platform's own: the audit log (what was
 * done, with the four reads above) and the approvals GOTCHA asked for in
 * their conversations — 02's "Asked to refund ₪179 on #1842 · Waiting on
 * you". An approval is drawn with the backend's sentence, its status, and
 * the bot's stated reasoning as the line.
 *
 * ⚠ 02's Approve / Decline / Change amount are NOT drawn as controls here.
 * Deciding belongs to 03, where the risk and the reasoning are laid out,
 * and 03 has no address for one approval to deep-link to; a waiting row
 * says "Open in Approvals" instead. Put to Omer.
 */
export async function CustomerActions({
  actions,
  approvals = [],
  filter = 'all',
}: {
  readonly actions: AuditRead;
  /** GOTCHA's approval requests in this person's conversations. */
  readonly approvals?: readonly Approval[] | null;
  readonly filter?: ActionFilter;
}) {
  const t = await getTranslations('customers');
  const format = await getFormatter();
  const now = new Date();

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
        <p className={styles.unavailable}>{t('actions.forbidden')}</p>
      </section>
    );
  }

  if (actions.state === 'failed') {
    return (
      <section className={styles.actions} data-testid="customer-actions-failed">
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
        const detail = event.action.slice(prefix.length);
        if (k === 'aiBudgetAborted') {
          // `tenant_day` is a key, not a sentence: each scope has its own words.
          return BUDGET_SCOPES.has(detail)
            ? t(`actions.budget.${detail}` as 'actions.budget.tenant_day')
            : t('actions.budget.other');
        }
        // The tool's own name, made legible: "shopify.lookup_order" → "Lookup order".
        return t(`actions.name.${k}` as 'actions.name.aiToolCall', {
          detail: humanizeTag(detail.split('.').pop() ?? detail),
        });
      }
    }
    /*
      ★ AN UNKNOWN KEY IN WORDS, NEVER RAW — the rule that no code reaches
      the screen outranks the older "verbatim". Still never dropped: an event
      we have no words for is something that happened. The key itself is the
      row's tooltip, for whoever is debugging.
    */
    return humanizeTag(event.action);
  };
  /** The raw key, when the title is our wording of something we had no words for. */
  const rawKeyOf = (event: AuditEvent): string | undefined =>
    ACTION_KEYS[event.action] ||
    toolOf(event) ||
    PREFIX_KEYS.some(([prefix]) => event.action.startsWith(prefix))
      ? undefined
      : event.action;

  /*
    The conversation, one row per day and kind: what GOTCHA said, what the
    team sent. A day's replies count `ai.responded`; a day with turns and no
    recorded reply counts the turns, so nothing is silently zero.
  */
  const dayOf = (iso: string) =>
    format.dateTime(new Date(iso), { year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = new Map<
    string,
    {
      at: string;
      who: Who;
      kind: 'replied' | 'sent';
      responded: number;
      turns: number;
      sent: number;
    }
  >();
  for (const event of audit.data.filter(isConversationActivity)) {
    const who: Who = event.actorType ?? 'unknown';
    const kind = event.action === 'message.sent' && who === 'user' ? 'sent' : 'replied';
    const key = `${dayOf(event.createdAt)}|${kind}`;
    const day = days.get(key) ?? {
      at: event.createdAt,
      who: kind === 'sent' ? 'user' : 'ai',
      kind,
      responded: 0,
      turns: 0,
      sent: 0,
    };
    if (event.createdAt > day.at) day.at = event.createdAt;
    if (event.action === 'ai.responded') day.responded += 1;
    else if (event.action === 'ai.bot_turn') day.turns += 1;
    else day.sent += 1;
    days.set(key, day);
  }

  const rows: Row[] = [
    ...[...days.entries()].map(([key, day]): Row => {
      const count = day.kind === 'sent' ? day.sent : day.responded || day.turns + day.sent;
      return {
        key: `d-${key}`,
        at: day.at,
        who: day.who,
        title:
          day.kind === 'sent'
            ? t('actions.daySent', { count })
            : t('actions.dayReplied', { count }),
        chip: null,
        line: null,
        testid: `action-day-${day.kind}-${key.split('|')[0]!.replace(/\D/g, '')}`,
        pending: false,
        money: false,
      };
    }),
    ...audit.data
      .filter((event) => !isConversationActivity(event))
      .map((event): Row => {
        const outcome: ActionOutcome = outcomeOf(event);
        const hint = unrecordedHint(event);
        return {
          key: `e-${event.id}`,
          at: event.createdAt,
          who: event.actorType ?? 'unknown',
          title: label(event),
          rawKey: rawKeyOf(event),
          /*
          ★ FOUR OUTCOMES AND THE UNRECORDED ONE IS NOT STYLED AS A
          FAILURE. It is the most common state on this screen — no
          customer-keyed row records a verdict at all — so dressing it as
          bad would paint the whole log red.
        */
          chip:
            expectsOutcome(event) || outcome !== 'not_recorded'
              ? {
                  label: t(`actions.outcome.${outcome}` as 'actions.outcome.worked'),
                  tone: OUTCOME_TONE[outcome],
                  outcome,
                  testid: `action-outcome-${event.id}`,
                }
              : null,
          line: hint ? t(`actions.hint.${hint}` as 'actions.hint.named_ok') : null,
          lineTestid: `action-hint-${event.id}`,
          whoTestid: `action-who-${event.id}`,
          testid: `action-${event.id}`,
          pending: false,
          money: MONEY.test(event.action),
        };
      }),
    ...(approvals ?? []).map((approval): Row => ({
      key: `p-${approval.id}`,
      at: approval.createdAt,
      who: whoAsked(approval),
      title: approval.summary,
      chip: {
        label:
          approval.status === 'PENDING'
            ? t('actions.waitingOnYou')
            : t(`card.approval.${approval.status}`),
        tone: APPROVAL_TONE[approval.status],
      },
      // The bot's stated reasoning — shown as reasoning, never as fact.
      line: humanReason(approval.reason),
      testid: `action-approval-${approval.id}`,
      pending: approval.status === 'PENDING',
      approvalId: approval.id,
      money: MONEY.test(approval.tool),
    })),
  ]
    .filter((row) =>
      filter === 'gotcha'
        ? row.who === 'ai'
        : filter === 'team'
          ? row.who === 'user'
          : filter === 'money'
            ? row.money
            : true,
    )
    .sort((a, b) => b.at.localeCompare(a.at));

  const time = (iso: string) =>
    format.dateTime(new Date(iso), { hour: '2-digit', minute: '2-digit', hour12: false });

  return (
    <section className={styles.actions} data-testid="customer-actions">
      <p className={styles.tabLead}>
        <span>{t('actions.lead')}</span>
        {/*
          ★★ WHAT THIS LIST IS NOT, in 02's note slot. An empty or short log
          cannot say why it is short; the endpoint declares its own gaps, and
          they are printed rather than trusted to be noticed. One line; the
          endpoint's own sentences are its tooltip.
        */}
        {gaps.length > 0 ? (
          <span
            className={styles.actionsNote}
            data-testid="actions-gaps"
            title={gaps.map((gap) => gap.detail).join(' ')}
          >
            {t('actions.gapsShort', { count: gaps.length })}
            {gaps.map((gap) => (
              <span key={gap.target} className="srOnly" data-testid={`actions-gap-${gap.target}`}>
                {gap.detail}
              </span>
            ))}
          </span>
        ) : null}
      </p>

      {rows.length === 0 ? (
        <p className={styles.actionsEmpty} data-testid="actions-empty">
          {filter === 'all' ? t('actions.none') : t('actions.filterEmpty')}
        </p>
      ) : (
        <ol className={styles.spine}>
          {rows.map((row) => (
            <li key={row.key} className={styles.spineRow} data-testid={row.testid}>
              <span className={styles.spineWhen}>
                <span>{shortDate(row.at, now, format, t('card.today'))}</span>
                {new Date(row.at).toDateString() === now.toDateString() ? (
                  <span className={styles.spineTime}>{time(row.at)}</span>
                ) : null}
              </span>
              <span className={styles.spineRail}>
                <span className={styles.actorDisc} data-who={row.who} data-testid={row.whoTestid}>
                  {row.who === 'ai' ? (
                    <span aria-hidden="true">AI</span>
                  ) : row.who === 'user' ? (
                    <User size={11} strokeWidth={2.2} aria-hidden="true" />
                  ) : row.who === 'flow' ? (
                    <Workflow size={11} strokeWidth={2.2} aria-hidden="true" />
                  ) : row.who === 'system' ? (
                    <Cog size={11} strokeWidth={2.2} aria-hidden="true" />
                  ) : (
                    <span aria-hidden="true">?</span>
                  )}
                  <span className="srOnly">
                    {t(`actions.actor.${row.who}` as 'actions.actor.ai')}
                  </span>
                </span>
                <span className={styles.spineLine} aria-hidden="true" />
              </span>
              <article className={styles.spineCard}>
                <span className={styles.spineTop}>
                  <span className={styles.actionTitle} title={row.rawKey}>
                    {row.title}
                  </span>
                  {row.chip ? (
                    <span
                      className={styles.spineChip}
                      data-tone={row.chip.tone}
                      data-outcome={row.chip.outcome}
                      data-testid={row.chip.testid}
                    >
                      {row.chip.label}
                    </span>
                  ) : null}
                </span>
                {row.line ? (
                  <span className={styles.actionLine} data-testid={row.lineTestid}>
                    {row.line}
                  </span>
                ) : null}
                {row.pending && row.approvalId ? (
                  // 02: decided here — Approve · Decline · Change amount (in 03).
                  <span className={styles.spineFoot}>
                    <DecideHere approvalId={row.approvalId} />
                  </span>
                ) : null}
              </article>
            </li>
          ))}
        </ol>
      )}

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

/** 04e's filters: All, GOTCHA, Team, Money. */
export async function ActionFilters({
  contactId,
  current,
}: {
  readonly contactId: string;
  readonly current: ActionFilter;
}) {
  const t = await getTranslations('customers');
  return (
    <>
      {ACTION_FILTERS.map((key) => (
        <Link
          key={key}
          href={{
            pathname: `/customers/${contactId}`,
            query: key === 'all' ? { tab: 'actions' } : { tab: 'actions', filter: key },
          }}
          className={styles.filterPill}
          aria-current={current === key ? 'true' : undefined}
          data-testid={`action-filter-${key}`}
        >
          {t(`actions.filter.${key}`)}
        </Link>
      ))}
    </>
  );
}

/**
 * 04e's side: who did what, money moved, what GOTCHA may do — and the
 * promise card.
 *
 * The counts are of what this page read: the audit page and the approvals
 * in their conversations. Money amounts are not on either record (an
 * approval's amount lives in `params`, which never leaves the server), so
 * the money block counts what waits rather than summing what it cannot see.
 */
export async function ActionsSide({
  actions,
  approvals,
  policies = null,
  currency = null,
}: {
  readonly actions: AuditRead;
  readonly approvals: readonly Approval[] | null;
  /** The tenant's business rules; `null` when unread or not readable by this viewer. */
  readonly policies?: BusinessPolicies | null;
  /** The shop's currency, for the rules' amounts — which carry none of their own. */
  readonly currency?: string | null;
}) {
  const t = await getTranslations('customers');
  const format = await getFormatter();
  const amount = (n: number) =>
    currency
      ? format.number(n, { style: 'currency', currency, maximumFractionDigits: 2 })
      : format.number(n);
  const kindName = (kind: string) =>
    (POLICY_KINDS as readonly string[]).includes(kind)
      ? t(`actions.policy.kind.${kind}` as 'actions.policy.kind.REFUND')
      : humanizeTag(kind);
  /*
    Each rule as the engine applies it — see `describePolicy`. The percent is
    a fraction of the order in the engine (`cap = maxPercentOfOrder × order`),
    so it is shown as one.
  */
  const sentence = (line: PolicyLine): string => {
    const name = kindName(line.kind);
    if (line.shape === 'never') {
      return t(line.byDefault ? 'actions.policy.neverByDefault' : 'actions.policy.never', { name });
    }
    if (line.shape === 'unset') return t('actions.policy.unset', { name });
    const parts = [
      line.max !== null ? t('actions.policy.upTo', { amount: amount(line.max) }) : null,
      line.percent !== null
        ? t('actions.policy.upToPercent', {
            percent: format.number(line.percent, { style: 'percent', maximumFractionDigits: 1 }),
          })
        : null,
      line.approvalAbove !== null
        ? t('actions.policy.approvalAbove', { amount: amount(line.approvalAbove) })
        : null,
    ].filter(Boolean);
    return parts.length > 0
      ? t('actions.policy.limits', { name, rules: parts.join('; ') })
      : t('actions.policy.noLimit', { name });
  };
  // Actions on the account, not the conversation — see `CONVERSATION_ACTIONS`.
  const events =
    actions.state === 'ok'
      ? actions.audit.data.filter((event) => !isConversationActivity(event))
      : null;
  const asked = approvals ?? [];
  const count = (n: number | null) => (n === null ? '—' : format.number(n));
  const read = events !== null && approvals !== null;
  const byGotcha = read
    ? events.filter((e) => e.actorType === 'ai').length +
      asked.filter((a) => whoAsked(a) === 'ai').length
    : null;
  const byTeam = events ? events.filter((e) => e.actorType === 'user').length : null;
  const byAutomations = read
    ? events.filter((e) => e.actorType === 'system').length +
      asked.filter((a) => whoAsked(a) === 'flow').length
    : null;
  const waiting =
    approvals === null
      ? null
      : asked.filter((a) => a.status === 'PENDING' && MONEY.test(a.tool)).length;

  return (
    <>
      <section className={styles.sideBlock} data-testid="actions-who">
        <h2 className={styles.sideEyebrow}>{t('actions.side.who')}</h2>
        <dl className={`${styles.worth} ${styles.pattern}`}>
          <div>
            <dt>{t('actions.side.byGotcha')}</dt>
            <dd className={styles.worthValue}>{count(byGotcha)}</dd>
          </div>
          <div>
            <dt>{t('actions.side.byTeam')}</dt>
            <dd className={styles.worthValue}>{count(byTeam)}</dd>
          </div>
          <div>
            <dt>{t('actions.side.byAutomations')}</dt>
            <dd className={styles.worthValue}>{count(byAutomations)}</dd>
          </div>
        </dl>
      </section>
      <section className={styles.sideBlock} data-testid="actions-money">
        <h2 className={styles.sideEyebrow}>{t('actions.side.money')}</h2>
        <dl className={styles.moneyMoved}>
          <div>
            <dt>{t('actions.side.refunded')}</dt>
            <dd>—</dd>
          </div>
          <div>
            <dt>{t('actions.side.discounts')}</dt>
            <dd>—</dd>
          </div>
          <div data-attention={waiting ? '' : undefined}>
            <dt>{t('actions.side.waiting')}</dt>
            <dd>{waiting === null ? '—' : t('actions.side.waitingValue', { count: waiting })}</dd>
          </div>
        </dl>
      </section>
      {/* The policy GOTCHA acts under is not read on this page; the place to change it is. */}
      <section className={styles.sideBlock} data-testid="actions-may">
        <h2 className={styles.sideEyebrow}>{t('actions.side.may')}</h2>
        {policies ? (
          <ul className={styles.remembers} data-testid="actions-policies">
            {policyLines(policies).map((line) => (
              <li key={line.kind} data-testid={`policy-${line.kind}`}>
                {sentence(line)}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.sideNone}>—</p>
        )}
        <Link href="/studio/capabilities" className={styles.tabLeadLink}>
          {t('actions.side.change')}
        </Link>
      </section>
      <PromiseCard heading={t('card.promise.heading')} none={t('card.promise.none')} />
    </>
  );
}
