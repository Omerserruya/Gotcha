'use client';

import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef } from 'react';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { browserApi } from '@/api/client/browser-api';
import { quoteOf } from '@/api/contracts/message-kind';
import { notificationPreferencesSchema } from '@/api/contracts/notifications';
import {
  inboxEndpoints,
  notificationEndpoints,
  workspaceEndpoints,
} from '@/api/endpoints/registry';
import { LOCALE_CODES } from '@/i18n/locales';
import { useRouter } from '@/i18n/navigation';
import { BASE_PATH } from '@/lib/base-path';
import { sharedChime } from '@/lib/inbound-alerts/chime';
import {
  firstLine,
  inQuietHours,
  localHHMM,
  openConversationIn,
  quietTimeZone,
  type QuietWindow,
} from '@/lib/inbound-alerts/decide';
import { AlertElection } from '@/lib/inbound-alerts/election';
import {
  PREFERENCES_CHANGED_EVENT,
  PREFERENCES_CHANNEL,
  desktopPermission,
  readDeviceAlerts,
} from '@/lib/inbound-alerts/settings';
import { personName } from '@/lib/shopper-name';
import { logger } from '@/observability/logger';
import type { RealtimeEvent } from '@/realtime/events';
import { useRealtimeEvent } from '@/realtime/realtime-provider';

import { conversationNotifier } from './desktop-notification';
import { inboundAlerter, type ConversationGlance } from './inbound-alerter';
import { channelIconUrl } from './notification-icon';

/** The three columns the alert reads, and nothing it does not use. */
const glanceSchema = z.object({
  customerName: z.string().nullable().catch(null).default(null),
  customerExternalId: z.string().nullable().catch(null).default(null),
  channel: z.string().nullable().catch(null).default(null),
});

/** The workspace's zone, and whether its business hours have a schedule. */
const zoneSchema = z.object({
  timezone: z.string().nullable().catch(null).default(null),
  hours: z.object({ schedule: z.unknown().optional() }).nullable().catch(null).default(null),
});

/**
 * A chime, and a desktop notification, for an incoming customer message -
 * screen-independent, so it is mounted once around the whole app.
 *
 * Who decides what:
 *   - the per-device switches (Settings · Notifications): `readDeviceAlerts`;
 *   - which tab speaks: `AlertElection` (a Web Lock, and focus broadcast);
 *   - the rules: `planAlert` / `settleAlert`, run by `inboundAlerter`;
 *   - quiet hours: the person's own, read once here and again when they are
 *     saved, in the workspace's time zone - the notifications service's rule.
 */
export function InboundAlerts({ tenantId }: { readonly tenantId: string | null }) {
  const tin = useTranslations('inbox');
  const common = useTranslations('common');
  const locale = useLocale();
  const appZone = useTimeZone() ?? 'Asia/Jerusalem';
  const router = useRouter();

  const election = useRef<AlertElection | null>(null);
  const quiet = useRef<{ window: QuietWindow | null; zone: string }>({
    window: null,
    zone: appZone,
  });

  /* The election, per workspace: tabs of another workspace hear other messages. */
  useEffect(() => {
    if (!tenantId) return;
    const current = new AlertElection(tenantId);
    current.start();
    election.current = current;
    sharedChime().prime();
    return () => {
      current.stop();
      if (election.current === current) election.current = null;
    };
  }, [tenantId]);

  /* Quiet hours: once for this page, and again when the settings page saves them. */
  useEffect(() => {
    if (!tenantId) return;
    let live = true;
    const load = async () => {
      const [preferences, workspace] = await Promise.all([
        browserApi
          .get({
            endpoint: notificationEndpoints.preferences(),
            payload: notificationPreferencesSchema,
          })
          .catch(() => null),
        browserApi
          .get({ endpoint: workspaceEndpoints.read(), payload: zoneSchema })
          .catch(() => null),
      ]);
      if (!live) return;
      quiet.current = {
        // Unread is no window: an alert in quiet hours beats none at all.
        window: preferences?.quietHours ?? null,
        zone: quietTimeZone(
          workspace
            ? { timezone: workspace.timezone, hasSchedule: Boolean(workspace.hours?.schedule) }
            : null,
          appZone,
        ),
      };
    };
    void load();
    const reload = () => void load();
    window.addEventListener(PREFERENCES_CHANGED_EVENT, reload);
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(PREFERENCES_CHANNEL);
      channel.addEventListener('message', reload);
    } catch {
      channel = null;
    }
    return () => {
      live = false;
      window.removeEventListener(PREFERENCES_CHANGED_EVENT, reload);
      channel?.close();
    };
  }, [tenantId, appZone]);

  /*
   * What a popup is written with, current as of the last render. Read when a
   * message arrives - an event, not a render - so the alerter below is made
   * once and keeps its memory (messages heard, the last chime).
   */
  const words = useRef({ tin, common, locale, router });
  useEffect(() => {
    words.current = { tin, common, locale, router };
  });

  const alerter = useRef<((event: RealtimeEvent) => Promise<void>) | null>(null);
  useEffect(() => {
    const notify = conversationNotifier({
      Notification: 'Notification' in window ? window.Notification : undefined,
      focus: () => window.focus(),
      navigate: (href) => words.current.router.push(href),
    });
    const onMessage = inboundAlerter({
      role: () => election.current?.role() ?? 'quiet',
      settings: () => readDeviceAlerts().settings,
      permission: desktopPermission,
      quiet: (now) => {
        const { window: quietWindow, zone } = quiet.current;
        return inQuietHours(quietWindow, localHHMM(now, zone));
      },
      openConversationId: () => openConversationIn(window.location, BASE_PATH, LOCALE_CODES),
      readConversation: readGlance,
      chime: () => sharedChime().play(),
      popup: (alert) => {
        const { tin: t, common: c, locale: lang } = words.current;
        const said = quoteOf({ body: alert.body ?? '', messageType: alert.messageType });
        // Nothing to say is no alert (`planAlert` already held it back).
        if (said === null) return;
        const title = personName(alert.name, (k) => c(`person.${k}`)) ?? t('queue.unnamed');
        // Words, or what was sent instead of words ("Photo"), as the inbox list says it.
        const body = 'text' in said ? firstLine(said.text) : t(`stream.quote.kind.${said.kind}`);
        void channelIconUrl(alert.channel).then((icon) =>
          notify({
            conversationId: alert.conversationId,
            title,
            body,
            icon,
            silent: alert.silent,
            lang,
          }),
        );
      },
      now: () => Date.now(),
    });
    alerter.current = onMessage;
    return () => {
      if (alerter.current === onMessage) alerter.current = null;
    };
  }, []);

  useRealtimeEvent(
    'message.received',
    useCallback((event: RealtimeEvent) => void alerter.current?.(event), []),
  );

  return null;
}

/** The conversation, read as this person: refused means it is not theirs to see. */
async function readGlance(conversationId: string): Promise<ConversationGlance> {
  try {
    const row = await browserApi.get({
      endpoint: inboxEndpoints.conversation(conversationId),
      payload: glanceSchema,
    });
    return {
      access: 'visible',
      // A name, else the handle it arrived on; the caller says "Someone" for neither.
      name: row.customerName?.trim() || row.customerExternalId?.trim() || null,
      channel: row.channel,
    };
  } catch (cause) {
    if (isApiError(cause) && (cause.status === 403 || cause.status === 404)) {
      return { access: 'refused', name: null, channel: null };
    }
    logger.debug?.('inbound_alerts.conversation_read_failed', { cause });
    return { access: 'failed', name: null, channel: null };
  }
}
