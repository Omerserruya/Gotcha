'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { browserApi } from '@/api/client/browser-api';
import { quoteOf } from '@/api/contracts/message-kind';
import { inboxEndpoints } from '@/api/endpoints/registry';
import { usePathname, useRouter } from '@/i18n/navigation';
import { firstLine } from '@/lib/inbound-alerts/decide';
import { personName } from '@/lib/shopper-name';
import type { RealtimeEvent } from '@/realtime/events';
import { useRealtimeEvent } from '@/realtime/realtime-provider';

import { openPhoneConversation, wantsBanner, type BannerGlance } from './inbound-banner';
import styles from './MobileShell.module.css';

const rowSchema = z.object({
  customerName: z.string().nullable().catch(null).default(null),
  customerExternalId: z.string().nullable().catch(null).default(null),
  assignedAgentId: z.string().nullable().catch(null).default(null),
});

/** How long a banner stays before it goes by itself. */
const SHOWN_MS = 5000;

interface Banner {
  readonly conversationId: string;
  readonly messageId: string;
  readonly title: string;
  readonly body: string;
}

/**
 * ★ AN INCOMING MESSAGE, SAID INSIDE THE APP (Omer, 2026-11-04). Push reaches
 *   the phone when the app is in the background; with it open, a banner at
 *   the top: who wrote and the first line, tap to open the conversation.
 *   Only a conversation that is the viewer's or nobody's (`wantsBanner`), and
 *   never the one already on screen.
 */
export function MobileInboundBanner({ meId }: { readonly meId: string | null }) {
  const tin = useTranslations('inbox');
  const common = useTranslations('common');
  const router = useRouter();
  const pathname = usePathname();
  const [banner, setBanner] = useState<Banner | null>(null);
  const heard = useRef(new Set<string>());
  const where = useRef(pathname);
  const words = useRef({ tin, common });
  useEffect(() => {
    where.current = pathname;
    words.current = { tin, common };
  });

  // Gone by itself after a while; a new one restarts the wait.
  useEffect(() => {
    if (banner === null) return;
    const timer = window.setTimeout(() => setBanner(null), SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [banner]);

  useRealtimeEvent(
    'message.received',
    useCallback(
      (event: RealtimeEvent) => {
        if (event.type !== 'message.received' || event.direction !== 'INBOUND') return;
        if (heard.current.has(event.messageId)) return;
        heard.current.add(event.messageId);
        const said = quoteOf({ body: event.body ?? '', messageType: event.messageType ?? null });
        if (said === null) return;
        void (async () => {
          let glance: BannerGlance = { access: 'failed', assignedAgentId: null };
          let name: string | null = null;
          try {
            const row = await browserApi.get({
              endpoint: inboxEndpoints.conversation(event.conversationId),
              payload: rowSchema,
            });
            glance = { access: 'visible', assignedAgentId: row.assignedAgentId };
            name = row.customerName?.trim() || row.customerExternalId?.trim() || null;
          } catch (cause) {
            if (isApiError(cause) && (cause.status === 403 || cause.status === 404)) {
              glance = { access: 'refused', assignedAgentId: null };
            }
          }
          const show = wantsBanner({
            direction: event.direction,
            conversationId: event.conversationId,
            openId: openPhoneConversation(where.current),
            glance,
            meId,
          });
          if (!show) return;
          const { tin: t, common: c } = words.current;
          setBanner({
            conversationId: event.conversationId,
            messageId: event.messageId,
            title: personName(name, (k) => c(`person.${k}`)) ?? t('queue.unnamed'),
            body: 'text' in said ? firstLine(said.text) : t(`stream.quote.kind.${said.kind}`),
          });
        })();
      },
      [meId],
    ),
  );

  // Opening the conversation it is about takes it away.
  if (banner === null || openPhoneConversation(pathname) === banner.conversationId) return null;
  return (
    <div className={styles.banner} role="status" data-testid="mobile-inbound-banner">
      <button
        type="button"
        className={styles.bannerOpen}
        data-testid="mobile-inbound-banner-open"
        onClick={() => {
          setBanner(null);
          router.push(`/m/inbox/${encodeURIComponent(banner.conversationId)}` as '/m/inbox');
        }}
      >
        <span className={styles.bannerTitle} dir="auto">
          {banner.title}
        </span>
        <span className={styles.bannerBody} dir="auto">
          {banner.body}
        </span>
      </button>
      <button
        type="button"
        className={styles.bannerClose}
        aria-label={tin('bannerClose')}
        data-testid="mobile-inbound-banner-close"
        onClick={() => setBanner(null)}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
