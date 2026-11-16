import { getFormatter, getTranslations } from 'next-intl/server';

import { loadPendingServers } from '@/features/agent-tools/load-agent-tools';
import { McpQueue } from '@/features/agent-tools/McpQueue';
import { pageMetadata } from '@/shell/page-metadata';
import { requireConsole } from '@/shell/require-console';
import { SettingsSection } from '@/shell/SettingsSection';

import styles from '@/features/console/Console.module.css';

/**
 * Console · MCP servers waiting for us (Omer, 2026-11-16): only GOTCHA
 * approves a business's MCP server. Approve, or reject with a reason the
 * business reads. A failed read is never drawn as an empty queue.
 */
export default async function Page() {
  // The layout draws the unread state; the page reads nothing behind it.
  if ((await requireConsole()) !== 'open') return null;
  const [t, format, pending] = await Promise.all([
    getTranslations('console.toolsQueue'),
    getFormatter(),
    loadPendingServers(),
  ]);
  const sentAt = Object.fromEntries(
    (pending ?? []).flatMap((server) =>
      server.submittedAt
        ? [
            [
              server.id,
              format.dateTime(new Date(server.submittedAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
                hourCycle: 'h23',
              }),
            ],
          ]
        : [],
    ),
  );

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {pending === null ? (
        <p className={styles.notice} data-testid="queue-unread">
          {t('unread')}
        </p>
      ) : (
        <McpQueue servers={pending} sentAt={sentAt} />
      )}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('sections.tools', 'console');
