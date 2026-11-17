'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/design-system/primitives/button/Button';
import { logger } from '@/observability/logger';

import styles from './RscLoopGuard.module.css';
import { createRscLoopCounter, pageKey, routerRequestPage, type RscLoopCounter } from './rsc-loop-guard';

function sessionStore() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The guard (`rsc-loop-guard.ts`) around the shell: it draws `children`
 * until the tab asks for one page in a loop, then draws ONLY the notice.
 * Unmounting the shell stops whatever was looping inside it: a component's
 * effect, or the page's own router segments refetching.
 */
export function RscLoopGuard({ children }: { readonly children: ReactNode }) {
  const [stopped, setStopped] = useState<string | null>(null);
  const counter = useRef<RscLoopCounter | null>(null);

  useEffect(() => {
    const count = createRscLoopCounter({ storage: sessionStore() });
    counter.current = count;
    let said = false;
    const stop = (page: string) => {
      if (said) return;
      said = true;
      logger.warn('shell.rsc_loop_stopped', { page });
      setStopped(page);
    };
    const here = pageKey(new URL(window.location.href));
    if (count.note(here)) stop(here);
    if (typeof PerformanceObserver === 'undefined') return;
    const origin = window.location.origin;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const page = routerRequestPage(entry.name, origin);
        if (page !== null && count.note(page)) stop(page);
      }
    });
    try {
      observer.observe({ type: 'resource' });
    } catch {
      return;
    }
    return () => observer.disconnect();
  }, []);

  const t = useTranslations('common.loopStopped');
  if (stopped === null) return <>{children}</>;
  return (
    <div className={styles.notice} role="alert" data-testid="rsc-loop-notice">
      <p className={styles.text}>{t('body')}</p>
      <Button
        variant="primary"
        data-testid="rsc-loop-retry"
        onClick={() => {
          counter.current?.clear(stopped);
          window.location.reload();
        }}
      >
        {t('retry')}
      </Button>
    </div>
  );
}
