'use client';

import { useTranslations } from 'next-intl';

import { wholeUnit } from '@/lib/duration';

import type { AutomationNode, Trigger } from '@/api/contracts/automations';

import { fileNameOf, TRIGGER_NODE } from './graph';
import type { Choices } from './Inspector';
import { needsFilling } from './templates';
import styles from './Builder.module.css';

/** Which of 09e's four groups a step is in - its eyebrow's colour. */
export function groupOf(type: string): 'trigger' | 'logic' | 'send' | 'do' {
  if (type === TRIGGER_NODE) return 'trigger';
  if (type.startsWith('send_')) return 'send';
  if (
    [
      'condition_group',
      'opening_hours',
      'wait',
      'wait_for_reply',
      'split_channel',
      'language',
      'segment',
      'ab_split',
    ].includes(type)
  ) {
    return 'logic';
  }
  return 'do';
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * One step on 09d's canvas: its kind (eyebrow), its name (the author's
 * label, else the step's own), and what it does in a line - or, for a
 * message with buttons, the message as the customer sees it.
 */
export function NodeCard({
  node,
  trigger,
  selected,
  marked,
  issue = null,
  choices = null,
  onSelect,
}: {
  readonly node: AutomationNode;
  /**
   * The names a step's chosen employee, skill, team or person is shown by.
   * `null` (not passed): the type's own line, as before.
   */
  readonly choices?: Choices | null;
  readonly trigger: Trigger;
  readonly selected: boolean;
  /** Named by the last refusal. */
  readonly marked: boolean;
  /** The route's reason this step cannot run here, in our words. */
  readonly issue?: string | null;
  readonly onSelect: () => void;
}) {
  const t = useTranslations('automations');
  const td = useTranslations('common.duration');
  const kind =
    node.type === TRIGGER_NODE
      ? t(`nodes.trigger.${trigger.type ?? 'unknown'}` as 'nodes.trigger.webhook')
      : t(`nodes.${node.type}` as 'nodes.wait');
  const own = str(node.data.label).trim();
  const buttons = Array.isArray(node.data.buttons)
    ? (node.data.buttons as { id?: string; title?: string }[])
    : [];

  return (
    <button
      type="button"
      className={styles.card}
      data-group={groupOf(node.type)}
      aria-pressed={selected}
      data-marked={marked ? '' : undefined}
      onClick={onSelect}
      data-testid={`node-${node.id}`}
    >
      <span className={styles.eyebrow}>
        {t(`eyebrow.${groupOf(node.type)}`)}
        {' · '}
        {kind}
      </span>
      {needsFilling(node) ? (
        // What the author still has to write - a to-do, not an error.
        <span className={styles.toFill} data-testid={`to-fill-${node.id}`}>
          {t('builder.card.toFill')}
        </span>
      ) : null}
      <span className={styles.cardTitle}>
        <bdi dir="auto">{own || kind}</bdi>
      </span>
      {node.type === 'send_buttons' || node.type === 'send_message_text' ? (
        str(node.data.text).trim() ? (
          <span className={styles.bubble}>
            <bdi dir="auto">{str(node.data.text)}</bdi>
          </span>
        ) : (
          <span className={styles.cardLine}>{t('builder.card.empty')}</span>
        )
      ) : (
        <span className={styles.cardLine}>
          {node.type === TRIGGER_NODE
            ? t(`lines.trigger.${trigger.type ?? 'unknown'}` as 'lines.trigger.webhook')
            : summary(node, t, td, choices)}
        </span>
      )}
      {issue ? (
        <span className={styles.cardIssue} data-testid={`issue-${node.id}`}>
          {issue}
        </span>
      ) : null}
      {buttons.length > 0 ? (
        <span className={styles.cardButtons}>
          {buttons.map((b, i) => (
            <span key={b.id ?? i} className={styles.cardButton}>
              <bdi dir="auto">{b.title?.trim() || t('branches.button')}</bdi>
            </span>
          ))}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The name a step's saved id is shown by, or what to say instead: nothing
 * saved, a saved id no option carries, or the options not read.
 */
function chosen(
  options: readonly { readonly id: string; readonly name: string }[] | null | undefined,
  id: unknown,
): { readonly name: string } | 'empty' | 'not_listed' | 'unread' {
  if (typeof id !== 'string' || id === '') return 'empty';
  if (!options) return 'unread';
  const found = options.find((o) => o.id === id);
  return found ? { name: found.name } : 'not_listed';
}

function summary(
  node: AutomationNode,
  t: ReturnType<typeof useTranslations<'automations'>>,
  td: ReturnType<typeof useTranslations<'common.duration'>>,
  choices: Choices | null,
): string {
  const d = node.data;
  /*
   * ★★ WHO THE STEP HANDS TO, ON THE CARD (F2, Omer, 2026-11-09). The setup
   *   route's "Hand to AI employee" card read "Continues in the same chat" -
   *   the type's line - and named nobody, while the step sent every new
   *   conversation to Sheri: "nothing is shown as selected". The card says
   *   the name; the type's line only when the options were not read.
   */
  const named = (
    options: readonly { readonly id: string; readonly name: string }[] | null | undefined,
    id: unknown,
  ) => {
    const c = chosen(options, id);
    if (c === 'empty') return t('builder.card.empty');
    if (c === 'not_listed') return t('inspector.notListed');
    if (c === 'unread') return t(`lines.${node.type}` as 'lines.wait');
    return c.name;
  };
  // In the largest unit it fills whole: "1 day", never "1,440 minutes".
  const duration = (ms: unknown) => {
    if (typeof ms !== 'number' || ms <= 0) return null;
    const { unit, count } = wholeUnit(ms);
    return td(unit, { count });
  };
  switch (node.type) {
    case 'wait': {
      const span = duration(d.durationMs);
      return span === null ? t('builder.card.empty') : t('builder.card.wait', { duration: span });
    }
    case 'wait_for_reply': {
      const span = duration(d.timeoutMs);
      return span === null ? t('builder.card.empty') : t('builder.card.upTo', { duration: span });
    }
    case 'add_tag':
      return str(d.tag) || t('builder.card.empty');
    case 'create_task':
      return str(d.title) || t('builder.card.empty');
    case 'notify_team':
      return str(d.message) || t('builder.card.empty');
    case 'send_message_file':
      return fileNameOf(d) || str(d.url) || t('builder.card.empty');
    case 'hand_to_ai':
      if (choices === null) break;
      return named(choices.employees, d.aiAgentId);
    case 'run_skill':
      if (choices === null) break;
      return named(choices.skills, d.skillId);
    case 'assign':
      if (choices === null) break;
      if (d.to === 'person') return named(choices.members, d.userId);
      if (d.to === 'team') {
        // No team: the human queue nobody owns (Backend: handledBy human, WAITING).
        return str(d.departmentId) === ''
          ? t('builder.card.anyTeam')
          : named(choices.teams, d.departmentId);
      }
      break;
    case 'ab_split':
      return typeof d.percentA === 'number'
        ? t('builder.card.split', { a: d.percentA, b: 100 - d.percentA })
        : t('builder.card.empty');
    default:
      break;
  }
  return t(`lines.${node.type}` as 'lines.wait');
}
