'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { startOAuth, type OAuthStart } from './connect-actions';
import { SALESFORCE_HOSTS } from './oauth';
import styles from './Capabilities.module.css';

/**
 * Connect (or Reconnect) at the provider - live where the way back comes here
 * (backend 381a5d1b). The click asks our server for the provider's address,
 * then the browser goes there. Nothing is connected until the person
 * approves at the provider.
 */
export function OAuthButton({
  slug,
  name,
  mode,
}: {
  readonly slug: string;
  readonly name: string;
  readonly mode: 'connect' | 'reconnect';
}) {
  const t = useTranslations('capabilities.oauth');
  const [host, setHost] = useState(SALESFORCE_HOSTS[0]!);
  const [failed, setFailed] = useState<Exclude<OAuthStart, { ok: true }>['reason'] | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div className={styles.oauth} data-testid={`oauth-${slug}`}>
      {slug === 'salesforce' ? (
        <label className={styles.connectField}>
          <span className={styles.connectLabel}>{t('loginHost')}</span>
          <select
            className={styles.connectBox}
            value={host}
            data-testid="oauth-login-host"
            onChange={(e) => setHost(e.target.value)}
          >
            {SALESFORCE_HOSTS.map((h) => (
              <option key={h} value={h}>
                {new URL(h).host}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className={styles.connectFoot}>
        <button
          type="button"
          className={styles.connectButton}
          disabled={isPending}
          data-testid="oauth-start"
          onClick={() => {
            setFailed(null);
            startTransition(async () => {
              const result = await startOAuth(slug, slug === 'salesforce' ? host : undefined);
              if (result.ok) window.location.assign(result.url);
              else setFailed(result.reason);
            });
          }}
        >
          {isPending ? t('opening', { name }) : t(mode, { name })}
        </button>
        {failed ? (
          <span className={styles.connectProblem} role="alert" data-testid="oauth-problem">
            {t(`error.${failed}`, { name })}
          </span>
        ) : (
          <span className={styles.connectNote}>{t('note', { name })}</span>
        )}
      </div>
    </div>
  );
}
