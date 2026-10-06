'use client';

import {
  AtSign,
  Clock,
  FileText,
  MessageSquare,
  MoreHorizontal,
  PhoneIncoming,
  PhoneMissed,
  Receipt,
  ShoppingCart,
  Tag,
  UserPlus,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import {
  ISSUE_CODES,
  catalogNamed,
  triggerChannels,
  type Automation,
  type Issue,
  type TriggerType,
} from '@/api/contracts/automations';
import { channelMark } from '@/features/inbox/channel-marks';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/design-system/primitives/overlay/Menu';
import { Link } from '@/i18n/navigation';

import { setLive } from './automation-actions';
import { DeleteAutomation } from './DeleteAutomation';
import styles from './Automations.module.css';

const TRIGGER_ICON: Readonly<Record<TriggerType, LucideIcon>> = {
  message_received: MessageSquare,
  new_customer: UserPlus,
  tag_added: Tag,
  schedule: Clock,
  webhook: Webhook,
  call_missed: PhoneMissed,
  call_answered: PhoneIncoming,
  order_event: Receipt,
  cart_abandoned: ShoppingCart,
  form_submitted: FileText,
  story_mention: AtSign,
};

/**
 * 09c - the table (design 6): When · Flow · This week · Last run · on.
 *
 * ★ Every figure is the route's: this week's runs, the last run, who paused
 *   it and when. Nothing has run yet: "No runs yet", never a number made up
 *   for the row.
 * ★ The switch is the real thing: on activates - the route validates first
 *   and its refusal is said on the row, with the way into the builder - and
 *   off pauses, which records who and when.
 */
export function AutomationsList({ automations }: { readonly automations: readonly Automation[] }) {
  const t = useTranslations('automations');
  return (
    <div className={styles.table} role="table" aria-label={t('title')}>
      <div className={styles.head} role="row">
        <span role="columnheader">{t('columns.when')}</span>
        <span role="columnheader">{t('columns.flow')}</span>
        <span role="columnheader">{t('columns.week')}</span>
        <span role="columnheader">{t('columns.last')}</span>
        <span role="columnheader" className={styles.visuallyHidden}>
          {t('columns.on')}
        </span>
      </div>
      {automations.map((automation) => (
        <Row key={automation.id} initial={automation} />
      ))}
    </div>
  );
}

function Row({ initial }: { readonly initial: Automation }) {
  const t = useTranslations('automations');
  const format = useFormatter();
  const now = useNow();
  const [automation, setAutomation] = useState(initial);
  const [refused, setRefused] = useState<
    { readonly errors: readonly Issue[] } | 'forbidden' | 'failed' | null
  >(null);
  const [isPending, start] = useTransition();
  const [deleting, setDeleting] = useState(false);
  const [gone, setGone] = useState(false);
  const trigger = automation.trigger.type;
  const live = automation.status === 'live';
  const channels = triggerChannels(automation.trigger);

  const toggle = (on: boolean) =>
    start(async () => {
      setRefused(null);
      const result = await setLive(automation.id, on);
      if (result.ok) setAutomation(result.automation);
      else setRefused(result.reason === 'invalid' ? { errors: result.errors } : result.reason);
    });

  /** An issue in our words by its code; the route's own sentence only for a code we do not know. */
  const issueText = (issue: Issue | null) =>
    issue === null
      ? t('cantGoLiveUnknown')
      : (ISSUE_CODES as readonly string[]).includes(issue.code)
        ? t(`issues.${issue.code}` as 'issues.no_steps')
        : issue.message || t('cantGoLiveUnknown');

  const href = `/studio/automations/${automation.id}`;
  const lastRun = automation.stats.lastRunAt;

  if (gone) return null;

  return (
    <div
      className={styles.row}
      role="row"
      data-status={automation.status}
      data-testid={`automation-${automation.id}`}
    >
      <span className={styles.when} role="cell">
        <Mark trigger={trigger} channel={channels.length === 1 ? channels[0]! : null} />
        <Link href={href} className={styles.name} data-testid={`automation-open-${automation.id}`}>
          <bdi dir="auto">{automation.name}</bdi>
        </Link>
      </span>
      <span className={styles.flow} role="cell" data-testid={`automation-path-${automation.id}`}>
        {automation.path.map((step, i) => {
          const key = catalogNamed(step, trigger);
          return (
            <span key={step.nodeId} className={styles.stepWrap}>
              {i > 0 ? (
                <span className={styles.arrow} aria-hidden="true">
                  →
                </span>
              ) : null}
              <span className={styles.step}>
                {key ? (
                  t(`nodes.${key.replace(':', '.')}` as 'nodes.wait')
                ) : (
                  <bdi dir="auto">{step.label}</bdi>
                )}
              </span>
            </span>
          );
        })}
      </span>
      <span className={styles.week} role="cell" data-testid={`automation-week-${automation.id}`}>
        {lastRun === null ? '' : t('runs', { count: automation.stats.runsThisWeek })}
      </span>
      <span className={styles.last} role="cell" data-testid={`automation-last-${automation.id}`}>
        {automation.status === 'paused' && automation.pausedAt
          ? automation.pausedBy?.name
            ? t('pausedBy', {
                when: format.dateTime(new Date(automation.pausedAt), {
                  day: 'numeric',
                  month: 'short',
                }),
                name: automation.pausedBy.name,
              })
            : t('paused', {
                when: format.dateTime(new Date(automation.pausedAt), {
                  day: 'numeric',
                  month: 'short',
                }),
              })
          : automation.status === 'draft'
            ? t('draft')
            : lastRun
              ? format.relativeTime(new Date(lastRun), now)
              : t('noRuns')}
      </span>
      <span className={styles.on} role="cell">
        <input
          type="checkbox"
          role="switch"
          className={styles.switch}
          checked={live}
          disabled={isPending}
          aria-label={
            live ? t('pause', { name: automation.name }) : t('activate', { name: automation.name })
          }
          onChange={(e) => toggle(e.target.checked)}
          data-testid={`automation-switch-${automation.id}`}
        />
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              className={styles.more}
              aria-label={t('rowMore', { name: automation.name })}
              data-testid={`automation-more-${automation.id}`}
            >
              <MoreHorizontal size={14} aria-hidden="true" />
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem
              tone="danger"
              onSelect={() => setDeleting(true)}
              data-testid={`automation-delete-${automation.id}`}
            >
              {t('delete.item')}
            </MenuItem>
          </MenuContent>
        </Menu>
      </span>
      {deleting ? (
        <DeleteAutomation
          id={automation.id}
          name={automation.name}
          onClose={() => setDeleting(false)}
          onDeleted={() => setGone(true)}
        />
      ) : null}
      {refused ? (
        <p
          className={styles.refused}
          role="alert"
          data-testid={`automation-refused-${automation.id}`}
        >
          {typeof refused === 'object'
            ? t('cantGoLive', { why: issueText(refused.errors[0] ?? null) })
            : t(`liveFailed.${refused}`)}{' '}
          {typeof refused === 'object' ? (
            <Link href={href} className={styles.refusedLink}>
              {t('openToFix')}
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/** The row's mark: the channel when the trigger names one, else the trigger's own. */
function Mark({
  trigger,
  channel,
}: {
  readonly trigger: TriggerType | null;
  readonly channel: string | null;
}) {
  if (channel && (trigger === 'message_received' || trigger === 'new_customer')) {
    const { Icon, tone } = channelMark(channel);
    return (
      <span className={styles.mark} data-tone={tone} aria-hidden="true">
        <Icon size={15} strokeWidth={1.75} />
      </span>
    );
  }
  const Icon = trigger ? TRIGGER_ICON[trigger] : MessageSquare;
  return (
    <span className={styles.mark} data-trigger={trigger ?? undefined} aria-hidden="true">
      <Icon size={15} strokeWidth={1.75} />
    </span>
  );
}
