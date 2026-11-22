'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';

import { signOut } from '@/auth/sign-out';
import { Logo } from '@/design-system/brand/Logo';
import { Button } from '@/design-system/primitives/button/Button';

import door from '../mfa/MfaGate.module.css';

import { acceptTerms } from './terms-actions';
import { TermsBox } from './TermsBox';
import styles from './TermsGate.module.css';

/**
 * The Terms before first entry (Omer's Q4, 2026-11-22): a person who signed
 * in with Google and has never accepted them sees this INSTEAD of the area,
 * on every signed-in door, before the two-step gate.
 *
 * The two-step gate's closed door (its frame, brand and type), with one panel:
 * the setup link's own Terms box (TermsBox), one "המשך", and a way out.
 * No data of the workspace is on this screen.
 */
export function TermsGate() {
  const t = useTranslations('auth.terms');
  const router = useRouter();
  const [accepted, setAccepted] = useState(false);
  const [phase, setPhase] = useState<'ready' | 'saving' | 'failed'>('ready');
  const label = useRef<HTMLSpanElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!accepted || phase === 'saving') return;
    setPhase('saving');
    const result = await acceptTerms(label.current?.textContent?.trim() ?? '');
    if (result === 'accepted') {
      // The layout reads again: no marker now, so the area (or the next gate).
      router.refresh();
      return;
    }
    setPhase('failed');
  }

  return (
    <main className={door.gate} data-testid="terms-gate">
      <span className={door.brand}>
        <Logo variant="framed" size={26} />
        GOTCHA
      </span>
      <section className={styles.card} aria-labelledby="terms-gate-title">
        <form className={styles.body} onSubmit={(event) => void submit(event)}>
          <h1 id="terms-gate-title" className={door.title}>
            {t('title')}
          </h1>
          <p className={door.lead}>{t('lede')}</p>
          {phase === 'failed' ? (
            <p className={styles.problem} role="alert" data-testid="terms-failed">
              {t('failed')}
            </p>
          ) : null}
          <TermsBox
            checked={accepted}
            onChange={setAccepted}
            disabled={phase === 'saving'}
            labelRef={label}
            testIdPrefix="terms"
          />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            disabled={!accepted || phase === 'saving'}
            data-testid="terms-continue"
          >
            {phase === 'saving' ? t('busy') : t('continue')}
          </Button>
          <p className={styles.notNow}>
            {t('notNow')}{' '}
            <button
              type="button"
              className={door.quiet}
              onClick={() => void signOut()}
              data-testid="terms-sign-out"
            >
              {t('signOut')}
            </button>
          </p>
        </form>
      </section>
    </main>
  );
}
