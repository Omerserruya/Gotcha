'use client';

import { useEffect, useRef, useState } from 'react';

import type { EmbeddedSignupLaunch } from '@/api/contracts/whatsapp-connect';
import { logger } from '@/observability/logger';

import { useFacebookSdk } from './facebook-sdk';
import {
  classifySignupAbort,
  describeSignupResponse,
  interpretSignupMessage,
  isMetaOrigin,
  mergeSignupAssets,
  readAuthCode,
  type SignupAssets,
} from './whatsapp-signup-flow';

export type CodeProblem = 'cancelled' | 'noCode' | 'exchangeFailed' | 'unavailable';

/** What is done with Meta's code: the tenant inspects, the console connects. */
export type CodeExchange<T> = (
  code: string,
  assets: SignupAssets,
  launch: EmbeddedSignupLaunch,
) => Promise<T | null>;

/**
 * Meta's Embedded Signup window, up to and including the code - and then
 * whatever the caller does with it (`exchange`). Launched with the server's
 * parameters, never assembled here.
 *
 *   start() → Meta's window (FB.login)
 *   code    → exchange(code, assets)        - null is a failed exchange
 *
 * The window tells us the business and its WABA ids by `postMessage`; only a
 * Meta origin is believed (`isMetaOrigin` - copied with its tests, because
 * `endsWith('facebook.com')` alone accepts `evilfacebook.com`). They are kept
 * in a ref: the message lands after the click, and a state value captured by
 * the login callback would be empty.
 *
 * Shared by the tenant's connect (`useMetaSignup`) and the console's platform
 * number (`PlatformConnect`): one window, one origin check, two exchanges.
 */
export function useMetaCode<T>(appId: string, exchange: CodeExchange<T>) {
  const sdk = useFacebookSdk(appId);
  const assets = useRef<SignupAssets>({});
  const [stage, setStage] = useState<'idle' | 'authorizing' | 'reading'>('idle');
  const [problem, setProblem] = useState<CodeProblem | null>(null);
  const [result, setResult] = useState<T | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isMetaOrigin(event.origin)) return;
      const message = interpretSignupMessage(event.data);
      if (message.kind === 'cancel') {
        setStage('idle');
        setProblem('cancelled');
      } else if (message.kind === 'assets') {
        assets.current = mergeSignupAssets(assets.current, message.assets);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /** Synchronous to the click: Meta's window is a popup, and a popup needs the gesture. */
  function start(launch: EmbeddedSignupLaunch | null) {
    const FB = window.FB;
    if (!FB || !launch?.configured) {
      setProblem('unavailable');
      return;
    }
    setProblem(null);
    setResult(null);
    assets.current = {};
    setStage('authorizing');
    try {
      FB.login(
        (response: unknown) => {
          const code = readAuthCode(response);
          if (!code) {
            // Said either way, and logged: a window closed without finishing
            // must never look like a sheet that did nothing.
            logger.warn('whatsapp.signup_no_code', { response: describeSignupResponse(response) });
            setProblem(classifySignupAbort(response) === 'NO_CODE' ? 'noCode' : 'cancelled');
            setStage('idle');
            return;
          }
          setStage('reading');
          // The assets message can trail the callback by a beat.
          window.setTimeout(() => {
            void exchange(code, assets.current, launch).then((answer) => {
              setStage('idle');
              if (answer) setResult(answer);
              else setProblem('exchangeFailed');
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
      setProblem('unavailable');
    }
  }

  return { sdk, stage, problem, result, start, reset: () => setResult(null) };
}
