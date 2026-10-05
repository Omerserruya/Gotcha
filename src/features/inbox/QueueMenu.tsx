'use client';

import { Bot, Check, CornerUpLeft, Hand, Trash2, UserPlus, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type MouseEvent, type ReactNode } from 'react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/design-system/primitives/overlay/ContextMenu';
import { Dialog, DialogClose, DialogContent } from '@/design-system/primitives/overlay/Dialog';

import {
  claimConversation,
  closeConversation,
  deleteConversation,
  releaseConversation,
  returnToAi,
  transferConversation,
  type VerbResult,
} from './conversation-actions';
import { menuPlan, type MenuRow } from './queue-menu-rules';
import { clearSelected, currentSelection, useSelection } from './queue-selection';
import styles from './Inbox.module.css';

/**
 * 02's right-click menu on the queue — and shift-click to pick several.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ WHAT IT ACTS ON
 * ════════════════════════════════════════════════════════════════════════════
 * Right-click a row that is part of the shift-click selection: the menu acts
 * on the whole selection. Right-click any other row: on that row alone, and
 * the selection is let go. What each item may do is `menuPlan`'s, which
 * follows the routes' own rules; an item is drawn only when it has targets.
 *
 * ⚠ The menu is never an action's only way in: Take control, Resolve and
 *   Transfer are in the conversation header too (the primitive's own rule).
 *
 * ⚠⚠ ASSIGNING GREETS THE CUSTOMER. Claim and reassign both enqueue the
 *    workspace's greeting on the customer's channel. The items say so before
 *    they are pressed, as the header's "Take control" does.
 */
