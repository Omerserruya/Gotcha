'use client';

import { useEffect, useRef, useState } from 'react';

import type { EmbeddedSignupLaunch, InspectResponse } from '@/api/contracts/whatsapp-connect';

import { inspectNumbers } from '../whatsapp-actions';
import { useFacebookSdk } from './facebook-sdk';
import {
  classifySignupAbort,
  interpretSignupMessage,
  isMetaOrigin,
  mergeSignupAssets,
  readAuthCode,
  type SignupAssets,
} from './whatsapp-signup-flow';

export type SignupProblem = 'cancelled' | 'noCode' | 'inspectFailed' | 'unavailable';

/**
 * Meta's Embedded Signup, as one hook: launched with the server's parameters
 * (`/api/channels/config`), never assembled here.
 *
 *   start() → Meta's window (FB.login)              — nothing is connected
 *   code    → inspect the numbers on that account   — nothing is connected
 *
 * The window tells us the business and its WABA ids by `postMessage`; only a
 * Meta origin is believed (`isMetaOrigin` — copied with its tests, because
 * `endsWith('facebook.com')` alone accepts `evilfacebook.com`). They are kept
 * in a ref: the message lands after the click, and a state value captured by
 * the login callback would be empty.
 */
export function useMetaSignup(launch: EmbeddedSignupLaunch | null) {
  const sdk = useFacebookSdk(launch?.configured ? launch.appId : '');
  const assets = useRef<SignupAssets>({});
  const [stage, setStage] = useState<'idle' | 'authorizing' | 'reading'>('idle');
  const [problem, setProblem] = useState<SignupProblem | null>(null);
  const [inspection, setInspection] = useState<InspectResponse | null>(null);

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

  function start() {
    const FB = window.FB;
    if (!FB || !launch?.configured) {
      setProblem('unavailable');
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
            if (classifySignupAbort(response) === 'NO_CODE') setProblem('noCode');
            setStage('idle');
            return;
          }
          setStage('reading');
          // The assets message can trail the callback by a beat.
          window.setTimeout(() => {
            void inspectNumbers(code, assets.current).then((result) => {
              setStage('idle');
              if (result) setInspection(result);
              else setProblem('inspectFailed');
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

  return { sdk, stage, problem, inspection, start, reset: () => setInspection(null) };
}
