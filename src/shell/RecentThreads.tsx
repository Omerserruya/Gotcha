'use client';

import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { browserApi } from '@/api/client/browser-api';
import {
  THREADS_CHANGED,
  threadListSchema,
  type ThreadListItem,
} from '@/api/contracts/assistant-threads';
import { assistantEndpoints } from '@/api/endpoints/registry';
import { Link, usePathname } from '@/i18n/navigation';
import { logger } from '@/observability/logger';

import styles from './AppShell.module.css';

/** The rail shows the latest few; the rest wait for a full history (stage 2). */
export const RECENT_LIMIT = 5;

/**
 * ★ Recent (design 7, 01a): "Chats are saved under Recent. Home is one click
 * back." The person's own threads, newest first - a thread is its owner's
 * only. Read again whenever one is made, titled, renamed or deleted.
 *
 * Absent rather than empty: no threads yet, or a list that could not be
 * read, draws nothing - the rail is not where a failure is reported, and
 * the conversation itself says when it cannot open.
 */
export function RecentThreads() {
  const t = useTranslations('navigation');
  const pathname = usePathname();
  const params = useSearchParams();
  // The one open now is marked - only on Home, where `?thread=` means a thread.
  const open = pathname === '/home' ? (params?.get('thread') ?? null) : null;
  const [threads, setThreads] = useState<readonly ThreadListItem[]>([]);

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

  if (threads.length === 0) return null;
  return (
    <nav className={styles.subNavGroup} aria-label={t('recent')} data-testid="recent-threads">
      <span className={styles.subNavLabel} aria-hidden="true">
        {t('recent')}
      </span>
      <ul className={styles.subNavList} role="list">
        {threads.map((thread) => (
          <li key={thread.id}>
            <Link
              href={{ pathname: '/home', query: { thread: thread.id } }}
              className={styles.subNavLink}
              aria-current={open === thread.id ? 'page' : undefined}
              data-testid={`recent-${thread.id}`}
            >
              <bdi dir="auto" className={styles.recentTitle}>
                {thread.title ?? t('untitled')}
              </bdi>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
