'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { levelsFor, TOOL_LEVELS, type McpTool } from '@/api/contracts/agent-tools';
import { useRouter } from '@/i18n/navigation';

import { setMcpToolLevel, type ToolsRefusal } from './agent-tools-actions';
import styles from '@/features/capabilities/Capabilities.module.css';

import own from './AgentTools.module.css';

/** The capabilities screen's own three words, in its order. */
const WORD = { execute: 'do_it', ask: 'ask_me', never: 'never' } as const;

/**
 * Do it · Ask me · Never for one tool of an MCP server - the capabilities
 * screen's control, drawn the same. All three always shown; "Do it" locked,
 * with its reason under it, for a tool that cannot be undone, moves money,
 * or whose risk we could not read. A stored "execute" the ceiling no longer
 * allows is still drawn as current: an admin cannot fix what is hidden.
 */
export function McpToolLevel({
  serverId,
  tool,
  blocked,
}: {
  readonly serverId: string;
  readonly tool: McpTool;
  /** Why none can be chosen now (a server not working). */
  readonly blocked?: string;
}) {
  const t = useTranslations('capabilities');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [shown, setShown] = useState(tool.level);
  const [problem, setProblem] = useState<ToolsRefusal | null>(null);
  const allowed = levelsFor(tool.risk);
  const id = `level-why-${tool.name}`;
  const locked = blocked === undefined && !allowed.includes('execute');
  const why = locked
    ? t(
        tool.risk === 'UNKNOWN'
          ? 'ownTools.level.lockedUnknown'
          : tool.risk === 'money'
            ? 'ownTools.level.lockedMoney'
            : 'ownTools.level.lockedIrreversible',
      )
    : undefined;

  function choose(level: (typeof TOOL_LEVELS)[number]) {
    if (blocked !== undefined || level === shown || !allowed.includes(level)) return;
    const before = shown;
    setShown(level);
    setProblem(null);
    startTransition(async () => {
      const result = await setMcpToolLevel(serverId, tool.name, level);
      if (result.ok) {
        router.refresh();
      } else {
        // The switch goes back to what is stored.
        setShown(before);
        setProblem(result.reason);
      }
    });
  }

  return (
    <div
      className={`${styles.choice} ${own.level}`}
      data-testid={`level-${tool.name}`}
      data-blocked={blocked !== undefined ? 'yes' : undefined}
    >
      <div className={styles.choiceRow} role="group" aria-label={t('choice.label')}>
        {TOOL_LEVELS.map((level) => {
          const isLocked = locked && level === 'execute';
          return (
            <button
              key={level}
              type="button"
              className={styles.choiceButton}
              data-testid={`level-${tool.name}-${level}`}
              data-current={level === shown ? 'yes' : 'no'}
              aria-pressed={level === shown}
              disabled={isPending || blocked !== undefined || tool.gone}
              aria-disabled={isLocked ? 'true' : undefined}
              aria-describedby={isLocked ? id : undefined}
              title={isLocked ? why : blocked}
              onClick={() => choose(level)}
            >
              {t(`choice.${WORD[level]}`)}
            </button>
          );
        })}
      </div>
      {why !== undefined ? (
        <p id={id} className={styles.choiceNote} data-testid={id}>
          {shown === 'execute' ? `${why} ${t('choice.storedAutomatic')}` : why}
        </p>
      ) : null}
      {blocked !== undefined ? (
        <p className={styles.choiceNote} data-testid={`level-blocked-${tool.name}`}>
          {blocked}
        </p>
      ) : null}
      {problem !== null ? (
        <p className={styles.choiceWarn} role="alert" data-testid={`level-problem-${tool.name}`}>
          {t(`ownTools.refusal.${problem}`)}
        </p>
      ) : null}
    </div>
  );
}
