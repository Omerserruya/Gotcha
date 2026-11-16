'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, useTransition } from 'react';

import { customApiRisk, type CustomApiTest, type CustomApiTool } from '@/api/contracts/agent-tools';
import { Button } from '@/design-system/primitives/button/Button';
import { ConfirmedAction } from '@/features/console/ConfirmedAction';

import { deleteCustomApiTool, testCustomApiTool, type ToolsRefusal } from './agent-tools-actions';
import { CustomApiEditor } from './CustomApiEditor';
import { RiskBadge } from './RiskBadge';
import styles from './AgentTools.module.css';

function hostOf(template: string): string {
  try {
    return new URL(template.replace(/\{\{[^}]*\}\}/g, 'x')).host;
  } catch {
    return template;
  }
}

/** The longest response shown; the rest is cut and says so. */
const SHOWN = 2000;

/**
 * Fire one tool with sample input. Asked first, because it reaches the
 * business's own API for real - a POST there may create an order. A line of
 * its own under the row, never squeezed beside the row's buttons.
 */
function TestPanel({ tool, onClose }: { readonly tool: CustomApiTool; readonly onClose: () => void }) {
  const t = useTranslations('capabilities.ownTools.custom.test');
  const tr = useTranslations('capabilities.ownTools');
  const id = useId();
  const [args, setArgs] = useState('{}');
  const [badArgs, setBadArgs] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<
    { readonly ok: true; readonly test: CustomApiTest } | { readonly ok: false; readonly reason: ToolsRefusal } | null
  >(null);

  function run() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args || '{}');
    } catch {
      setBadArgs(true);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setBadArgs(true);
      return;
    }
    setBadArgs(false);
    setOutcome(null);
    startTransition(async () => {
      setOutcome(await testCustomApiTool(tool.id, parsed as Record<string, unknown>));
    });
  }

  const shown = outcome?.ok ? JSON.stringify(outcome.test.result ?? null, null, 2) ?? '' : '';
  return (
    <div className={styles.test} data-testid={`custom-test-panel-${tool.slug}`}>
      <p className={styles.note}>
        {tool.method === 'GET' ? t('realRead', { method: tool.method }) : t('realWrite', { method: tool.method })}
      </p>
      <label className={styles.label} htmlFor={id}>
        {t('args')}
      </label>
      <textarea
        id={id}
        className={`${styles.textarea} ${styles.code}`}
        rows={4}
        dir="ltr"
        spellCheck={false}
        value={args}
        aria-invalid={badArgs ? 'true' : undefined}
        onChange={(event) => setArgs(event.target.value)}
        data-testid={`custom-test-args-${tool.slug}`}
      />
      {badArgs ? <span className={styles.error}>{t('badArgs')}</span> : null}
      <span className={styles.actions}>
        <Button size="sm" onClick={onClose} disabled={isPending}>
          {tr('form.cancel')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={run}
          disabled={isPending}
          data-testid={`custom-test-run-${tool.slug}`}
        >
          {t('run')}
        </Button>
      </span>
      {outcome === null ? null : !outcome.ok ? (
        <p className={styles.warn} role="alert" data-testid={`custom-test-refused-${tool.slug}`}>
          {tr(`refusal.${outcome.reason}`)}
        </p>
      ) : (
        <div
          className={outcome.test.ok ? styles.result : styles.resultWarn}
          role="status"
          data-testid={`custom-test-result-${tool.slug}`}
          data-ok={outcome.test.ok ? 'yes' : 'no'}
        >
          <p className={styles.lead}>
            {outcome.test.ok ? t('worked') : t('failed')}
            {outcome.test.meta?.status != null ? (
              <>
                {' · '}
                {t('status', { status: outcome.test.meta.status })}
              </>
            ) : null}
            {outcome.test.meta?.durationMs != null ? (
              <>
                {' · '}
                {t('duration', { ms: Math.round(outcome.test.meta.durationMs) })}
              </>
            ) : null}
          </p>
          {!outcome.test.ok && outcome.test.reason ? (
            <p className={styles.body}>
              <bdi dir="ltr">{outcome.test.reason}</bdi>
            </p>
          ) : null}
          {outcome.test.ok ? (
            <>
              <pre className={styles.pre} dir="ltr">
                {shown.slice(0, SHOWN)}
              </pre>
              {shown.length > SHOWN ? <p className={styles.note}>{t('cut')}</p> : null}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Custom API: the business describes an HTTP call and the AI employee can
 * make it as a tool - the legacy builder, ported. Which employee may use a
 * tool is set on the employee (its systems allowlist), not here.
 */
export function CustomApiTools({ tools }: { readonly tools: readonly CustomApiTool[] }) {
  const t = useTranslations('capabilities.ownTools.custom');
  const tr = useTranslations('capabilities.ownTools');
  const tt = useTranslations('capabilities.ownTools.custom.test');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  return (
    <div className={styles.detail} data-testid="custom-api">
      <header className={styles.head}>
        <span className={styles.headTitle}>
          <span className={styles.name}>{t('title')}</span>
          <span className={styles.sub}>{t('line')}</span>
        </span>
        {editing === null ? (
          <Button size="sm" variant="primary" onClick={() => setEditing('new')} data-testid="custom-add">
            {t('add')}
          </Button>
        ) : null}
      </header>

      <p className={styles.body}>{t('employeeNote')}</p>

      {editing === 'new' ? <CustomApiEditor onDone={() => setEditing(null)} /> : null}

      {tools.length === 0 && editing !== 'new' ? (
        <section className={styles.empty} data-testid="custom-empty">
          <p className={styles.lead}>{t('emptyLead')}</p>
          <p className={styles.body}>{t('emptyBody')}</p>
        </section>
      ) : (
        <ul className={styles.toolList}>
          {tools.map((tool) =>
            editing === tool.id ? (
              <li key={tool.id} className={styles.tool}>
                <CustomApiEditor tool={tool} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li key={tool.id} className={styles.tool} data-testid={`custom-tool-${tool.slug}`}>
                <span className={styles.toolWhat}>
                  <span className={styles.toolName}>
                    <bdi>{tool.name}</bdi>
                    <RiskBadge risk={customApiRisk(tool)} testid={`custom-risk-${tool.slug}`} />
                    {!tool.isActive ? (
                      <span className={styles.tag} data-testid={`custom-off-${tool.slug}`}>
                        {t('off')}
                      </span>
                    ) : null}
                  </span>
                  <span className={styles.toolDescription}>
                    <bdi dir="ltr">
                      {tool.method} {hostOf(tool.urlTemplate)}
                    </bdi>
                    {tool.description ? (
                      <>
                        {' · '}
                        <bdi>{tool.description}</bdi>
                      </>
                    ) : null}
                  </span>
                </span>
                <span className={styles.rowActions}>
                  <Button size="sm" onClick={() => setEditing(tool.id)} data-testid={`custom-edit-${tool.slug}`}>
                    {tr('mcp.edit')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => setTesting(testing === tool.id ? null : tool.id)}
                    aria-expanded={testing === tool.id}
                    data-testid={`custom-test-${tool.slug}`}
                  >
                    {tt('open')}
                  </Button>
                  <ConfirmedAction
                    label={t('delete')}
                    sentences={[t('deleteFirst', { name: tool.name }), t('deleteSecond')]}
                    yes={t('deleteYes')}
                    variant="danger"
                    run={() => deleteCustomApiTool(tool.id)}
                    done={() => t('deleted')}
                    refused={(result) => tr(`refusal.${result.reason}`)}
                    testid={`custom-delete-${tool.slug}`}
                  />
                </span>
                {testing === tool.id ? <TestPanel tool={tool} onClose={() => setTesting(null)} /> : null}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
