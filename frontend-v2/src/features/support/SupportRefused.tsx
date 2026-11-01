'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import type { SupportDenyKind } from '@/support/support-codes';
import { useSupport } from '@/support/support-context';

import styles from './SupportBanner.module.css';

/**
 * A control support mode may not use (Omer, 2026-11-01), drawn refused.
 *
 * Outside support mode: the control, untouched. Inside: the control still
 * drawn - what the workspace holds stays readable - but `inert`, so nothing
 * in it can be clicked, focused or typed into, and "Not allowed in support
 * mode" beside it. The platform refuses the same writes anyway (403
 * `support_denied:<kind>`); this is so the admin is never offered one.
 *
 * Wrapped at the call site, not inside the control: one rule in one place
 * per screen, and the control's own tests stay the merchant's.
 */
export function SupportRefused({
  kind,
  children,
}: {
  readonly kind: SupportDenyKind;
  readonly children: ReactNode;
}) {
  const { refuses } = useSupport();
  if (!refuses(kind)) return <>{children}</>;
  return <Refused kind={kind}>{children}</Refused>;
}

function Refused({
  kind,
  children,
}: {
  readonly kind: SupportDenyKind;
  readonly children: ReactNode;
}) {
  const t = useTranslations('console.support');
  return (
    <div className={styles.refusedWrap} data-testid={`support-refused-${kind}`}>
      <div className={styles.refusedControl} inert>
        {children}
      </div>
      <p className={styles.refusedNote}>{t('refused')}</p>
    </div>
  );
}
