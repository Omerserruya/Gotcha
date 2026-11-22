'use client';

import { Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  createContext,
  useContext,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react';

import { Dialog, DialogClose, DialogContent } from '@/design-system/primitives/overlay/Dialog';
import { useSupport } from '@/support/support-context';

import { deleteConversation } from './conversation-actions';
import styles from './Inbox.module.css';

/**
 * Swipe right to delete a conversation (Omer, 2026-11-22): on touch, on the
 * phone's list and the main inbox; on a pointer that hovers, a quiet trash
 * button on the row. Either way it asks first, every time.
 *
 * ★ `DELETE /conversations/:id` (services/conversation routes/conversations.ts):
 *   ADMIN and SYSTEM_ADMIN only - so `enabled` is decided by the list from
 *   the viewer's role - and it deletes the conversation and its messages in
 *   one transaction. Open or closed alike: an open one goes with `force`
 *   (the Supervisor, Omer's own case is an open personal chat).
 * ★ Not on a thread that continued from the website (W1): its web part is a
 *   separate, archived conversation that this would not delete, and the
 *   confirm would promise more than happens. The list passes `enabled` false.
 * ★ Never in support mode (the platform refuses support_denied:delete).
 * ★ "Right" is the hand's direction on the glass, in Hebrew too.
 */

/** How far the row must travel before letting go opens the confirm. */
export const SWIPE_THRESHOLD = 80;
const SWIPE_MAX = 120;

type Notice = { readonly text: string; readonly failed: boolean } | null;
const NoticeContext = createContext<(notice: Notice) => void>(() => {});

/**
 * Where "deleted" (or why not) is said: around the list, because the row
 * itself leaves on success. The queue menu's notice, in its place.
 */
export function RowDeleteNotices({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const [notice, setNotice] = useState<Notice>(null);
  return (
    <NoticeContext.Provider value={setNotice}>
      {notice ? (
        <p
          className={className}
          role={notice.failed ? 'alert' : 'status'}
          data-testid="row-delete-notice"
        >
          {notice.text}
        </p>
      ) : null}
      {children}
    </NoticeContext.Provider>
  );
}

export function RowDelete({
  id,
  open,
  enabled,
  children,
}: {
  readonly id: string;
  /** Not CLOSED: sent with `force`, which the route requires for it. */
  readonly open: boolean;
  /** An admin, on a row that did not continue from the website. */
  readonly enabled: boolean;
  readonly children: ReactNode;
}) {
  const refused = useSupport().refuses('delete');
  // Nothing to delete with: the row exactly as it was, nothing mounted.
  if (!enabled || refused) return <>{children}</>;
  return (
    <SwipeDelete id={id} open={open}>
      {children}
    </SwipeDelete>
  );
}

function SwipeDelete({
  id,
  open,
  children,
}: {
  readonly id: string;
  readonly open: boolean;
  readonly children: ReactNode;
}) {
  const t = useTranslations('inbox.queue.swipeDelete');
  const tm = useTranslations('inbox.queue.menu');
  const say = useContext(NoticeContext);
  const [dx, setDx] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const moved = useRef(false);

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse') return;
    start.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
    moved.current = false;
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    if (!from || from.id !== event.pointerId) return;
    const x = event.clientX - from.x;
    const y = event.clientY - from.y;
    // A vertical gesture is the list scrolling: let it go.
    if (!moved.current && Math.abs(y) > Math.abs(x)) {
      start.current = null;
      return;
    }
    if (x > 6) moved.current = true;
    setDx(Math.max(0, Math.min(SWIPE_MAX, x)));
  };
  const up = () => {
    const far = dx >= SWIPE_THRESHOLD;
    start.current = null;
    setDx(0);
    if (far) setConfirming(true);
  };

  const remove = async () => {
    setBusy(true);
    const result = await deleteConversation(id, open);
    setBusy(false);
    setConfirming(false);
    say(result.ok ? { text: t('deleted'), failed: false } : { text: tm('failed'), failed: true });
  };

  return (
    <div className={styles.rowDelete} data-testid={`row-delete-${id}`}>
      <span className={styles.rowDeleteBehind} aria-hidden="true">
        <Trash2 size={16} />
        {t('confirm')}
      </span>
      <div
        className={styles.rowDeleteFront}
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        data-swiping={dx ? '' : undefined}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onClickCapture={(event) => {
          // A swipe is not a tap: it never also opens the conversation.
          if (moved.current) {
            event.preventDefault();
            event.stopPropagation();
            moved.current = false;
          }
        }}
      >
        {children}
      </div>
      <button
        type="button"
        className={styles.rowDeleteHover}
        aria-label={t('confirm')}
        title={t('confirm')}
        onClick={() => setConfirming(true)}
        data-testid={`row-delete-button-${id}`}
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>

      <Dialog open={confirming} onOpenChange={(next) => (busy ? null : setConfirming(next))}>
        <DialogContent
          title={t('title')}
          description={t('body')}
          data-testid={`row-delete-confirm-${id}`}
        >
          <div className={styles.confirmActions}>
            <DialogClose asChild>
              <button
                type="button"
                className={styles.verbButton}
                disabled={busy}
                data-testid="row-delete-cancel"
              >
                {t('cancel')}
              </button>
            </DialogClose>
            <button
              type="button"
              className={styles.confirmDanger}
              disabled={busy}
              onClick={() => void remove()}
              data-testid="row-delete-go"
            >
              {t('confirm')}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
