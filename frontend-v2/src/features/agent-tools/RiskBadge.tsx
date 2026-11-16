import { useTranslations } from 'next-intl';

import type { ToolRisk } from '@/api/contracts/agent-tools';

import styles from './AgentTools.module.css';

/** What a tool can do, in four words: reads, changes, can't be undone, moves money. */
export function RiskBadge({ risk, testid }: { readonly risk: ToolRisk; readonly testid: string }) {
  const t = useTranslations('capabilities.ownTools.risk');
  return (
    <span className={styles.risk} data-risk={risk} data-testid={testid}>
      {t(risk)}
    </span>
  );
}
