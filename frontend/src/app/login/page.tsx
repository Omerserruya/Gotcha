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
import { beginLogin } from "@/lib/oidc";

function LoginRedirect() {
  const { user, isLoading } = useAuth();
  const params = useSearchParams();
  const started = useRef(false);
  const [failed, setFailed] = useState(false);

  const rawNext = params.get("next") || params.get("redirect");
  const next = rawNext && rawNext.startsWith("/") ? rawNext : "/";

  const start = useCallback(() => {
    started.current = true;
    setFailed(false);
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
  }, [user, next]);

  useEffect(() => {
    if (isLoading || started.current) return;
    start();
  }, [isLoading, start]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-white px-6 text-center">
      <Image src="/logo_icon.png" alt="GOTCHA" width={150} height={35} style={{ height: 35, width: "auto" }} priority />
      {failed ? (
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
