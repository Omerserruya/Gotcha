'use client';

import { Check, ExternalLink, Info, Server, Smartphone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import {
  isConnectable,
  needsPin,
  type Candidate,
  type EmbeddedSignupLaunch,
} from '@/api/contracts/whatsapp-connect';
import drawer from '@/design-system/styles/drawer.module.css';
import { Link, useRouter } from '@/i18n/navigation';

import { useMetaSignup } from './signup/use-meta-signup';
import { connectNumber } from './whatsapp-actions';
import styles from './Channels.module.css';

type Path = 'business_app' | 'new';
const STEPS = ['where', 'meta', 'number', 'learn'] as const;

/**
 * 13c → 13d, as 02 draws them: one sheet, four steps.
 *
 *   1 Where it lives — one question before Meta (business app, or not)
 *   2 Meta           — Meta's window; nothing is connected
 *   3 Number         — exactly one number per pass, its PIN if it needs one
 *   4 Learn          — 13e, the import, once Meta sends the history
 *
 * Only "Continue with Meta" opens Meta, with the server's launch for the
 * choice made here (backend 294adc0c) — fetched up front for both, since the
 * popup must open inside the click — and inspect follows that choice's path.
 */
export function ConnectWhatsApp({
  launches,
  closeHref,
}: {
  /** The server's launch per choice (backend 294adc0c). */
  readonly launches: {
    readonly coexistence: EmbeddedSignupLaunch | null;
    readonly newNumber: EmbeddedSignupLaunch | null;
  };
  readonly closeHref: string;
}) {
  const t = useTranslations('channels.whatsapp.wizard');
  const router = useRouter();
  const [path, setPath] = useState<Path>('business_app');
  const launch = path === 'business_app' ? launches.coexistence : launches.newNumber;
  const meta = useMetaSignup(
    [launches.coexistence, launches.newNumber].find((l) => l?.configured)?.appId ?? '',
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const candidates = meta.inspection?.candidates ?? [];
  const step: (typeof STEPS)[number] = meta.inspection
    ? 'number'
    : meta.stage === 'idle'
      ? 'where'
      : 'meta';
  const current = STEPS.indexOf(step);
  const pick = candidates.find((c) => c.phoneNumberId === chosen) ?? null;
  const pinNeeded = pick !== null && needsPin(pick);

  function connect() {
    if (!meta.inspection || !pick) return;
    setFailure(null);
    startTransition(async () => {
      const result = await connectNumber(
        meta.inspection!.sessionId,
        pick.phoneNumberId,
        pinNeeded ? pin : undefined,
      );
      if (!result.ok) {
        setFailure(result.message === 'pin' ? t('number.pinInvalid') : t('number.failed'));
        return;
      }
      if (result.pendingAction) {
        setFailure(result.message ?? t('number.pending'));
        return;
      }
      // 4 · Learn: 13e shows the import once Meta sends the history.
      router.push(`/settings/channels?panel=whatsapp&view=progress`);
      router.refresh();
    });
  }

  return (
    <>
      <ol className={styles.stepper} data-testid="connect-steps">
        {STEPS.map((key, i) => (
          <li
            key={key}
            className={styles.step}
            data-state={i < current ? 'done' : i === current ? 'current' : 'next'}
            aria-current={i === current ? 'step' : undefined}
          >
            <span className={styles.stepDot}>{i < current ? <Check size={11} /> : i + 1}</span>
            {t(`steps.${key}`)}
          </li>
        ))}
      </ol>

      <div className={drawer.drawerBody}>
        {step === 'number' ? (
          <NumberStep
            candidates={candidates}
            chosen={chosen}
            onChoose={(id) => {
              setChosen(id);
              setPin('');
              setFailure(null);
            }}
            pin={pin}
            onPin={setPin}
            pinNeeded={pinNeeded}
          />
        ) : (
          <>
            <h3 className={styles.connectQuestion}>{t('where.question')}</h3>
            <div role="radiogroup" aria-label={t('where.question')} className={styles.paths}>
              {(['business_app', 'new'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={path === key}
                  className={styles.pathCard}
                  disabled={step === 'meta'}
                  data-testid={`path-${key}`}
                  onClick={() => setPath(key)}
                >
                  <span className={styles.pathRadio} aria-hidden="true" />
                  <span className={styles.pathBody}>
                    <span className={styles.pathTitle}>
                      {key === 'business_app' ? (
                        <Smartphone size={15} aria-hidden="true" />
                      ) : (
                        <Server size={15} aria-hidden="true" />
                      )}
                      {t(`where.${key}.title`)}
                      {key === 'business_app' ? (
                        <span className={styles.pathBadge}>{t('where.mostCommon')}</span>
                      ) : null}
                    </span>
                    <span className={styles.pathText}>{t(`where.${key}.body`)}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className={styles.needs}>
              <p className={styles.needsTitle}>{t('needs.title')}</p>
              <ul>
                {(['login', 'phone', 'payment'] as const).map((key) => (
                  <li key={key}>
                    <Check size={14} aria-hidden="true" />
                    {t(`needs.${key}`)}
                  </li>
                ))}
              </ul>
            </div>
            {step === 'meta' ? (
              <p className={styles.connectWaiting} role="status" data-testid="connect-waiting">
                {meta.stage === 'reading' ? t('meta.reading') : t('meta.waiting')}
              </p>
            ) : null}
            <p className={styles.connectNote}>
              <Info size={14} aria-hidden="true" />
              {t('where.note')}
            </p>
          </>
        )}
        {meta.problem ? (
          <p className={styles.launcherProblem} role="alert" data-testid="launcher-problem">
            {t(`problem.${meta.problem}`)}
          </p>
        ) : null}
        {failure ? (
          <p className={styles.launcherProblem} role="alert" data-testid="connect-failure">
            {failure}
          </p>
        ) : null}
      </div>

      <footer className={drawer.drawerFoot}>
        {step === 'number' ? (
          <>
            <button
              type="button"
              className={styles.connectPrimary}
              disabled={
                !pick ||
                !isConnectable(pick) ||
                pick.alreadyConnectedHere ||
                isPending ||
                (pinNeeded && !/^\d{6}$/.test(pin))
              }
              data-testid="connect-number"
              onClick={connect}
            >
              {pick?.usesBusinessApp ? t('number.connectImport') : t('number.connect')}
            </button>
            <button
              type="button"
              className={styles.connectCancel}
              data-testid="connect-back"
              onClick={() => {
                meta.reset();
                setChosen(null);
              }}
            >
              {t('number.back')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={styles.connectPrimary}
              disabled={!launch?.configured || meta.sdk !== 'ready' || step === 'meta'}
              title={
                !launch?.configured
                  ? t('problem.notConfigured')
                  : meta.sdk === 'unavailable'
                    ? t('problem.unavailable')
                    : undefined
              }
              data-testid="continue-meta"
              onClick={() => meta.start(launch)}
            >
              {t('where.continue')}
              <ExternalLink size={13} aria-hidden="true" />
            </button>
            <Link href={closeHref} className={styles.connectCancel} data-testid="connect-cancel">
              {t('cancel')}
            </Link>
          </>
        )}
      </footer>
    </>
  );
}

/** 13d — which number GOTCHA answers. One per pass, so nothing else is rebound by accident. */
function NumberStep({
  candidates,
  chosen,
  onChoose,
  pin,
  onPin,
  pinNeeded,
}: {
  readonly candidates: readonly Candidate[];
  readonly chosen: string | null;
  readonly onChoose: (id: string) => void;
  readonly pin: string;
  readonly onPin: (pin: string) => void;
  readonly pinNeeded: boolean;
}) {
  const t = useTranslations('channels.whatsapp.wizard.number');
  if (candidates.length === 0) {
    return (
      <p className={styles.empty} data-testid="connect-none">
        {t('none')}
      </p>
    );
  }
  return (
    <>
      <h3 className={styles.connectQuestion}>{t('question')}</h3>
      <p className={styles.connectLead}>{t('lead', { count: candidates.length })}</p>
      <div role="radiogroup" aria-label={t('question')} className={styles.paths}>
        {candidates.map((c) => {
          const off = c.alreadyConnectedHere || !isConnectable(c);
          return (
            <button
              key={c.phoneNumberId}
              type="button"
              role="radio"
              aria-checked={chosen === c.phoneNumberId}
              disabled={off}
              className={styles.pathCard}
              data-testid={`candidate-${c.phoneNumberId}`}
              onClick={() => onChoose(c.phoneNumberId)}
            >
              <span className={styles.pathRadio} aria-hidden="true" />
              <span className={styles.pathBody}>
                <span className={styles.pathTitle}>
                  {c.phoneNumber ?? c.phoneNumberId}
                  {c.name ? <span className={styles.pathName}>{c.name}</span> : null}
                </span>
                <span className={styles.pathText}>
                  {c.alreadyConnectedHere
                    ? t('flow.connected')
                    : !isConnectable(c)
                      ? (c.message ?? t('flow.blocked'))
                      : c.usesBusinessApp
                        ? t('flow.businessApp')
                        : needsPin(c)
                          ? t('flow.pin')
                          : t('flow.new')}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {pinNeeded ? (
        <label className={styles.pinField}>
          <span>{t('pin')}</span>
          <input
            value={pin}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            onChange={(e) => onPin(e.target.value.replace(/\D/g, ''))}
            data-testid="connect-pin"
          />
        </label>
      ) : null}
      {/*
        02's "Who answers it", the import switch and "Choose contacts". The
        connect route takes none of them: who answers is set on the number
        after, Meta sends history once on its own, and private contacts are
        their own list. Drawn, each saying so.
      */}
      <div
        className={styles.drawnRow}
        aria-disabled="true"
        title={t('ownerNotYet')}
        data-testid="connect-owner"
      >
        <span className={styles.needsTitle}>{t('owner')}</span>
      </div>
      <div
        className={styles.drawnRow}
        aria-disabled="true"
        title={t('importWhy')}
        data-testid="connect-import"
      >
        <span className={styles.needsTitle}>{t('import')}</span>
        <span className={styles.pathText}>{t('importBody')}</span>
      </div>
      <div
        className={styles.drawnRow}
        aria-disabled="true"
        title={t('contactsNotYet')}
        data-testid="connect-contacts"
      >
        <span className={styles.pathText}>{t('contacts')}</span>
      </div>
    </>
  );
}
