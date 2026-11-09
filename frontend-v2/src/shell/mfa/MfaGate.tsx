'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { mfaFlowUrl, type MfaGate as Gate } from '@/api/contracts/mfa';
import { signOut } from '@/auth/sign-out';
import { Logo } from '@/design-system/brand/Logo';

import { checkMfaGate } from './mfa-actions';
import styles from './MfaGate.module.css';

/** How often the open gate re-checks (the legacy gate's 3s). */
export const MFA_POLL_MS = 3000;
/** After the framed flow moves on: a beat for Authentik to persist, then check. */
export const MFA_SETTLE_MS = 500;

/**
 * ★★ THE MFA GATE (legacy `MfaEnrollmentGate`, ported as it is).
 *
 * Drawn by the layouts INSTEAD of the product, for a person the platform
 * requires to have two-step sign-in who has not enrolled: an authenticator,
 * then recovery codes. Their only other move is to sign out.
 *
 * The steps are Authentik's own setup flows, framed from the identity
 * provider's origin (its gateway allows framing from *.gotcha.co.il, and our
 * `frame-src` names that origin). The authenticator step chains into the
 * recovery-codes flow by a RELATIVE `next`. Nothing tells us a flow
 * finished, so the gate re-checks: every 3s, on focus, and on each load of
 * the frame after its first (masked, so Authentik's own end page never shows).
 * Both factors in: the server's `mustEnroll` turns false, and a refresh
 * draws the product.
 *
 * A failed re-check keeps the gate exactly as it was: a network blip must
 * never release it.
 */
export function MfaGate({
  initial,
  authOrigin,
}: {
  readonly initial: Gate;
  readonly authOrigin: string;
}) {
  const t = useTranslations('security.gate');
  const tNav = useTranslations('navigation');
  const router = useRouter();
  const [gate, setGate] = useState(initial);
  const [verifying, setVerifying] = useState(false);
  const [nonce, setNonce] = useState(0);
  const loads = useRef(0);
  const released = useRef(false);

  const check = useCallback(async () => {
    const next = await checkMfaGate().catch(() => null);
    if (next === null) return;
    setGate(next);
    if (!next.mustEnroll && !released.current) {
      released.current = true;
      router.refresh();
    }
  }, [router]);

  useEffect(() => {
    const timer = setInterval(() => void check(), MFA_POLL_MS);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [check]);

  const step = gate.hasAuthenticator ? 'recoveryCodes' : 'totp';
  // A new step (or a restart) starts its own count: its first load is its own render.
  useEffect(() => {
    loads.current = 0;
  }, [step, nonce]);

  const verify = (after = 0) => {
    setVerifying(true);
    setTimeout(() => {
      void check().finally(() => setVerifying(false));
    }, after);
  };
  const onFrameLoad = () => {
    loads.current += 1;
    if (loads.current > 1) verify(MFA_SETTLE_MS);
  };

  const reason = gate.reason ?? 'other';
  const done = gate.hasAuthenticator;

  return (
    <main className={styles.gate} data-testid="mfa-gate">
      <span className={styles.brand}>
        <Logo variant="framed" size={26} />
        GOTCHA
      </span>
      <section className={styles.card} aria-labelledby="mfa-gate-title">
        <header className={styles.head}>
          <h1 id="mfa-gate-title" className={styles.title}>
            {t('title')}
          </h1>
          <p className={styles.lead} data-testid="mfa-gate-reason">
            {t(`reason.${reason}`)}
          </p>
          <ol className={styles.steps}>
            <li data-state={done ? 'done' : 'current'} data-testid="mfa-step-totp">
              <span className={styles.dot} aria-hidden="true">
                {done ? '✓' : '1'}
              </span>
              {t('step.authenticator')}
              {done ? <span className={styles.srOnly}>{t('step.done')}</span> : null}
            </li>
            <li data-state={done ? 'current' : 'todo'} data-testid="mfa-step-recovery">
              <span className={styles.dot} aria-hidden="true">
                2
              </span>
              {t('step.recovery')}
            </li>
          </ol>
        </header>

        <div className={styles.flow}>
          <iframe
            key={`${step}-${nonce}`}
            src={mfaFlowUrl(authOrigin, step, nonce)}
            title={step === 'totp' ? t('frame.authenticator') : t('step.recovery')}
            className={styles.frame}
            onLoad={onFrameLoad}
            allow="publickey-credentials-get *; publickey-credentials-create *; clipboard-write"
            data-testid="mfa-flow"
          />
          {verifying ? (
            <div className={styles.mask} role="status" data-testid="mfa-verifying">
              {t('finishing')}
            </div>
          ) : null}
        </div>

        <footer className={styles.foot}>
          <button
            type="button"
            className={styles.quiet}
            onClick={() => void signOut()}
            data-testid="mfa-sign-out"
          >
            {tNav('account.signOut')}
          </button>
          <span className={styles.actions}>
            <button
              type="button"
              className={styles.quiet}
              onClick={() => setNonce((n) => n + 1)}
              data-testid="mfa-restart"
            >
              {t('restart')}
            </button>
            <button
              type="button"
              className={styles.primary}
              onClick={() => verify()}
              disabled={verifying}
              data-testid="mfa-finished"
            >
              {t('finished')}
            </button>
          </span>
        </footer>
      </section>
    </main>
  );
}
