import { getFormatter, getTranslations } from 'next-intl/server';

import { mcpFailureOf, type McpServer } from '@/api/contracts/agent-tools';

import { McpServerActions } from './McpServerActions';
import { McpToolLevel } from './McpToolLevel';
import { RiskBadge } from './RiskBadge';
import styles from './AgentTools.module.css';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * One MCP server, in its state:
 *
 *   PENDING_APPROVAL  waiting for GOTCHA: what was sent, when; Withdraw, Edit
 *   DISCOVERING       approved, reading its tools
 *   READY             its tools, each OFF until turned on, with its risk
 *   FAILED            why, in words; Try again, Edit
 *   REJECTED          GOTCHA's reason; Edit and send again, Remove
 *   UNKNOWN           a state this build does not name: said so, Remove only
 *
 * The secret is never shown, only that one is kept.
 */
export async function McpServerDetail({ server }: { readonly server: McpServer }) {
  const t = await getTranslations('capabilities.ownTools');
  const format = await getFormatter();
  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }) : null;
  const working = server.status === 'READY';
  const live = server.tools.filter((tool) => !tool.gone);
  const gone = server.tools.filter((tool) => tool.gone);
  const fresh = live.filter((tool) => tool.isNew).length;

  return (
    <div className={styles.detail} data-testid={`mcp-server-${server.id}`} data-status={server.status}>
      <header className={styles.head}>
        <span className={styles.headTitle}>
          <span className={styles.name}>{server.name}</span>
          <span className={styles.sub}>
            {t('mcp.kind')} · <bdi dir="ltr">{hostOf(server.url)}</bdi>
          </span>
        </span>
        <span className={styles.state} data-state={server.status} data-testid="mcp-state">
          {t(`mcp.state.${server.status}`)}
        </span>
      </header>

      {server.status === 'PENDING_APPROVAL' ? (
        <section className={styles.card} data-testid="mcp-pending">
          <p className={styles.lead}>{t('mcp.pending.lead')}</p>
          <p className={styles.body}>{t('mcp.pending.body')}</p>
        </section>
      ) : server.status === 'DISCOVERING' ? (
        <section className={styles.card} data-testid="mcp-discovering">
          <p className={styles.lead}>{t('mcp.discovering.lead')}</p>
          <p className={styles.body}>{t('mcp.discovering.body')}</p>
        </section>
      ) : server.status === 'FAILED' ? (
        <section className={styles.cardWarn} role="note" data-testid="mcp-failed">
          <p className={styles.lead}>{t('mcp.failed.lead')}</p>
          <p className={styles.body} data-testid="mcp-failed-reason">
            {t(`mcp.failure.${mcpFailureOf(server.lastErrorCode)}`)}
          </p>
        </section>
      ) : server.status === 'REJECTED' ? (
        <section className={styles.cardWarn} role="note" data-testid="mcp-rejected">
          <p className={styles.lead}>{t('mcp.rejected.lead')}</p>
          {server.rejectionReason ? (
            <p className={styles.body} data-testid="mcp-rejected-reason">
              <bdi>{server.rejectionReason}</bdi>
            </p>
          ) : (
            <p className={styles.body}>{t('mcp.rejected.noReason')}</p>
          )}
        </section>
      ) : server.status === 'UNKNOWN' ? (
        <section className={styles.card} data-testid="mcp-unknown">
          <p className={styles.body}>{t('mcp.unknown')}</p>
        </section>
      ) : null}

      <dl className={styles.facts} data-testid="mcp-facts">
        <div>
          <dt>{t('mcp.facts.url')}</dt>
          <dd>
            <bdi dir="ltr">{server.url}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t('mcp.facts.auth')}</dt>
          <dd>
            {t(`form.authKind.${server.auth.kind}`)}
            {server.auth.kind === 'header' && server.auth.headerName ? (
              <>
                {' · '}
                <bdi dir="ltr">{server.auth.headerName}</bdi>
              </>
            ) : null}
          </dd>
        </div>
        {when(server.submittedAt) ? (
          <div>
            <dt>{t('mcp.facts.sent')}</dt>
            <dd>{when(server.submittedAt)}</dd>
          </div>
        ) : null}
        {working && when(server.lastCheckedAt) ? (
          <div>
            <dt>{t('mcp.facts.checked')}</dt>
            <dd>{when(server.lastCheckedAt)}</dd>
          </div>
        ) : null}
      </dl>

      <McpServerActions server={server} />

      {server.tools.length > 0 ? (
        <section className={styles.tools} data-testid="mcp-tools">
          <h2 className={styles.heading}>
            {t('mcp.tools.heading', { count: live.length })}
          </h2>
          <p className={styles.body}>{t('mcp.tools.offFirst')}</p>
          {fresh > 0 ? (
            <p className={styles.note} data-testid="mcp-new-count">
              {t('mcp.tools.newCount', { count: fresh })}
            </p>
          ) : null}
          <ul className={styles.toolList}>
            {[...live, ...gone].map((tool) => (
              <li
                key={tool.name}
                className={styles.tool}
                data-testid={`mcp-tool-${tool.name}`}
                data-gone={tool.gone ? 'yes' : undefined}
              >
                <span className={styles.toolWhat}>
                  <span className={styles.toolName}>
                    {tool.title ?? <bdi dir="ltr">{tool.name}</bdi>}
                    <RiskBadge risk={tool.risk} testid={`risk-${tool.name}`} />
                    {tool.isNew && !tool.gone ? (
                      <span className={styles.tag} data-testid={`new-${tool.name}`}>
                        {t('mcp.tools.new')}
                      </span>
                    ) : null}
                    {tool.gone ? (
                      <span className={styles.tag} data-testid={`gone-${tool.name}`}>
                        {t('mcp.tools.gone')}
                      </span>
                    ) : null}
                  </span>
                  {tool.description ? (
                    <span className={styles.toolDescription}>
                      <bdi>{tool.description}</bdi>
                    </span>
                  ) : null}
                </span>
                <McpToolLevel
                  serverId={server.id}
                  tool={tool}
                  {...(working ? {} : { blocked: t('mcp.tools.blocked') })}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : working ? (
        <p className={styles.body} data-testid="mcp-no-tools">
          {t('mcp.tools.none')}
        </p>
      ) : null}
    </div>
  );
}
