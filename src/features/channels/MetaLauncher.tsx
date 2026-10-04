'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import type { EmbeddedSignupLaunch, InspectResponse } from '@/api/contracts/whatsapp-connect';

import { ConnectNumbers } from './ConnectNumbers';
import { useFacebookSdk } from './signup/facebook-sdk';
import {
  classifySignupAbort,
  interpretSignupMessage,
  isMetaOrigin,
  mergeSignupAssets,
  readAuthCode,
  type SignupAssets,
} from './signup/whatsapp-signup-flow';
import { inspectNumbers } from './whatsapp-actions';
import styles from './Channels.module.css';

/**
 * 13c's "Add another number" — live (Omer, 2026-10-04): Meta's Embedded
 * Signup, launched with the parameters the server gives
 * (`/api/channels/config`), never assembled here.
 *
 *   click  → Meta's popup (FB.login)            — nothing is connected
 *   code   → inspect the numbers on that account — nothing is connected
 *   choose → `ConnectNumbers`, one number at a time; THAT writes at Meta
 *
 * The popup tells us the business and its WABA ids by `postMessage`; only a
 * Meta origin is believed (`isMetaOrigin` — copied, with its tests, because
 * `endsWith('facebook.com')` alone accepts `evilfacebook.com`). They are kept
 * in a ref: the message lands after the click, and a state value captured by
 * the login callback would be empty.
 */
export function MetaLauncher({ launch }: { readonly launch: EmbeddedSignupLaunch | null }) {
  const t = useTranslations('channels.whatsapp');
  const sdk = useFacebookSdk(launch?.configured ? launch.appId : '');
  const assets = useRef<SignupAssets>({});
  const [stage, setStage] = useState<'idle' | 'authorizing' | 'reading'>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const [inspection, setInspection] = useState<InspectResponse | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isMetaOrigin(event.origin)) return;
      const message = interpretSignupMessage(event.data);
      if (message.kind === 'cancel') {
        setStage('idle');
        setProblem(t('launcher.cancelled'));
      } else if (message.kind === 'assets') {
        assets.current = mergeSignupAssets(assets.current, message.assets);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [t]);

  if (!launch?.configured) {
    return (
      <span
        className={styles.addNumber}
        aria-disabled="true"
        title={t('launcher.notConfigured')}
        data-testid="whatsapp-add-number"
      >
        {t('addNumber')}
      </span>
    );
  }

  function start() {
    const FB = window.FB;
    if (!FB || !launch) {
      setProblem(t('launcher.unavailable'));
      return;
    }
    setProblem(null);
    setInspection(null);
    assets.current = {};
    setStage('authorizing');
    try {
      FB.login(
        (response: unknown) => {
          const code = readAuthCode(response);
          if (!code) {
            if (classifySignupAbort(response) === 'NO_CODE') setProblem(t('launcher.noCode'));
            setStage('idle');
            return;
          }
          setStage('reading');
          // The assets message can trail the callback by a beat.
          window.setTimeout(() => {
            void inspectNumbers(code, assets.current).then((result) => {
              setStage('idle');
              if (result) setInspection(result);
              else setProblem(t('launcher.inspectFailed'));
            });
          }, 600);
        },
        {
          config_id: launch.configId,
          response_type: launch.responseType,
          override_default_response_type: launch.overrideDefaultResponseType,
          extras: launch.extras,
        },
      );
    } catch {
      setStage('idle');
      setProblem(t('launcher.unavailable'));
    }
  }

  return (
    <div className={styles.launcher} data-testid="meta-launcher">
      <button
        type="button"
        className={styles.addNumber}
        disabled={sdk !== 'ready' || stage !== 'idle'}
        title={sdk === 'unavailable' ? t('launcher.unavailable') : undefined}
        data-testid="whatsapp-add-number"
        onClick={start}
      >
        {stage === 'authorizing'
          ? t('launcher.opening')
          : stage === 'reading'
            ? t('launcher.reading')
            : t('addNumber')}
      </button>
      {problem ? (
        <p className={styles.launcherProblem} role="alert" data-testid="launcher-problem">
          {problem}
        </p>
      ) : null}
      {inspection ? <ConnectNumbers inspection={inspection} coexistence={null} /> : null}
    </div>
  );
}
