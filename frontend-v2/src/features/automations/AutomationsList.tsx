'use client';

import {
  AtSign,
  Clock,
  FileText,
  Megaphone,
  MessageSquare,
  MessagesSquare,
  MousePointerClick,
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
import { useEffect, useState, type MouseEvent } from 'react';

import {
  ISSUE_CODES,
  catalogNamed,
  triggerChannels,
  type Automation,
  type Issue,
  type TriggerType,
} from '@/api/contracts/automations';
import { ChannelPlate } from '@/design-system/brand/channel-plate';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/design-system/primitives/overlay/ContextMenu';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/design-system/primitives/overlay/Menu';
import { SkeletonRows } from '@/design-system/primitives/skeleton/Skeleton';
import { Link, useRouter } from '@/i18n/navigation';

import { setLive } from './automation-actions';
import { DeleteAutomation } from './DeleteAutomation';
import { modLabel, shortcutsAllowed, withMod } from './shortcuts';
import styles from './Automations.module.css';

const TRIGGER_ICON: Readonly<Record<TriggerType, LucideIcon>> = {
  message_received: MessageSquare,
  new_customer: UserPlus,
  message_from_ad: Megaphone,
  button_tapped: MousePointerClick,
  comment_received: MessagesSquare,
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
  const [items, setItems] = useState(automations);
  const [refusals, setRefusals] = useState<ReadonlyMap<string, Refusal>>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<readonly Automation[] | null>(null);
  const router = useRouter();

  const ids = items.map((a) => a.id);
  const picked = items.filter((a) => selected.has(a.id));

  /** Click, ⌘/Ctrl-click, Shift-click - 09c's selection, the inbox's pattern. */
  const pick = (id: string, how: { readonly add: boolean; readonly range: boolean }) => {
    if (how.range && anchor !== null) {
      const a = ids.indexOf(anchor);
      const b = ids.indexOf(id);
      setSelected(new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)));
      return;
    }
    setAnchor(id);
    if (how.add) {
      setSelected((now) => {
        const next = new Set(now);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    setSelected(new Set([id]));
  };

  /** Turn on or pause each - one route call apiece, each refusal said on its own row. */
  const setEach = async (targets: readonly Automation[], on: boolean) => {
    const todo = targets.filter((a) => (a.status === 'live') !== on);
    setBusy(new Set(todo.map((a) => a.id)));
    for (const target of todo) {
      const result = await setLive(target.id, on);
      setItems((now) =>
        result.ok ? now.map((a) => (a.id === target.id ? result.automation : a)) : now,
      );
      setRefusals((now) => {
        const next = new Map(now);
        if (result.ok) next.delete(target.id);
        else
          next.set(
            target.id,
            result.reason === 'invalid' ? { errors: result.errors } : result.reason,
          );
        return next;
      });
    }
    setBusy(new Set());
  };

  // ⌘/Ctrl+A, Esc, Delete/Backspace - not while typing, not under a dialog or a menu.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!shortcutsAllowed(event)) return;
      if (withMod(event) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setSelected(new Set(ids));
        return;
      }
      if (event.key === 'Escape' && selected.size > 0) {
        event.preventDefault();
        setSelected(new Set());
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && picked.length > 0) {
        event.preventDefault();
        setDeleting(picked);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ids, picked, selected]);

  /** Right-click on a row not in the selection: it becomes the selection, as everywhere. */
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const row = (event.target as Element).closest<HTMLElement>('[data-automation-id]');
    const id = row?.dataset.automationId ?? null;
    if (id === null) {
      if (selected.size === 0) event.preventDefault();
      return;
    }
    if (!selected.has(id)) {
      setSelected(new Set([id]));
      setAnchor(id);
    }
  };

  const one = picked.length === 1 ? picked[0]! : null;
  const anyOff = picked.some((a) => a.status !== 'live');
  const anyOn = picked.some((a) => a.status === 'live');

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={styles.table}
            role="table"
            aria-label={t('title')}
            onContextMenu={onContextMenu}
            data-testid="automations-table"
          >
            <TableHead />
            {items.map((automation) => (
              <Row
                key={automation.id}
                automation={automation}
                selected={selected.has(automation.id)}
                pending={busy.has(automation.id)}
                refused={refusals.get(automation.id) ?? null}
                onPick={(how) => pick(automation.id, how)}
                onToggle={(on) => void setEach([automation], on)}
                onDelete={() => setDeleting([automation])}
              />
            ))}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          aria-label={t('listSelect.selected', { count: picked.length })}
          data-testid="automations-menu"
        >
          {one ? (
            <ContextMenuItem
              onSelect={() => router.push(`/studio/automations/${one.id}`)}
              data-testid="menu-open"
            >
              {t('listSelect.open')}
            </ContextMenuItem>
          ) : null}
          {anyOff ? (
            <ContextMenuItem onSelect={() => void setEach(picked, true)} data-testid="menu-turn-on">
              {one
                ? t('listSelect.turnOn')
                : t('listSelect.turnOnMany', {
                    count: picked.filter((a) => a.status !== 'live').length,
                  })}
            </ContextMenuItem>
          ) : null}
          {anyOn ? (
            <ContextMenuItem onSelect={() => void setEach(picked, false)} data-testid="menu-pause">
              {one
                ? t('listSelect.pause')
                : t('listSelect.pauseMany', {
                    count: picked.filter((a) => a.status === 'live').length,
                  })}
            </ContextMenuItem>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem
            tone="danger"
            onSelect={() => setDeleting(picked)}
            data-testid="menu-delete"
          >
            {one ? t('listSelect.delete') : t('listSelect.deleteMany', { count: picked.length })}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <p className={styles.selectHint} data-testid="automations-select-hint">
        {selected.size > 0 ? `${t('listSelect.selected', { count: selected.size })} · ` : ''}
        {t('listSelect.hint', { mod: modLabel() })}
      </p>
      {deleting ? (
        <DeleteAutomation
          targets={deleting.map((a) => ({ id: a.id, name: a.name }))}
          onClose={() => setDeleting(null)}
          onDeleted={(gone) => {
            setItems((now) => now.filter((a) => !gone.includes(a.id)));
            setSelected((now) => new Set([...now].filter((id) => !gone.includes(id))));
            if (gone.length === deleting.length) setDeleting(null);
          }}
        />
      ) : null}
    </>
  );
}

type Refusal = { readonly errors: readonly Issue[] } | 'forbidden' | 'failed';

/** The table's header - static, so it draws before the automations arrive. */
function TableHead() {
  const t = useTranslations('automations');
  return (
    <div className={styles.head} role="row">
      <span role="columnheader">{t('columns.when')}</span>
      <span role="columnheader">{t('columns.flow')}</span>
      <span role="columnheader">{t('columns.week')}</span>
      <span role="columnheader">{t('columns.last')}</span>
      <span role="columnheader" className={styles.visuallyHidden}>
        {t('columns.on')}
      </span>
    </div>
  );
}

/** 09c while the list is read: the header as it is, rows as placeholders. */
export function AutomationsPending() {
  const t = useTranslations('automations');
  return (
    <div
      className={styles.table}
      role="table"
      aria-label={t('title')}
      data-testid="automations-pending"
    >
      <TableHead />
      <SkeletonRows label={t('loading')} rows={4} height={54} />
    </div>
  );
}

function Row({
  automation,
  selected,
  pending,
  refused,
  onPick,
  onToggle,
  onDelete,
}: {
  readonly automation: Automation;
  readonly selected: boolean;
  readonly pending: boolean;
  readonly refused: Refusal | null;
  readonly onPick: (how: { readonly add: boolean; readonly range: boolean }) => void;
  readonly onToggle: (on: boolean) => void;
  readonly onDelete: () => void;
}) {
  const t = useTranslations('automations');
  const format = useFormatter();
  const now = useNow();
  const trigger = automation.trigger.type;
  const live = automation.status === 'live';
  const channels = triggerChannels(automation.trigger);

  /*
   * A click on the row selects it; on the name it opens, as before. With ⌘,
   * Ctrl or Shift it is a pick wherever it lands - the name included, so a
   * modified click never opens a tab instead. The switch and ⋯ are their own.
   */
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest('input, button, [role="menu"]')) return;
    const modified = withMod(event) || event.shiftKey;
    if (!modified && target.closest('a')) return;
    if (modified) event.preventDefault();
    onPick({ add: withMod(event), range: event.shiftKey });
  };

  /** An issue in our words by its code; the route's own sentence only for a code we do not know. */
  const issueText = (issue: Issue | null) =>
    issue === null
      ? t('cantGoLiveUnknown')
      : (ISSUE_CODES as readonly string[]).includes(issue.code)
        ? t(`issues.${issue.code}` as 'issues.no_steps')
        : issue.message || t('cantGoLiveUnknown');

  const href = `/studio/automations/${automation.id}`;
  const lastRun = automation.stats.lastRunAt;

  return (
    <div
      className={styles.row}
      role="row"
      aria-selected={selected}
      data-selected={selected ? '' : undefined}
      data-automation-id={automation.id}
      data-status={automation.status}
      data-testid={`automation-${automation.id}`}
      onClickCapture={onClickCapture}
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
          disabled={pending}
          aria-label={
            live ? t('pause', { name: automation.name }) : t('activate', { name: automation.name })
          }
          onChange={(e) => onToggle(e.target.checked)}
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
              onSelect={onDelete}
              data-testid={`automation-delete-${automation.id}`}
            >
              {t('delete.item')}
            </MenuItem>
          </MenuContent>
        </Menu>
      </span>
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
    /*
     * The shared plate (28) in the trigger tile's 30px slot, so a channel
     * row's name lines up with a trigger row's. Decorative, as the tile was:
     * the automation's name beside it is the row's name.
     */
    return (
      <span className={styles.markSlot}>
        <ChannelPlate channel={channel} size="lg" decorative />
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