export function QueueMenu({
  rows,
  meId,
  role,
  colleagues,
  greeting,
  children,
}: {
  readonly rows: readonly MenuRow[];
  readonly meId: string | null;
  readonly role: string | null;
  readonly colleagues: readonly { readonly id: string; readonly name: string }[];
  /** Does the workspace greet on assignment? `null` = we could not ask. */
  readonly greeting: boolean | null;
  readonly children: ReactNode;
}) {
  const t = useTranslations('inbox.queue.menu');
  const problems = useTranslations('inbox.verbs.problem');
  const selection = useSelection();
  const [targets, setTargets] = useState<readonly MenuRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const plan = menuPlan(targets, { meId, role, hasColleagues: colleagues.length > 0 });
  const byId = (ids: readonly string[]) => targets.filter((row) => ids.includes(row.id));

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const row = (event.target as Element).closest<HTMLElement>('[data-conversation-id]');
    const id = row?.dataset.conversationId ?? null;
    const picked = currentSelection();
    /*
     * Nothing under the pointer and nothing picked: there is nothing to act
     * on, so no menu at all — not an empty one.
     */
    if (id === null && picked.length === 0) {
      event.preventDefault();
      return;
    }
    let ids: readonly string[];
    if (id !== null && !picked.includes(id)) {
      clearSelected();
      ids = [id];
    } else {
      ids = picked;
    }
    setNotice(null);
    setTargets(rows.filter((it) => ids.includes(it.id)));
  };

  /** Run one action over its targets, and say how it went. */
  const run = async (ids: readonly string[], action: (id: string) => Promise<VerbResult>) => {
    setBusy(true);
    setNotice(null);
    let done = 0;
    let last: VerbResult | null = null;
    for (const id of ids) {
      try {
        last = await action(id);
      } catch {
        last = { ok: false, reason: 'failed' };
      }
      if (last.ok) done += 1;
    }
    setBusy(false);
    clearSelected();
    if (done === ids.length) return;
    if (ids.length === 1 && last && !last.ok) {
      setNotice(problems(last.reason as 'failed'));
    } else {
      setNotice(done === 0 ? t('failed') : t('partial', { done, total: ids.length }));
    }
  };

  const greets = greeting === true ? t('greets') : greeting === null ? t('greetsMaybe') : null;
  const removing = byId(plan.remove);
  const stillOpen = removing.filter((row) => row.status !== 'CLOSED').length;

  const anyFirst =
    plan.assignToMe.length +
      plan.assignToSomeone.length +
      plan.release.length +
      plan.stopAi.length +
      plan.backToAi.length >
    0;
  const anySecond = plan.resolve.length > 0;

  return (
    <>
      {selection.length > 0 ? (
        <p className={styles.queueNotice} data-testid="queue-selection" role="status">
          {t('selected', { count: selection.length })}{' '}
          <button
            type="button"
            className={styles.queueNoticeAction}
            onClick={() => clearSelected()}
          >
            {t('clearSelection')}
          </button>
        </p>
      ) : null}
      {notice ? (
        <p className={styles.queueNotice} data-testid="queue-menu-notice" role="status">
          {notice}
        </p>
      ) : null}

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div onContextMenu={onContextMenu} data-testid="queue-menu-area">
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent appearance="dark" aria-label={t('label')} data-testid="queue-menu">
          {plan.assignToMe.length > 0 ? (
            <ContextMenuItem
              data-testid="menu-assign-me"
              disabled={busy}
              onSelect={() => void run(plan.assignToMe, claimConversation)}
            >
              <UserPlus size={13} aria-hidden="true" />
              <span className={styles.menuText}>
                {t('assignToMe')}
                {greets ? <span className={styles.menuHint}>{greets}</span> : null}
              </span>
            </ContextMenuItem>
          ) : null}

          {plan.assignToSomeone.length > 0 ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger data-testid="menu-assign-someone" disabled={busy}>
                <Users size={13} aria-hidden="true" />
                {t('assignToSomeone')}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent appearance="dark">
                {colleagues.map((colleague) => (
                  <ContextMenuItem
                    key={colleague.id}
                    data-testid={`menu-assign-${colleague.id}`}
                    onSelect={() =>
                      void run(plan.assignToSomeone, (id) => transferConversation(id, colleague.id))
                    }
                  >
                    <span className={styles.menuText}>
                      {colleague.name}
                      {greets ? <span className={styles.menuHint}>{greets}</span> : null}
                    </span>
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          ) : null}

          {plan.release.length > 0 ? (
            <ContextMenuItem
              data-testid="menu-release"
              disabled={busy}
              onSelect={() => void run(plan.release, releaseConversation)}
            >
              <CornerUpLeft size={13} aria-hidden="true" />
              {t('release')}
            </ContextMenuItem>
          ) : null}

          {/* Omer: Stop AI on what the AI is driving; Back to the AI once taken. */}
          {plan.stopAi.length > 0 ? (
            <ContextMenuItem
              data-testid="menu-stop-ai"
              disabled={busy}
              onSelect={() => void run(plan.stopAi, claimConversation)}
            >
              <Hand size={13} aria-hidden="true" />
              {t('stopAi')}
            </ContextMenuItem>
          ) : null}

          {plan.backToAi.length > 0 ? (
            <ContextMenuItem
              data-testid="menu-back-to-ai"
              disabled={busy}
              onSelect={() => void run(plan.backToAi, returnToAi)}
            >
              <Bot size={13} aria-hidden="true" />
              {t('backToAi')}
            </ContextMenuItem>
          ) : null}

          {anyFirst && anySecond ? <ContextMenuSeparator /> : null}

          {plan.resolve.length > 0 ? (
            <ContextMenuItem
              data-testid="menu-resolve"
              disabled={busy}
              onSelect={() => void run(plan.resolve, closeConversation)}
            >
              <Check size={13} aria-hidden="true" />
              {t('resolve')}
            </ContextMenuItem>
          ) : null}

          {plan.remove.length > 0 ? (
            <>
              {anyFirst || anySecond ? <ContextMenuSeparator /> : null}
              {/* ⚠⚠ Irreversible: it asks first, every time. */}
              <ContextMenuItem
                tone="danger"
                data-testid="menu-delete"
                disabled={busy}
                onSelect={() => setConfirming(true)}
              >
                <Trash2 size={13} aria-hidden="true" />
                {t('remove')}
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent
          title={t('confirmTitle', { count: removing.length })}
          description={t('confirmBody', { count: removing.length })}
          data-testid="queue-delete-confirm"
        >
          {stillOpen > 0 ? (
            <p className={styles.confirmNote}>{t('confirmActive', { count: stillOpen })}</p>
          ) : null}
          <div className={styles.confirmActions}>
            <DialogClose asChild>
              <button type="button" className={styles.verbButton} data-testid="queue-delete-cancel">
                {t('cancel')}
              </button>
            </DialogClose>
            <button
              type="button"
              className={styles.confirmDanger}
              data-testid="queue-delete-confirm-button"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                /*
                 * Omer's ruling: deleting an active conversation forces. A
                 * CLOSED one is deleted without it, which is what the route
                 * expects.
                 */
                void run(
                  removing.map((row) => row.id),
                  (id) =>
                    deleteConversation(
                      id,
                      removing.find((row) => row.id === id)?.status !== 'CLOSED',
                    ),
                );
              }}
            >
              {t('confirm')}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
