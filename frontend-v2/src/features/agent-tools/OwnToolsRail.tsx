import { getTranslations } from 'next-intl/server';

import type { CustomApiTool, McpServer } from '@/api/contracts/agent-tools';
import { Link } from '@/i18n/navigation';

import styles from '@/features/capabilities/Capabilities.module.css';

/**
 * Screen 10's rail, under the catalogue: the business's own tools. Each MCP
 * server with its state, Connect an MCP server, and Custom API with how
 * many tools it holds. A failed read says so on its row, never "none".
 */
export async function OwnToolsRail({
  servers,
  customTools,
  selected,
}: {
  readonly servers: readonly McpServer[] | null;
  readonly customTools: readonly CustomApiTool[] | null;
  readonly selected: string | null;
}) {
  const t = await getTranslations('capabilities.ownTools');
  return (
    <section className={styles.railSection} data-testid="rail-own-tools">
      <h2 className={styles.railHeadingRule}>
        <span>{t('railLabel')}</span>
      </h2>
      <ul className={styles.railList}>
        {servers === null ? (
          <li className={styles.railNote} data-testid="own-mcp-unread">
            {t('mcp.unread')}
          </li>
        ) : (
          servers.map((server) => (
            <li key={server.id}>
              <Link
                href={{ pathname: '/studio/capabilities', query: { system: `mcp:${server.id}` } }}
                className={styles.railRow}
                aria-current={selected === `mcp:${server.id}` ? 'page' : undefined}
                data-testid={`own-mcp-${server.id}`}
              >
                <span className={styles.railName}>
                  <bdi>{server.name}</bdi>
                </span>
                {server.status === 'READY' ? (
                  <span className={styles.railCount}>
                    {t('railTools', {
                      on: server.tools.filter((tool) => !tool.gone && tool.level !== 'never').length,
                      count: server.tools.filter((tool) => !tool.gone).length,
                    })}
                  </span>
                ) : (
                  <span className={styles.railState} data-state={server.status}>
                    {t(`mcp.state.${server.status}`)}
                  </span>
                )}
              </Link>
            </li>
          ))
        )}
        <li>
          <Link
            href={{ pathname: '/studio/capabilities', query: { system: 'mcp' } }}
            className={`${styles.railRow} ${styles.railRowAvailable}`}
            aria-current={selected === 'mcp' ? 'page' : undefined}
            data-testid="own-mcp-connect"
          >
            <span className={styles.railNameStack}>
              <span className={styles.railName}>{t('mcp.connectTitle')}</span>
              <span className={styles.railSub}>{t('mcp.railSub')}</span>
            </span>
            <span className={styles.railConnect}>{t('mcp.railConnect')}</span>
          </Link>
        </li>
        <li>
          <Link
            href={{ pathname: '/studio/capabilities', query: { system: 'custom_api' } }}
            className={styles.railRow}
            aria-current={selected === 'custom_api' ? 'page' : undefined}
            data-testid="own-custom-api"
          >
            <span className={styles.railNameStack}>
              <span className={styles.railName}>{t('custom.title')}</span>
              <span className={styles.railSub}>{t('custom.railSub')}</span>
            </span>
            <span className={styles.railCount}>
              {customTools === null
                ? t('custom.unreadShort')
                : t('custom.count', { count: customTools.length })}
            </span>
          </Link>
        </li>
      </ul>
    </section>
  );
}
