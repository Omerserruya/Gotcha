'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';
import { UserText } from '@/design-system/primitives/text/UserText';
import styles from '@/features/console/Console.module.css';
import { appPath } from '@/lib/base-path';

import {
  endSupport,
  resumeSupport,
  startSupport,
  supportLocale,
  type SupportRefusal,
} from './actions';

/** The reason's ceiling, as the platform's validator has it (support-sessions.ts). */
const REASON_MAX = 500;

type Outcome =
  | { readonly kind: 'refused'; readonly reason: SupportRefusal | 'none' }
  | { readonly kind: 'active'; readonly name: string | null }
  | { readonly kind: 'endedOther' };

/**
 * Console · one tenant: enter its workspace as its admin (Omer, 2026-11-01).
 *
 * A reason first - the platform records it in the workspace's own history and
 * in System's. On success the workspace opens with a document load: its Home,
 * or onboarding for a workspace being set up (the layout's gate sends it
 * there), with the banner on every page until Exit.
 *
 * Already in a session (another tab): return to it, or end it here.
 */
export function SupportEnter({
  tenantId,
  ended,
}: {
  readonly tenantId: string;
  /** Back from a session the platform ended (`?support=ended`). */
  readonly ended: boolean;
}) {
  const t = useTranslations('console.support.enter');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const ready = reason.trim() !== '' && !pending;

  /*
   * ★ IN THE WORKSPACE'S LANGUAGE (Omer, 2026-11-02): as its people see it.
   *   Read once the cookie is set - a request of its own - and the URL's
   *   language wins over the admin's cookie. Unread: the admin's, as before.
   */
  const open = async () => {
    const locale = await supportLocale();
    window.location.assign(appPath(locale ? `/${locale}/home` : '/home'));
  };

  return (
    <section className={styles.card} aria-labelledby="support-enter" data-testid="support-enter">
      <h2 id="support-enter" className={styles.cardTitle}>
        {t('title')}
      </h2>
      {ended ? (
        <p className={styles.notice} role="status" data-testid="support-ended">
          {t('ended')}
        </p>
      ) : null}
      <p className={styles.quiet}>{t('what')}</p>
      <form
        className={styles.assign}
        onSubmit={async (event) => {
          event.preventDefault();
          if (!ready) return;
          setPending(true);
          setOutcome(null);
          const result = await startSupport(tenantId, reason);
          if (result.ok) return open();
          setOutcome(
            result.reason === 'active'
              ? { kind: 'active', name: result.activeName ?? null }
              : { kind: 'refused', reason: result.reason },
          );
          setPending(false);
        }}
      >
        <Input
          label={t('reason')}
          hint={t('reasonHint')}
          value={reason}
          maxLength={REASON_MAX}
          onChange={(event) => setReason(event.target.value)}
          data-testid="support-reason"
        />
        <Button type="submit" size="sm" disabled={!ready} data-testid="support-start">
          {pending ? t('entering') : t('enter')}
        </Button>
      </form>
      {outcome?.kind === 'refused' ? (
        <p className={styles.refused} role="alert" data-testid="support-refused">
          {t(`refusal.${outcome.reason}`)}
        </p>
      ) : null}
      {outcome?.kind === 'endedOther' ? (
        <p className={styles.done} role="status" data-testid="support-ended-other">
          {t('endedOther')}
        </p>
      ) : null}
      {outcome?.kind === 'active' ? (
        <div className={styles.controlRow} data-testid="support-active">
          <p className={styles.refused} role="alert">
            {outcome.name
              ? t.rich('active', {
                  name: outcome.name,
                  b: () => <UserText>{outcome.name}</UserText>,
                })
              : t('activeUnnamed')}
          </p>
          <Button
            size="sm"
            disabled={pending}
            data-testid="support-resume"
            onClick={async () => {
              setPending(true);
              const result = await resumeSupport();
              if (result.ok) return open();
              setOutcome({ kind: 'refused', reason: result.reason });
              setPending(false);
            }}
          >
            {t('resume')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            data-testid="support-end-other"
            onClick={async () => {
              setPending(true);
              const result = await endSupport();
              setOutcome(
                result.ok ? { kind: 'endedOther' } : { kind: 'refused', reason: result.reason },
              );
              setPending(false);
            }}
          >
            {t('endOther')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
