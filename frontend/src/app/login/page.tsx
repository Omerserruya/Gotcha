"use client";

/**
 * /login is a thin redirect shim, not a screen.
 *
 * There is no GOTCHA credential form - Authentik owns the login UI. A standalone
 * "click Sign in" page was a redundant extra step, so this route now hands the
 * browser straight to Authentik (or to the app if already signed in). All the
 * existing `?next=`/`?redirect=` callers keep working; the user just never sees
 * a duplicate GOTCHA login screen.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { useAuth } from "@/context/AuthContext";
import { beginLogin, consumeSigningOut } from "@/lib/oidc";
import { isMarketingHost, appOrigin, isSafeReturnPath } from "@/lib/marketing-origin";

function LoginRedirect() {
  const { user, isLoading } = useAuth();
  const params = useSearchParams();
  const started = useRef(false);
  const [failed, setFailed] = useState(false);
  // Landed here BY signing out (marker in sessionStorage, or ?signedOut=1 from
  // the IdP-unreachable fallback). Show that it worked instead of bouncing
  // straight back into a login.
  const [signedOut, setSignedOut] = useState(() => params.get("signedOut") === "1");

  const rawNext = params.get("next") || params.get("redirect");
  // Not just "starts with /": `//evil.test` does too, and window.location
  // resolves it as a protocol-relative url to another site - which would make
  // this route an open redirect. isSafeReturnPath rejects that form.
  const next = isSafeReturnPath(rawNext) ? rawNext : "/";

  const start = useCallback(() => {
    started.current = true;
    setFailed(false);
    // A sign-out in progress must never be turned back into a sign-in.
    //
    // Signing out clears local state, and this shim is where the app sends
    // anyone without a session - so with the IdP session still alive it would
    // silently re-authenticate and drop the user right back where they were.
    // Which is exactly what production did: press Sign out, watch a flash, be
    // logged in again.
    if (signedOut || consumeSigningOut()) {
      setSignedOut(true);
      return;
    }
    // Never run the OIDC flow on the marketing host. Any client-side route
    // change lands here without a request reaching nginx, so the vhost redirect
    // to the application host cannot have run - and from this origin Authentik
    // refuses the discovery fetch (CORS is granted only to registered redirect
    // URIs), which strands the user on the failure card. Hop hosts first; the
    // shim then runs again on the application origin, where it works.
    if (typeof window !== "undefined" && isMarketingHost(window.location.origin) && appOrigin) {
      window.location.replace(`${appOrigin}/login${window.location.search}`);
      return;
    }
    if (user) {
      window.location.assign(next);
      return;
    }
    // Straight to Authentik's hosted login.
    //
    // The failure path matters as much as the happy one: reaching Authentik
    // begins with a cross-origin discovery fetch, and a momentary outage there
    // returns no CORS headers, so the browser rejects it. Discarding that
    // rejection (this was `void beginLogin(next)`) left the user on a spinner
    // that never resolved and never retried, which reads as a dead product
    // rather than a blip. Release the latch so Retry genuinely tries again.
    beginLogin(next).catch(() => {
      started.current = false;
      setFailed(true);
    });
  }, [user, next, signedOut]);

  useEffect(() => {
    if (isLoading || started.current) return;
    start();
  }, [isLoading, start]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-white px-6 text-center">
      <Image src="/logo_icon.png" alt="GOTCHA" width={150} height={35} style={{ height: 35, width: "auto" }} priority />
      {signedOut ? (
        <>
          <p className="text-sm font-medium text-gray-900">You are signed out.</p>
          <p className="max-w-xs text-sm text-gray-500">
            Your session on this device has ended.
          </p>
          <button
            type="button"
            onClick={() => { setSignedOut(false); started.current = false; }}
            data-testid="login-signin-again"
            className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
          >
            Sign in again
          </button>
        </>
      ) : failed ? (
        <>
          <p className="text-sm font-medium text-gray-900">We could not reach secure sign-in.</p>
          <p className="max-w-xs text-sm text-gray-500">
            This is usually momentary. Try again, and if it keeps happening let your administrator know.
          </p>
          <button
            type="button"
            onClick={start}
            data-testid="login-retry"
            className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
          >
            Try again
          </button>
        </>
      ) : (
        <>
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary-200 border-t-primary-600" />
          <p className="text-sm text-gray-400">Taking you to secure sign-in…</p>
        </>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-white"><span className="h-6 w-6 animate-spin rounded-full border-2 border-primary-200 border-t-primary-600" /></div>}>
      <LoginRedirect />
    </Suspense>
  );
}
