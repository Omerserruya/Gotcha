'use client';

import { useTranslations } from 'next-intl';

import type { PendingServer } from '@/api/contracts/agent-tools';
import { ConfirmedAction } from '@/features/console/ConfirmedAction';

import { decideMcpServer } from './agent-tools-actions';
import styles from './AgentTools.module.css';

/**
 * GOTCHA's queue: every workspace's MCP servers waiting for approval. Each
 * shows what we would be trusting - the workspace, who sent it, the address,
 * how it signs in - never the secret. Approve lets us reach it and read its
 * tools; Reject sends the business our reason, in their screen.
 */
export function McpQueue({
  servers,
  sentAt,
}: {
  readonly servers: readonly PendingServer[];
  /** Each server's send time, formatted on the server: one ICU, never two ([[icu-differs-server-vs-browser]]). */
  readonly sentAt: Readonly<Record<string, string>>;
}) {
  const t = useTranslations('console.toolsQueue');
  const ta = useTranslations('capabilities.ownTools');

  if (servers.length === 0) {
    return (
      <p className={styles.body} data-testid="queue-empty">
        {t('empty')}
      </p>
    );
  }

  return (
    <ul className={styles.queue} data-testid="queue">
      {servers.map((server) => (
        <li key={server.id} className={styles.queueRow} data-testid={`queue-${server.id}`}>
          <div className={styles.queueWhat}>
            <span className={styles.name}>
              <bdi>{server.name}</bdi>
            </span>
            <dl className={styles.facts}>
              <div>
                <dt>{t('workspace')}</dt>
                <dd>
                  <bdi>{server.tenant.name ?? server.tenant.id}</bdi>
                </dd>
              </div>
              {server.submittedBy ? (
                <div>
                  <dt>{t('sentBy')}</dt>
                  <dd>
                    <bdi>{server.submittedBy.name ?? server.submittedBy.id}</bdi>
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>{t('url')}</dt>
                <dd>
                  <bdi dir="ltr">{server.url}</bdi>
                </dd>
              </div>
              <div>
                <dt>{t('auth')}</dt>
                <dd>
                  {ta(`form.authKind.${server.auth.kind}`)}
                  {server.auth.kind === 'header' && server.auth.headerName ? (
                    <>
                      {' · '}
                      <bdi dir="ltr">{server.auth.headerName}</bdi>
                    </>
                  ) : null}
                </dd>
              </div>
              {sentAt[server.id] ? (
                <div>
                  <dt>{t('sentAt')}</dt>
                  <dd>{sentAt[server.id]}</dd>
                </div>
              ) : null}
            </dl>
          </div>
          <span className={styles.rowActions}>
            <ConfirmedAction
              label={t('approve')}
              sentences={[t('approveFirst', { name: server.name }), t('approveSecond')]}
              yes={t('approveYes')}
              variant="primary"
              run={() => decideMcpServer(server.id, 'approve', '')}
              done={() => t('approved')}
              refused={(result) => ta(`refusal.${result.reason}`)}
              testid={`queue-approve-${server.id}`}
            />
            <ConfirmedAction
              label={t('reject')}
              sentences={[t('rejectFirst', { name: server.name })]}
              reason={t('rejectReason')}
              yes={t('rejectYes')}
              variant="danger"
              run={({ reason }) => decideMcpServer(server.id, 'reject', reason)}
              done={() => t('rejected')}
              refused={(result) => ta(`refusal.${result.reason}`)}
              testid={`queue-reject-${server.id}`}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}
