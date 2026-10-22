import { inboxHref, notificationTag } from '@/lib/inbound-alerts/decide';

/**
 * One desktop notification for one conversation.
 *
 * ★ REPLACED, NEVER STACKED. `tag: conv:<id>` makes the platform replace a
 *   notification still showing for the same conversation; the one this tab
 *   showed is also closed first, so the replacement appears again instead of
 *   updating quietly in the notification centre.
 *
 * A click brings this tab forward and opens the conversation, through the
 * locale-aware router (it adds the locale and the `/v2` mount point).
 *
 * `new Notification` throws on a platform that only allows them from a
 * service worker (Chrome on Android); that is caught - nothing shows.
 */
export interface ConversationNotice {
  readonly conversationId: string;
  readonly title: string;
  readonly body: string;
  readonly icon: string | undefined;
  readonly silent: boolean;
  readonly lang: string;
}

export interface NotificationEnvironment {
  readonly Notification: typeof Notification | undefined;
  readonly focus: () => void;
  readonly navigate: (href: `/inbox?c=${string}`) => void;
}

export function conversationNotifier(env: NotificationEnvironment) {
  const showing = new Map<string, Notification>();

  return function show(notice: ConversationNotice): Notification | null {
    if (!env.Notification) return null;
    const { conversationId } = notice;
    try {
      showing.get(conversationId)?.close();
      const shown = new env.Notification(notice.title, {
        body: notice.body,
        tag: notificationTag(conversationId),
        icon: notice.icon,
        silent: notice.silent,
        dir: 'auto',
        lang: notice.lang,
      });
      shown.onclick = (event) => {
        event.preventDefault();
        env.focus();
        env.navigate(inboxHref(conversationId));
        shown.close();
      };
      shown.onclose = () => {
        if (showing.get(conversationId) === shown) showing.delete(conversationId);
      };
      showing.set(conversationId, shown);
      return shown;
    } catch {
      return null;
    }
  };
}
