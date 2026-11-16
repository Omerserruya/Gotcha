import { getTranslations } from 'next-intl/server';

import { McpServerForm } from './McpServerForm';
import styles from './AgentTools.module.css';

/**
 * Connect an MCP server: what it is, what happens next, and the form. After
 * a send, one line says it reached GOTCHA; the server's own row in the rail
 * carries its state from then on.
 */
export async function McpIntro({ sent }: { readonly sent: boolean }) {
  const t = await getTranslations('capabilities.ownTools.mcp');
  return (
    <div className={styles.detail} data-testid="mcp-intro">
      <header className={styles.head}>
        <span className={styles.headTitle}>
          <span className={styles.name}>{t('connectTitle')}</span>
          <span className={styles.sub}>{t('connectLine')}</span>
        </span>
      </header>
      {sent ? (
        <p className={styles.done} role="status" data-testid="mcp-sent">
          {t('sent')}
        </p>
      ) : null}
      <ol className={styles.steps} data-testid="mcp-steps">
        <li>{t('step.send')}</li>
        <li>{t('step.approve')}</li>
        <li>{t('step.tools')}</li>
        <li>{t('step.employee')}</li>
      </ol>
      <section className={styles.card}>
        <McpServerForm />
      </section>
    </div>
  );
}
