'use client';

import { Mail, MailOpen, Trash2 } from 'lucide-react';
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

import {
  deleteConversation,
  markConversationRead,
  markConversationUnread,
} from './conversation-actions';
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
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ SWIPE LEFT: MARK UNREAD, OR READ AGAIN (Omer, 2026-11-24, the phone)
 * ════════════════════════════════════════════════════════════════════════════
 * "סמן כלא נקרא" on a read row, "סמן כנקרא" on an unread one. No confirm:
 * it is only a mark, for this person, and the next swipe undoes it.
 *
 * ★ The routes are the menu's: `POST /:id/unread` sets the manual mark,
 *   `DELETE /:id/unread` clears it and moves the read point. Both push
 *   `conversation:updated` to the person's own room, so their other devices
 *   refresh the row and the counts (ListLive, the rail counts).
 * ★ The row turns AT ONCE: the mark is held here until the server's own
 *   answer for the row changes (the refresh after the write), and given back
 *   if the write fails, with the menu's failure line.
 * ★ The map, physical and the same in both languages: right deletes, left
 *   marks. WhatsApp in Hebrew mirrors its list the same way (read actions
 *   from the left swipe, delete from the right), and the delete swipe was
 *   already right in Hebrew.
 * ★ Offered to everyone who reads the list (`read` set), admin or not, and
 *   in support mode too: it changes nothing but the viewer's own mark.
 */

/** How far the row must travel before letting go acts. */
export const SWIPE_THRESHOLD = 80;
const SWIPE_MAX = 120;

type Notice = { readonly text: string; readonly failed: boolean } | null;
const NoticeContext = createContext<(notice: Notice) => void>(() => {});

/**
 * The row's read mark while a swipe's write is on its way: `true` unread,
 * `false` read, `null` the server's own answer. Read by the row's badge.
 */
const ReadOverrideContext = createContext<boolean | null>(null);

export function useReadOverride(): boolean | null {
  return useContext(ReadOverrideContext);
}

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
  read,
  children,
}: {
  readonly id: string;
  /** Not CLOSED: sent with `force`, which the route requires for it. */
  readonly open: boolean;
  /** An admin, on a row that did not continue from the website. */
  readonly enabled: boolean;
  /** The swipe-left read mark (the phone's list): the row's unread, as the server gave it. */
  readonly read?: { readonly unread: boolean };
  readonly children: ReactNode;
}) {
  const refused = useSupport().refuses('delete');
  const canDelete = enabled && !refused;
  // Nothing to swipe for: the row exactly as it was, nothing mounted.
  if (!canDelete && read === undefined) return <>{children}</>;
  return (
    <SwipeRow id={id} open={open} canDelete={canDelete} read={read}>
      {children}
    </SwipeRow>
  );
}

function SwipeRow({
  id,
  open,
  canDelete,
  read,
  children,
}: {
  readonly id: string;
  readonly open: boolean;
  readonly canDelete: boolean;
  readonly read: { readonly unread: boolean } | undefined;
  readonly children: ReactNode;
}) {
  const t = useTranslations('inbox.queue.swipeDelete');
  const tr = useTranslations('inbox.queue.swipeRead');
  const tm = useTranslations('inbox.queue.menu');
  const say = useContext(NoticeContext);
  const [dx, setDx] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const moved = useRef(false);

  /*
   * The swipe's mark, until the server's answer for the row changes. Reset
   * while rendering (not in an effect) so the row never draws a stale mark
   * for a frame after the refresh lands.
   */
  const serverUnread = read?.unread ?? false;
  const [override, setOverride] = useState<boolean | null>(null);
  const [seen, setSeen] = useState(serverUnread);
  if (seen !== serverUnread) {
    setSeen(serverUnread);
    setOverride(null);
  }
  const unread = override ?? serverUnread;

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
    if (Math.abs(x) > 6) moved.current = true;
    const min = read ? -SWIPE_MAX : 0;
    const max = canDelete ? SWIPE_MAX : 0;
    setDx(Math.max(min, Math.min(max, x)));
  };
  const up = () => {
    const deleting = canDelete && dx >= SWIPE_THRESHOLD;
    const marking = read !== undefined && dx <= -SWIPE_THRESHOLD;
    start.current = null;
    setDx(0);
    if (deleting) setConfirming(true);
    if (marking) void toggleRead();
  };

  const toggleRead = async () => {
    const next = !unread;
    setOverride(next);
    const result = next ? await markConversationUnread(id) : await markConversationRead(id);
    if (!result.ok) {
      setOverride(null);
      say({ text: tm('failed'), failed: true });
    }
  };

  const remove = async () => {
    setBusy(true);
    const result = await deleteConversation(id, open);
    setBusy(false);
    setConfirming(false);
    say(result.ok ? { text: t('deleted'), failed: false } : { text: tm('failed'), failed: true });
  };

  const readLabel = unread ? tr('read') : tr('unread');

  return (
    <div
      className={styles.rowDelete}
      data-testid={`row-delete-${id}`}
      data-read-override={override === null ? undefined : override ? 'unread' : 'read'}
    >
      {/* Only while the row is dragged: at rest there is nothing behind it to show (prod, 11-23). */}
      {dx > 0 ? (
        <span
          className={styles.rowDeleteBehind}
          aria-hidden="true"
          data-testid={`row-delete-behind-${id}`}
        >
          <Trash2 size={16} />
          {t('confirm')}
        </span>
      ) : null}
      {/* Swiped left: the mark it will set, as an icon only (the Supervisor's brief). */}
      {dx < 0 ? (
        <span
          className={styles.rowReadBehind}
          aria-hidden="true"
          title={readLabel}
          data-action={unread ? 'read' : 'unread'}
          data-testid={`row-read-behind-${id}`}
        >
          {unread ? <MailOpen size={20} /> : <Mail size={20} />}
        </span>
      ) : null}
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
        <ReadOverrideContext.Provider value={override}>{children}</ReadOverrideContext.Provider>
      </div>
      {canDelete ? (
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
      ) : null}

      {canDelete ? (
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
      ) : null}
    </div>
  );
}
