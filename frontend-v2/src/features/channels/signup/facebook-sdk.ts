'use client';

import { useEffect, useState } from 'react';

/**
 * Meta's JavaScript SDK, loaded once - after ChatCenter's `facebook-sdk.ts`,
 * whose reasons carry over: the script is async, so a click must wait for
 * `ready`; and `connect.facebook.net` is blocked by most ad blockers, so a
 * timeout says "unavailable" rather than "try again".
 *
 * The SDK version must match the one the auth service exchanges the code
 * against (`FB_JS_SDK_GRAPH_VERSION`). Move one, review the other.
 */
export const FB_SDK_VERSION = 'v26.0';
const SCRIPT_ID = 'facebook-jssdk';
const SCRIPT_SRC = 'https://connect.facebook.net/en_US/sdk.js';
const READY_TIMEOUT_MS = 8000;

export type FacebookSdkStatus = 'loading' | 'ready' | 'unavailable';

interface FacebookSdk {
  init(options: { appId: string; version: string; xfbml: boolean; cookie: boolean }): void;
  login(callback: (response: unknown) => void, options: Record<string, unknown>): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

export function useFacebookSdk(appId: string): FacebookSdkStatus {
  const [status, setStatus] = useState<FacebookSdkStatus>('loading');

  useEffect(() => {
    if (!appId) return;
    let done = false;
    const ready = () => {
      if (done) return;
      done = true;
      setStatus('ready');
    };
    if (window.FB) {
      window.FB.init({ appId, version: FB_SDK_VERSION, xfbml: false, cookie: true });
      // Already loaded: ready on the next tick, not inside the effect's body.
      const tick = window.setTimeout(ready, 0);
      return () => window.clearTimeout(tick);
    }
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, version: FB_SDK_VERSION, xfbml: false, cookie: true });
      ready();
    };
    if (!document.getElementById(SCRIPT_ID)) {
      const script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.crossOrigin = 'anonymous';
      document.body.appendChild(script);
    }
    const timer = window.setTimeout(() => {
      if (!done) {
        done = true;
        setStatus('unavailable');
      }
    }, READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [appId]);

  // No app id: nothing to load, so it never will be.
  return appId ? status : 'unavailable';
}
