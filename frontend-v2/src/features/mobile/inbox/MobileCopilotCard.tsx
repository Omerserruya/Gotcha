'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import { UserText } from '@/design-system/primitives/text/UserText';
import type { CopilotRead } from '@/features/inbox/load-copilot';
import { fillComposer } from '@/features/inbox/reply-event';
import { readSuggestions } from '@/features/inbox/wall/wall-actions';
import { canUse, suggestionView } from '@/features/inbox/wall/wall-model';
import { useConversationRoom, useRealtimeEvent } from '@/realtime/realtime-provider';

import styles from './mobile-inbox.module.css';

/**
 * Copilot's ready reply, as the design draws it above the composer: one dark
 * card, the answer, and the way to use it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE WALL'S READ AND THE WALL'S RULES, ONE CARD AT A TIME
 * ════════════════════════════════════════════════════════════════════════════
 * The same `readSuggestions`, re-read on `copilot.suggestions.updated`, and
 * the same `suggestionView`: a card only when there is a draft to show. Every
 * "nothing" (no employee, the plan, the AI has it) draws nothing here - the
 * website's wall explains them, and on a phone a paragraph above the
 * keyboard about why there is no suggestion is in the way of answering.
 *
 * ★ NOTHING IS SENT FROM HERE. "Use this" and "Edit" put the words in the
 *   composer (`fillComposer`), exactly as the wall's do; the person presses
 *   send. The design's "Send" would be one tap from GOTCHA's words to a
 *   customer, which the product does not do anywhere.
 */
export function MobileCopilotCard({ conversationId }: { readonly conversationId: string }) {
  const t = useTranslations('mobile.copilot');
  const answers = useTranslations('inbox.wall.answers');
  const [read, setRead] = useState<CopilotRead | null>(null);
  const [at, setAt] = useState(0);
  const [used, setUsed] = useState<string | null>(null);
  /*
   * ★ Closed by hand: X hides the card with all its current options. What
   *   Copilot writes later has new ids and shows again (Omer, 2026-11-03). Nothing is written back; the
   *   website's wall still lists it.
   */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [, startTransition] = useTransition();
  const asked = useRef(false);

  const reread = useCallback(() => {
    startTransition(async () => {
      setRead(await readSuggestions(conversationId));
      setAt(0);
    });
  }, [conversationId]);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    reread();
  }, [reread]);

  useConversationRoom(conversationId);
  useRealtimeEvent(
    'copilot.suggestions.updated',
    useCallback(
      (event) => {
        if (event.type !== 'copilot.suggestions.updated') return;
        if (event.conversationId !== conversationId) return;
        reread();
      },
      [conversationId, reread],
    ),
  );

  const view = read === null ? null : suggestionView(read);
  const cards =
    view?.kind === 'cards' ? view.suggestions.filter((s) => canUse(s) && !dismissed.has(s.id)) : [];
  const card = cards[at % Math.max(cards.length, 1)];
  if (card === undefined || card.id === used) return null;
  const others = cards.length - 1;

  const use = (select: boolean) => {
    fillComposer(card.text, { select });
    setUsed(card.id);
  };

  return (
    <section className={styles.copilot} aria-label={t('label')} data-testid="mobile-copilot">
      <div className={styles.copilotHead}>
        <span className={styles.copilotTitle}>
          <span className={styles.copilotDot} aria-hidden="true" />
          {t('ready')}
        </span>
        {others > 0 ? (
          <button
            type="button"
            className={styles.copilotMore}
            data-testid="mobile-copilot-next"
            onClick={() => setAt((i) => i + 1)}
          >
            {t('more', { count: others })}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.copilotClose}
          aria-label={t('dismiss')}
          data-testid="mobile-copilot-dismiss"
          onClick={() => {
            // The whole card: every option on it now, not only the one shown.
            setDismissed((now) => new Set([...now, ...cards.map((c) => c.id)]));
            setAt(0);
          }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <UserText className={styles.copilotText}>{card.text}</UserText>
      <div className={styles.copilotActions}>
        <button
          type="button"
          className={styles.copilotUse}
          title={answers('useTitle')}
          data-testid="mobile-copilot-use"
          onClick={() => use(false)}
        >
          {answers('use')}
        </button>
        <button
          type="button"
          className={styles.copilotEdit}
          title={answers('editTitle')}
          data-testid="mobile-copilot-edit"
          onClick={() => use(true)}
        >
          {answers('edit')}
        </button>
      </div>
    </section>
  );
}
