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

import { Suspense, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { useAuth } from "@/context/AuthContext";
import { beginLogin } from "@/lib/oidc";

function LoginRedirect() {
  const { user, isLoading } = useAuth();
  const params = useSearchParams();
  const started = useRef(false);

  const rawNext = params.get("next") || params.get("redirect");
  const next = rawNext && rawNext.startsWith("/") ? rawNext : "/";

  useEffect(() => {
    if (isLoading || started.current) return;
    started.current = true;
    if (user) {
      window.location.assign(next);
    } else {
      // Straight to Authentik's hosted login.
      void beginLogin(next);
    }
  }, [isLoading, user, next]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-white">
      <Image src="/logo_icon.png" alt="GOTCHA" width={150} height={35} style={{ height: 35, width: "auto" }} priority />
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary-200 border-t-primary-600" />
      <p className="text-sm text-gray-400">Taking you to secure sign-in…</p>
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
