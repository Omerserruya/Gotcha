'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { McpServer } from '@/api/contracts/agent-tools';
import { Button } from '@/design-system/primitives/button/Button';
import { ConfirmedAction } from '@/features/console/ConfirmedAction';
import { useRouter } from '@/i18n/navigation';

import { rediscoverMcpServer, removeMcpServer, type ToolsRefusal } from './agent-tools-actions';
import { McpServerForm } from './McpServerForm';
import styles from './AgentTools.module.css';

/**
 * What can be done to a server in its state. Edit opens the form in place.
 * "Check again" re-reads the tools where the server is approved; a pending
 * or rejected one is not ours to reach yet. Withdraw (pending) and Remove
 * (anything else) are the same delete, asked first, in different words.
 */
export function McpServerActions({ server }: { readonly server: McpServer }) {
  const t = useTranslations('capabilities.ownTools');
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [problem, setProblem] = useState<ToolsRefusal | null>(null);
  const approved = server.status === 'READY' || server.status === 'FAILED';
  const pending = server.status === 'PENDING_APPROVAL';

  if (editing) {
    return <McpServerForm server={server} onCancel={() => setEditing(false)} />;
  }

  return (
    <div className={styles.serverActions}>
      <span className={styles.actions}>
        {server.status !== 'UNKNOWN' ? (
          <Button size="sm" onClick={() => setEditing(true)} data-testid="mcp-edit">
            {server.status === 'REJECTED' ? t('mcp.editAndSend') : t('mcp.edit')}
          </Button>
        ) : null}
        {approved ? (
          <Button
            size="sm"
            disabled={isPending}
            data-testid="mcp-rediscover"
            onClick={() => {
              setProblem(null);
              startTransition(async () => {
                const result = await rediscoverMcpServer(server.id);
                if (result.ok) router.refresh();
                else setProblem(result.reason);
              });
            }}
          >
            {server.status === 'FAILED' ? t('mcp.tryAgain') : t('mcp.rediscover')}
          </Button>
        ) : null}
      </span>
      <ConfirmedAction
        label={pending ? t('mcp.withdraw') : t('mcp.remove')}
        sentences={[
          pending ? t('mcp.withdrawFirst', { name: server.name }) : t('mcp.removeFirst', { name: server.name }),
          ...(pending ? [] : [t('mcp.removeSecond')]),
        ]}
        yes={pending ? t('mcp.withdrawYes') : t('mcp.removeYes')}
        variant="danger"
        run={() => removeMcpServer(server.id)}
        done={() => t('mcp.removed')}
        refused={(result) => t(`refusal.${result.reason}`)}
        after={() => {
          router.replace({ pathname: '/studio/capabilities', query: { system: 'mcp' } });
          router.refresh();
        }}
        testid="mcp-remove"
      />
      {problem !== null ? (
        <p className={styles.warn} role="alert" data-testid="mcp-action-problem">
          {t(`refusal.${problem}`)}
        </p>
      ) : null}
    </div>
  );
}
