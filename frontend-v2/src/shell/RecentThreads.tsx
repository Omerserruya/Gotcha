'use client';

import { MoreHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { browserApi } from '@/api/client/browser-api';
import {
  THREADS_CHANGED,
  threadListSchema,
  threadSchema,
  type ThreadListItem,
  type ThreadsChange,
} from '@/api/contracts/assistant-threads';
import { assistantEndpoints } from '@/api/endpoints/registry';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/design-system/primitives/overlay/ContextMenu';
import { Dialog, DialogContent } from '@/design-system/primitives/overlay/Dialog';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/design-system/primitives/overlay/Menu';
import { Link, usePathname } from '@/i18n/navigation';
import { logger } from '@/observability/logger';

import styles from './AppShell.module.css';

/** The rail shows the latest few; the rest wait for a full history (stage 2). */
export const RECENT_LIMIT = 5;

/** A title the route keeps: 1-120 characters (§2). */
const TITLE_MAX = 120;

/**
 * ★ Recent (design 7, 01a): "Chats are saved under Recent. Home is one click
 * back." The person's own threads, newest first - a thread is its owner's
 * only. Read again whenever one is made, titled, renamed or deleted.
 *
 * ★ Home's only (Omer, 2026-10-08): on every other screen the rail does not
 *   draw it - and does not read it.
 *
 * Absent rather than empty: no threads yet, or a list that could not be
 * read, draws nothing - the rail is not where a failure is reported, and
 * the conversation itself says when it cannot open.
 */
export function RecentThreads() {
  return usePathname() === '/home' ? <RecentList /> : null;
}

function RecentList() {
  const t = useTranslations('navigation');
  // The one open now is marked.
  const open = useSearchParams()?.get('thread') ?? null;
  const [threads, setThreads] = useState<readonly ThreadListItem[]>([]);
  const [deleting, setDeleting] = useState<ThreadListItem | null>(null);

  useEffect(() => {
    let live = true;
    const read = () =>
      void browserApi
        .get({
          endpoint: assistantEndpoints.threads(),
          query: { limit: RECENT_LIMIT },
          payload: threadListSchema,
          raw: true,
        })
        .then((list) => {
          if (live) setThreads(list.data);
        })
        .catch((cause: unknown) => logger.warn('shell.recent_threads_failed', { cause }));
    read();
    window.addEventListener(THREADS_CHANGED, read);
    return () => {
      live = false;
      window.removeEventListener(THREADS_CHANGED, read);
    };
  }, []);

  const renamed = (id: string, title: string) =>
    setThreads((all) => all.map((it) => (it.id === id ? { ...it, title } : it)));

  return (
    <>
      {threads.length === 0 ? null : (
        <nav className={styles.subNavGroup} aria-label={t('recent')} data-testid="recent-threads">
          <span className={styles.subNavLabel} aria-hidden="true">
            {t('recent')}
          </span>
          <ul className={styles.subNavList} role="list">
            {threads.map((thread) => (
              <RecentRow
                key={thread.id}
                thread={thread}
                current={open === thread.id}
                onRenamed={(title) => renamed(thread.id, title)}
                onDelete={() => setDeleting(thread)}
              />
            ))}
          </ul>
        </nav>
      )}
      {deleting ? (
        <DeleteThread
          thread={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            setThreads((all) => all.filter((it) => it.id !== deleting.id));
          }}
        />
      ) : null}
    </>
  );
}

/**
 * One thread: its link, and a menu - ⋯ on hover or focus, and the same menu
 * on a right-click. Shift+F10 and the menu key reach it too: on a focused
 * row the browser fires `contextmenu` for both (measured in Chromium).
 */
