'use client';

import { useTranslations } from 'next-intl';

import type { AutomationNode, Trigger } from '@/api/contracts/automations';

import { TRIGGER_NODE } from './graph';
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
  onSelect,
}: {
  readonly node: AutomationNode;
  readonly trigger: Trigger;
  readonly selected: boolean;
  /** Named by the last refusal. */
  readonly marked: boolean;
  /** The route's reason this step cannot run here, in our words. */
  readonly issue?: string | null;
  readonly onSelect: () => void;
}) {
  const t = useTranslations('automations');
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
            : summary(node, t)}
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

function summary(
  node: AutomationNode,
  t: ReturnType<typeof useTranslations<'automations'>>,
): string {
  const d = node.data;
  const minutes = (ms: unknown) =>
    typeof ms === 'number' && ms > 0 ? Math.round(ms / 60000) : null;
  switch (node.type) {
    case 'wait': {
      const m = minutes(d.durationMs);
      return m === null ? t('builder.card.empty') : t('builder.card.wait', { minutes: m });
    }
    case 'wait_for_reply': {
      const m = minutes(d.timeoutMs);
      return m === null ? t('builder.card.empty') : t('builder.card.upTo', { minutes: m });
    }
    case 'add_tag':
      return str(d.tag) || t('builder.card.empty');
    case 'create_task':
      return str(d.title) || t('builder.card.empty');
    case 'notify_team':
      return str(d.message) || t('builder.card.empty');
    case 'send_message_file':
      return str(d.fileName) || str(d.url) || t('builder.card.empty');
    case 'ab_split':
      return typeof d.percentA === 'number'
        ? t('builder.card.split', { a: d.percentA, b: 100 - d.percentA })
        : t('builder.card.empty');
    default:
      return t(`lines.${node.type}` as 'lines.wait');
  }
}
