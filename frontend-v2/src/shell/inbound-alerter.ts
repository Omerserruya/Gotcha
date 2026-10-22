import { quoteOf } from '@/api/contracts/message-kind';
import type { RealtimeEvent } from '@/realtime/events';
import {
  planAlert,
  settleAlert,
  type ConversationAccess,
  type TabRole,
} from '@/lib/inbound-alerts/decide';
import type { DesktopPermission, DeviceAlertSettings } from '@/lib/inbound-alerts/settings';

/**
 * What happens when a message arrives, with the browser passed in: the rules
 * are `planAlert` / `settleAlert`; this is their order, and the memory they
 * need (which messages were heard, when this tab last chimed).
 */

/** What the conversation read gives: whether this person may see it, and what to call it. */
export interface ConversationGlance {
  readonly access: ConversationAccess;
  readonly name: string | null;
  readonly channel: string | null;
}

export interface AlerterDeps {
  role(): TabRole;
  settings(): DeviceAlertSettings;
  permission(): DesktopPermission;
  /** Inside the person's quiet hours at this instant. */
  quiet(now: Date): boolean;
  openConversationId(): string | null;
  readConversation(conversationId: string): Promise<ConversationGlance>;
  /** Plays the chime; false when the browser would not. */
  chime(): boolean;
  popup(alert: {
    readonly conversationId: string;
    readonly name: string | null;
    readonly channel: string | null;
    readonly body: string | null;
    readonly messageType: string | null;
    /** Our chime already sounded: the notification need not make its own. */
    readonly silent: boolean;
  }): void;
  now(): number;
}

/** How many message ids are remembered: a frame announced twice alerts once. */
const SEEN_LIMIT = 200;

export function inboundAlerter(deps: AlerterDeps) {
  const seen = new Set<string>();
  let lastChimeAt: number | null = null;

  return async function onMessage(event: RealtimeEvent): Promise<void> {
    if (event.type !== 'message.received') return;
    if (seen.has(event.messageId)) return;
    seen.add(event.messageId);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);

    const plan = planAlert({
      direction: event.direction,
      messageType: event.messageType,
      hasContent: quoteOf({ body: event.body ?? '', messageType: event.messageType }) !== null,
      conversationId: event.conversationId,
      role: deps.role(),
      openConversationId: deps.openConversationId(),
      settings: deps.settings(),
      permission: deps.permission(),
      quiet: deps.quiet(new Date(deps.now())),
    });
    // Nothing to do: the conversation is not read at all.
    if (!plan.sound && !plan.popup) return;

    /*
     * The socket's tenant room carries every message in the workspace. The
     * conversation read is the same visibility rule as the inbox list: refused
     * (404 for a conversation of another department) means not this person's.
     */
    const glance = await deps.readConversation(event.conversationId);
    const settled = settleAlert(plan, {
      access: glance.access,
      now: deps.now(),
      lastChimeAt,
    });

    let chimed = false;
    if (settled.sound && deps.chime()) {
      chimed = true;
      lastChimeAt = deps.now();
    }
    if (settled.popup) {
      deps.popup({
        conversationId: event.conversationId,
        name: glance.name,
        channel: glance.channel,
        body: event.body ?? null,
        messageType: event.messageType ?? null,
        silent: chimed,
      });
    }
  };
}