function RecentRow({
  thread,
  current,
  onRenamed,
  onDelete,
}: {
  readonly thread: ThreadListItem;
  readonly current: boolean;
  readonly onRenamed: (title: string) => void;
  readonly onDelete: () => void;
}) {
  const t = useTranslations('navigation');
  const titles = useTranslations('home.conversation.title');
  const [editing, setEditing] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const shown = thread.title ?? t('untitled');

  if (editing !== null) {
    const save = async () => {
      const title = editing.trim();
      if (!title || title === thread.title) {
        setEditing(null);
        return;
      }
      try {
        const saved = await browserApi.patch({
          endpoint: assistantEndpoints.thread(thread.id),
          body: { title },
          payload: threadSchema,
        });
        const kept = saved.title ?? title;
        onRenamed(kept);
        setEditing(null);
        setFailed(false);
        announce({ id: thread.id, title: kept });
      } catch (cause) {
        logger.warn('shell.recent_rename_failed', { cause });
        setFailed(true);
      }
    };
    return (
      <li className={styles.recentEdit}>
        <input
          className={styles.recentInput}
          value={editing}
          maxLength={TITLE_MAX}
          dir="auto"
          aria-label={titles('label')}
          aria-invalid={failed || undefined}
          // The person just asked to rename it.
          autoFocus
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void save();
            } else if (e.key === 'Escape') {
              setFailed(false);
              setEditing(null);
            }
          }}
          onBlur={() => void save()}
          data-testid={`recent-title-input-${thread.id}`}
        />
        {failed ? (
          <span
            className={styles.recentProblem}
            role="alert"
            data-testid={`recent-title-failed-${thread.id}`}
          >
            {titles('failed')}
          </span>
        ) : null}
      </li>
    );
  }

  const rename = () => {
    setFailed(false);
    setEditing(thread.title ?? '');
  };
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className={styles.recentRow} data-testid={`recent-row-${thread.id}`}>
            <Link
              href={{ pathname: '/home', query: { thread: thread.id } }}
              className={styles.subNavLink}
              aria-current={current ? 'page' : undefined}
              data-testid={`recent-${thread.id}`}
            >
              <bdi dir="auto" className={styles.recentTitle}>
                {shown}
              </bdi>
            </Link>
            <Menu>
              <MenuTrigger asChild>
                <button
                  type="button"
                  className={styles.recentMore}
                  aria-label={t('recentMenu.more', { title: shown })}
                  data-testid={`recent-more-${thread.id}`}
                >
                  <MoreHorizontal size={14} aria-hidden="true" />
                </button>
              </MenuTrigger>
              {/* The input takes the focus; the menu must not hand it back to ⋯. */}
              <MenuContent
                onCloseAutoFocus={(e) => e.preventDefault()}
                data-testid={`recent-menu-${thread.id}`}
              >
                <MenuItem onSelect={rename} data-testid={`recent-rename-${thread.id}`}>
                  {t('recentMenu.rename')}
                </MenuItem>
                <MenuItem
                  tone="danger"
                  onSelect={onDelete}
                  data-testid={`recent-delete-${thread.id}`}
                >
                  {t('recentMenu.delete')}
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(e) => e.preventDefault()}
          data-testid={`recent-context-${thread.id}`}
        >
          <ContextMenuItem onSelect={rename} data-testid={`recent-context-rename-${thread.id}`}>
            {t('recentMenu.rename')}
          </ContextMenuItem>
          <ContextMenuItem
            tone="danger"
            onSelect={onDelete}
            data-testid={`recent-context-delete-${thread.id}`}
          >
            {t('recentMenu.delete')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

/**
 * Home's own confirmation, word for word. Deleting the thread Home shows is
 * the live Home again (Home hears it); any other just leaves the list.
 */
function DeleteThread({
  thread,
  onClose,
  onDeleted,
}: {
  readonly thread: ThreadListItem;
  readonly onClose: () => void;
  readonly onDeleted: () => void;
}) {
  const t = useTranslations('home.conversation.delete');
  const [state, setState] = useState<'idle' | 'deleting' | 'failed'>('idle');
  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent title={t('title')} description={t('what')} data-testid="recent-delete-dialog">
        {state === 'failed' ? (
          <p className={styles.recentProblem} role="alert" data-testid="recent-delete-failed">
            {t('failed')}
          </p>
        ) : null}
        <span className={styles.dialogActions}>
          <button type="button" className={styles.dialogQuiet} onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            type="button"
            className={styles.dialogDanger}
            disabled={state === 'deleting'}
            onClick={async () => {
              setState('deleting');
              try {
                await browserApi.delete({
                  endpoint: assistantEndpoints.thread(thread.id),
                  payload: z.unknown(),
                });
              } catch (cause) {
                logger.warn('shell.recent_delete_failed', { cause });
                setState('failed');
                return;
              }
              onDeleted();
              announce({ id: thread.id, deleted: true });
            }}
            data-testid="recent-delete-yes"
          >
            {state === 'deleting' ? t('deleting') : t('yes')}
          </button>
        </span>
      </DialogContent>
    </Dialog>
  );
}

function announce(change: ThreadsChange) {
  window.dispatchEvent(new CustomEvent<ThreadsChange>(THREADS_CHANGED, { detail: change }));
}
