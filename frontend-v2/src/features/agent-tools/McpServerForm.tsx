'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import {
  editNeedsApproval,
  isSendableUrl,
  MCP_AUTH_KINDS,
  type McpAuthKind,
  type McpServer,
} from '@/api/contracts/agent-tools';
import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';
import { useRouter } from '@/i18n/navigation';

import { editMcpServer, sendMcpServer, type ToolsRefusal } from './agent-tools-actions';
import styles from './AgentTools.module.css';

/**
 * Connect an MCP server: a name, an https address, and how it signs us in
 * (none, a bearer token, or one header - no OAuth yet). It goes to GOTCHA
 * for approval; nothing reaches the server until we approve it.
 *
 * On an edit, a new address or new sign-in goes back to GOTCHA, and the form
 * says so before it is sent; a new name does not (Supervisior (e)). The
 * stored secret is never shown: empty keeps it.
 */
export function McpServerForm({
  server = null,
  onCancel,
}: {
  /** Absent for a new server. */
  readonly server?: McpServer | null;
  readonly onCancel?: () => void;
}) {
  const t = useTranslations('capabilities.ownTools');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(server?.name ?? '');
  const [url, setUrl] = useState(server?.url ?? '');
  const [authKind, setAuthKind] = useState<McpAuthKind>(server?.auth.kind ?? 'none');
  const [headerName, setHeaderName] = useState(server?.auth.headerName ?? '');
  const [secret, setSecret] = useState('');
  const [touched, setTouched] = useState(false);
  const [problem, setProblem] = useState<ToolsRefusal | null>(null);

  const urlOk = isSendableUrl(url);
  const secretNeeded =
    authKind !== 'none' && (server === null || !server.hasSecret || authKind !== server.auth.kind);
  const ready =
    name.trim() !== '' &&
    urlOk &&
    (authKind !== 'header' || headerName.trim() !== '') &&
    (!secretNeeded || secret !== '');
  const backToQueue =
    server !== null &&
    server.status !== 'PENDING_APPROVAL' &&
    editNeedsApproval(server, { url, authKind, headerName, secret });

  function send() {
    setTouched(true);
    if (!ready) return;
    setProblem(null);
    startTransition(async () => {
      const input = { name, url, authKind, headerName, secret };
      const authChanged =
        server !== null &&
        (authKind !== server.auth.kind ||
          (authKind === 'header' && headerName.trim() !== (server.auth.headerName ?? '')) ||
          secret !== '');
      const result = server
        ? await editMcpServer(server.id, input, authChanged)
        : await sendMcpServer(input);
      if (!result.ok) {
        setProblem(result.reason);
        return;
      }
      setSecret('');
      if (server === null) {
        router.replace({ pathname: '/studio/capabilities', query: { system: 'mcp', sent: '1' } });
      } else {
        onCancel?.();
      }
      router.refresh();
    });
  }

  return (
    <form
      className={styles.form}
      data-testid={server ? `mcp-edit-${server.id}` : 'mcp-new'}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <Input
        label={t('form.name')}
        hint={t('form.nameHint')}
        value={name}
        maxLength={80}
        onChange={(event) => setName(event.target.value)}
        error={touched && name.trim() === '' ? t('form.nameMissing') : undefined}
        data-testid="mcp-name"
      />
      <Input
        label={t('form.url')}
        hint={t('form.urlHint')}
        value={url}
        dir="ltr"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder="https://mcp.example.com/mcp"
        onChange={(event) => setUrl(event.target.value)}
        error={touched && !urlOk ? t('form.urlInvalid') : undefined}
        data-testid="mcp-url"
      />

      <fieldset className={styles.choiceSet}>
        <legend className={styles.legend}>{t('form.auth')}</legend>
        {MCP_AUTH_KINDS.map((kind) => (
          <label key={kind} className={styles.radio}>
            <input
              type="radio"
              name="mcp-auth"
              value={kind}
              checked={authKind === kind}
              onChange={() => setAuthKind(kind)}
              data-testid={`mcp-auth-${kind}`}
            />
            <span>{t(`form.authKind.${kind}`)}</span>
          </label>
        ))}
      </fieldset>

      {authKind === 'header' ? (
        <Input
          label={t('form.headerName')}
          value={headerName}
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          placeholder="X-API-Key"
          onChange={(event) => setHeaderName(event.target.value)}
          error={touched && headerName.trim() === '' ? t('form.headerMissing') : undefined}
          data-testid="mcp-header-name"
        />
      ) : null}
      {authKind !== 'none' ? (
        <Input
          label={t(authKind === 'bearer' ? 'form.token' : 'form.headerValue')}
          hint={server?.hasSecret && authKind === server.auth.kind ? t('form.secretKept') : undefined}
          type="password"
          value={secret}
          dir="ltr"
          autoComplete="off"
          onChange={(event) => setSecret(event.target.value)}
          error={touched && secretNeeded && secret === '' ? t('form.secretMissing') : undefined}
          data-testid="mcp-secret"
        />
      ) : null}

      {server === null ? (
        <p className={styles.note} data-testid="mcp-approval-note">
          {t('form.approvalNote')}
        </p>
      ) : backToQueue ? (
        <p className={styles.warn} role="note" data-testid="mcp-back-to-queue">
          {t('form.backToQueue')}
        </p>
      ) : null}

      {problem !== null ? (
        <p className={styles.warn} role="alert" data-testid="mcp-problem">
          {t(`refusal.${problem}`)}
        </p>
      ) : null}

      <span className={styles.actions}>
        {onCancel ? (
          <Button size="sm" onClick={onCancel} disabled={isPending}>
            {t('form.cancel')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={isPending}
          data-testid="mcp-send"
        >
          {server === null ? t('form.send') : backToQueue ? t('form.saveAndSend') : t('form.save')}
        </Button>
      </span>
    </form>
  );
}
