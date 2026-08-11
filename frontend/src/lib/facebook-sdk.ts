"use client";

/**
 * The one place the Facebook JavaScript SDK is loaded.
 *
 * Why this module exists
 * ----------------------
 * The loader used to live inline in `app/channels/content.tsx`. When the
 * WhatsApp signup launcher moved to `app/settings/channels/whatsapp/`, the
 * loader stayed behind: the old page loaded an SDK it no longer used, and the
 * new page used an SDK nobody loaded. A direct visit to
 * /settings/channels/whatsapp got `window.FB === undefined` and a "could not
 * load" message with no real cause.
 *
 * Copying the loader into the second page would have worked and would have
 * left two copies of the app id and the SDK version to drift apart. So there
 * is one loader, and it is a hook so callers can wait for it rather than
 * guess.
 *
 * Readiness is the point
 * ----------------------
 * The script is `async`, so `window.FB` is undefined for a while AFTER the
 * component mounts. Any code that reads `window.FB` synchronously on a click
 * is racing the network and loses whenever the user is quick or the
 * connection is slow. Callers should disable their button until `ready`.
 *
 * "unavailable" is a real, common outcome
 * ---------------------------------------
 * `connect.facebook.net` is blocked by most ad blockers and by some corporate
 * networks. That is not an error we can fix by retrying, and "refresh and try
 * again" is actively misleading advice for it. We time out and say what is
 * actually likely.
 */

import { useEffect, useState } from "react";

const SCRIPT_ID = "facebook-jssdk";
const SCRIPT_SRC = "https://connect.facebook.net/en_US/sdk.js";

/**
 * SDK version, deliberately independent of `META_GRAPH_VERSION`.
 *
 * The SDK mints the Embedded Signup authorization code against ITS OWN
 * version, which is why the auth service pins `FB_JS_SDK_GRAPH_VERSION` to
 * the same value in `services/auth/src/routes/channels.ts`. Move one and
 * review the other.
 */
export const FB_SDK_VERSION = "v25.0";

/** How long to wait before calling it blocked rather than slow. */
const READY_TIMEOUT_MS = 8000;

export type FacebookSdkStatus = "loading" | "ready" | "unavailable";

declare global {
  interface Window {
    FB?: any;
    fbAsyncInit?: () => void;
  }
}

/**
 * Load the SDK once per page session and report when it can actually be used.
 *
 * Idempotent: several components may call this. The script tag is injected at
 * most once, and a caller that mounts after the SDK is already initialised
 * goes straight to `ready` rather than waiting for an init that has been and
 * gone.
 */
export function useFacebookSdk(appId: string): FacebookSdkStatus {
  const [status, setStatus] = useState<FacebookSdkStatus>("loading");

  useEffect(() => {
    if (!appId) {
      // No app id configured in this environment. Nothing to wait for, and
      // saying so beats spinning forever.
      setStatus("unavailable");
      return;
    }

    let cancelled = false;

    // Already initialised by an earlier mount or another page. `FB.getLoginStatus`
    // only exists after init, so its presence is the honest readiness signal;
    // `window.FB` alone can be set while init is still pending.
    if (typeof window.FB?.getLoginStatus === "function") {
      setStatus("ready");
      return;
    }

    if (!document.getElementById(SCRIPT_ID)) {
      window.fbAsyncInit = function () {
        window.FB?.init({
          appId,
          autoLogAppEvents: true,
          xfbml: true,
          version: FB_SDK_VERSION,
        });
      };

      const script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.crossOrigin = "anonymous";
      // A blocked request fires `error` immediately rather than hanging, so
      // ad-blocked users get told the truth without waiting out the timeout.
      script.onerror = () => {
        if (!cancelled) setStatus("unavailable");
      };
      document.body.appendChild(script);
    }

    // The script tag existing does not mean init has finished, and React may
    // mount this after `fbAsyncInit` already ran. Poll rather than rely on a
    // callback we might have missed.
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (cancelled) return;
      if (typeof window.FB?.getLoginStatus === "function") {
        window.clearInterval(timer);
        setStatus("ready");
        return;
      }
      if (Date.now() - started > READY_TIMEOUT_MS) {
        window.clearInterval(timer);
        setStatus("unavailable");
      }
    }, 150);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [appId]);

  return status;
}
