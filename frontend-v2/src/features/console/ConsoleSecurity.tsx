'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';

import {
  mfaFlowUrl,
  type AccountSecurity,
  type MfaDevice,
  type MfaFlow,
} from '@/api/contracts/mfa';
import { Button } from '@/design-system/primitives/button/Button';
import { Dialog, DialogClose, DialogContent } from '@/design-system/primitives/overlay/Dialog';

import styles from './Console.module.css';
import { removeMyFactor, type RemoveResult } from './security-actions';

/**
 * ★★ Console · Security (Omer, 2026-11-09): the admin's own two-step sign-in,
 * the legacy account page's Security section as it was (authenticator,
 * recovery codes, remove one). A platform admin always needs both, so this
 * is where they set up, replace (add the new, then remove the old) and
 * regenerate.
 *
 * The changes are Authentik's own flows, framed from the identity provider
 * like the gate's. Nothing says a flow finished: each later load of the
 * frame, and closing it, reads the factors again.
 */
export function ConsoleSecurity({
  security,
  authOrigin,
}: {
  /** `null`: not read. */
  readonly security: AccountSecurity | null;
  readonly authOrigin: string;
}) {
  const t = useTranslations('console.security');
  const router = useRouter();
  const [flow, setFlow] = useState<MfaFlow | null>(null);
  const loads = useRef(0);

  if (security === null || !security.available) {
    return (
      <p className={styles.notice} data-testid="security-unread">
        {t(security === null ? 'unread' : 'unavailable')}
      </p>
    );
  }

  const apps = security.totp;
  const codes = security.recoveryCodes;
  const on = apps.length > 0 && codes.length > 0;

  const open = (next: MfaFlow) => {
    loads.current = 0;
    setFlow(next);
  };

  return (
    <div className={styles.action}>
      <p className={on ? styles.done : styles.refused} data-testid="security-status">
        {t(on ? 'status.on' : 'status.off')}
      </p>

      <section className={styles.card} data-testid="security-authenticator">
        <h2 className={styles.cardTitle}>{t('authenticator.title')}</h2>
        <p className={styles.confirmSentence}>
          {apps.length > 0
            ? t('authenticator.some', { count: apps.length })
            : t('authenticator.none')}
        </p>
        {apps.map((app) => (
          <Factor key={app.id} type="totp" device={app} last={apps.length === 1} />
        ))}
        {apps.length > 0 ? (
          <p className={styles.confirmSentence}>{t('authenticator.replace')}</p>
        ) : null}
        <span>
          <Button onClick={() => open('totp')} data-testid="security-add-authenticator">
            {apps.length > 0 ? t('authenticator.add') : t('authenticator.setUp')}
          </Button>
        </span>
      </section>

      <section className={styles.card} data-testid="security-recovery">
        <h2 className={styles.cardTitle}>{t('recovery.title')}</h2>
        <p className={styles.confirmSentence}>
          {codes.length > 0 ? t('recovery.made') : t('recovery.none')}
        </p>
        <span>
          <Button onClick={() => open('recoveryCodes')} data-testid="security-recovery-codes">
            {codes.length > 0 ? t('recovery.again') : t('recovery.make')}
          </Button>
        </span>
      </section>

      <Dialog
        open={flow !== null}
        onOpenChange={(isOpen) => {
          if (isOpen) return;
          setFlow(null);
          router.refresh();
        }}
      >
        {flow ? (
          <DialogContent
            title={flow === 'totp' ? t('authenticator.title') : t('recovery.title')}
            data-testid="security-flow"
          >
            <iframe
              src={mfaFlowUrl(authOrigin, flow, 0, false)}
              title={flow === 'totp' ? t('authenticator.title') : t('recovery.title')}
              className={styles.flowFrame}
              onLoad={() => {
                loads.current += 1;
                if (loads.current > 1) router.refresh();
              }}
              allow="publickey-credentials-get *; publickey-credentials-create *; clipboard-write"
            />
            <DialogClose asChild>
              <Button data-testid="security-flow-close">{t('close')}</Button>
            </DialogClose>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

/** One factor, with its remove (asked first; the last authenticator says what follows). */
function Factor({
  type,
  device,
  last,
}: {
  readonly type: 'totp';
  readonly device: MfaDevice;
  readonly last: boolean;
}) {
  const t = useTranslations('console.security');
  const format = useFormatter();
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<RemoveResult | null>(null);
  const [pending, start] = useTransition();
  const added = device.createdAt ? new Date(device.createdAt) : null;

  return (
    <div className={styles.confirm} data-testid={`factor-${device.id}`}>
      <p className={styles.confirmSentence}>
        <bdi dir="auto">{device.name || t('authenticator.unnamed')}</bdi>
        {added && Number.isFinite(added.getTime())
          ? ` · ${t('authenticator.added', { date: format.dateTime(added, { dateStyle: 'medium' }) })}`
          : null}
      </p>
      {asking ? (
        <>
          <p className={styles.confirmSentence}>
            {t(last ? 'remove.lastSentence' : 'remove.sentence')}
          </p>
          <span className={styles.confirmActions}>
            <Button
              variant="danger"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setResult(await removeMyFactor(type, device.id));
                  setAsking(false);
                })
              }
              data-testid={`factor-${device.id}-yes`}
            >
              {t('remove.yes')}
            </Button>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              {t('remove.no')}
            </Button>
          </span>
        </>
      ) : (
        <span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAsking(true)}
            data-testid={`factor-${device.id}-remove`}
          >
            {t('remove.action')}
          </Button>
        </span>
      )}
      {result && !result.ok ? (
        <p className={styles.refused} role="alert">
          {t(`remove.${result.reason}`)}
        </p>
      ) : null}
    </div>
  );
}
