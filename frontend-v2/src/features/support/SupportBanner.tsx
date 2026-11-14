'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';

import { SUPPORT_ENDED_EVENT } from '@/api/client/browser-api';
import { Button } from '@/design-system/primitives/button/Button';
import { UserText } from '@/design-system/primitives/text/UserText';
import { appPath } from '@/lib/base-path';
import { logger } from '@/observability/logger';
import { SUPPORT_ENDED_PATH } from '@/support/support-codes';
import { useSupport } from '@/support/support-context';

import { endSupport } from './actions';
import styles from './SupportBanner.module.css';

/**
 * Support mode, said on every page (Omer, 2026-11-01): whose workspace this
 * is, why the admin is in it, when it ends, and the way out. Never
 * dismissible - there is no close, and nothing hides it but Exit.
 *
 * Exit ends the session on the platform first; only then does the page
 * leave, with a document load to the console's page for the workspace, so
 * nothing of the workspace stays drawn. A failed end stays here, saying so.
 */
export function SupportBanner() {
  const t = useTranslations('console.support.banner');
  const { session } = useSupport();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  useSupportEndedRedirect(session !== null);
  if (!session) return null;

  const tenant = session.tenantName;
  return (
    <div
      className={styles.banner}
      role="region"
      aria-label={t('label')}
      data-testid="support-banner"
    >
      <span className={styles.label}>{t('label')}</span>
      <p className={styles.body}>
        <span data-testid="support-banner-who">
          {tenant
            ? t.rich('in', { tenant, b: () => <UserText>{tenant}</UserText> })
            : t('inUnnamed')}
        </span>
        {session.reason ? (
          <span data-testid="support-banner-reason">
            {t.rich('reason', {
              reason: session.reason,
              r: () => <UserText>{session.reason}</UserText>,
            })}
          </span>
        ) : null}
        {session.endsAt ? (
          <span data-testid="support-banner-ends">{t('endsAt', { time: session.endsAt })}</span>
        ) : null}
      </p>
      {failed ? (
        <p className={styles.failed} role="alert" data-testid="support-exit-failed">
          {t('exitFailed')}
        </p>
      ) : null}
      <Button
        size="sm"
        variant="danger"
        disabled={pending}
        data-testid="support-exit"
        onClick={async () => {
          setPending(true);
          setFailed(false);
          const result = await endSupport();
          if (!result.ok) {
            setFailed(true);
            setPending(false);
            return;
          }
          // Back in the admin's own language, not the workspace's this page is in.
          const path: `/${string}` = result.tenantId
            ? `/system/tenants/${encodeURIComponent(result.tenantId)}`
            : '/system/tenants';
          window.location.assign(appPath(result.locale ? `/${result.locale}${path}` : path));
        }}
      >
        {pending ? t('exiting') : t('exit')}
      </Button>
    </div>
  );
}

/**
 * ★ SUPPORT MODE ENDED MID-CLICK: a browser call the platform refused with
 *   `support_expired` / `support_session_invalid` (the BFF has cleared the
 *   cookie; `browser-api.ts` announces it). The admin is still signed in, so
 *   not sign-in: the route that opens the console's page for the workspace.
 *   A document load, so no screen of the workspace stays drawn behind it.
 *   Here, not in the shell's watcher: onboarding has no shell, and the
 *   banner is on every page support mode is.
 */
function useSupportEndedRedirect(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let handled = false;
    function onEnded() {
      if (handled) return;
      handled = true;
      logger.info('support.session_ended');
      window.location.assign(appPath(SUPPORT_ENDED_PATH));
    }
    window.addEventListener(SUPPORT_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SUPPORT_ENDED_EVENT, onEnded);
  }, [active]);
}

/**
 * The page with the banner above it, or the page as it was outside support
 * mode - for the layouts, which draw their frame inside this.
 */
export function WithSupportBanner({ children }: { readonly children: ReactNode }) {
  const { session } = useSupport();
  if (!session) return <>{children}</>;
  return (
    <div className={styles.withBanner}>
      <SupportBanner />
      {children}
    </div>
  );
}
