import type { Notification } from '@/api/contracts/notifications';

/**
 * 01d's two filters, from the notification catalogue's own keys
 * (`services/notifications/src/services/event-catalogue.ts`).
 *
 * `eventType` is free text, so only keys the catalogue names are sorted; an
 * unknown one is in "Everything" and in neither filter — never guessed.
 */
const DECISION = new Set(['tool.approval_required', 'conversation.escalated']);
const BROKEN = new Set([
  'tool.action_failed',
  'integration.check_failed',
  'payment.failed',
  'credit.exhausted',
  'credit.auto_purchase_failed',
  'subscription.past_due',
  'subscription.suspended',
]);

export type NotificationKind = 'decision' | 'broken';
export const NOTIFICATION_KINDS = ['decision', 'broken'] as const;

export function kindOf(notification: Notification): NotificationKind | null {
  const type = notification.eventType ?? '';
  return DECISION.has(type) ? 'decision' : BROKEN.has(type) ? 'broken' : null;
}

export function isKind(value: string | undefined): value is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(value ?? '');
}

export type NotificationGroup = 'now' | 'today' | 'earlier';

/** 01d's groups: the last hour, the rest of today, and before. */
export function groupOf(notification: Notification, now: Date): NotificationGroup {
  const at = notification.createdAt ? new Date(notification.createdAt) : null;
  if (!at || Number.isNaN(at.getTime())) return 'earlier';
  if (now.getTime() - at.getTime() < 60 * 60 * 1000) return 'now';
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay ? 'today' : 'earlier';
}
