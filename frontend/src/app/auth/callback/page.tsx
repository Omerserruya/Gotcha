"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { beginLogin, completeLogin } from "@/lib/oidc";
import { useAuth } from "@/context/AuthContext";

/**
 * One-shot guard for the stale-state auto-restart below. sessionStorage, not a
 * ref: the restart round-trips through Authentik, so a ref would reset and a
 * broken IdP could bounce the browser forever.
 */
const RETRY_KEY = "oidc:callback_retry";

/**
 * OIDC redirect target.
 *
 * Authentik sends the browser here with ?code=&state=. We verify state,
 * exchange the code using the PKCE verifier, and hand the tokens to
 * AuthContext. This is the only route that turns an authorization code into a
 * session.
 */
export default function AuthCallbackPage() {
  const router = useRouter();
  const { adoptSession } = useAuth();
  const [error, setError] = useState<{ title: string; body: string } | null>(null);
  const ranRef = useRef(false);

  useEffect(() => {
    // An authorization code is single-use. React 18 StrictMode double-invokes
    // effects in dev, and a second exchange would fail against a spent code
    // and surface as a bogus error - so guard it.
    if (ranRef.current) return;
    ranRef.current = true;

    completeLogin(window.location.search)
      .then(async ({ tokens, returnTo }) => {
        sessionStorage.removeItem(RETRY_KEY);
        await adoptSession(tokens);
        // replace() so the code never lands in history.
        router.replace(returnTo && returnTo.startsWith("/") ? returnTo : "/");
      })
      .catch((e) => {
        const msg = String(e?.message || "");
        const m = msg.toLowerCase();
        // Stale-flow callback: the state/verifier for THIS ?code= lives in
        // another tab's sessionStorage (or is long gone). The canonical case is
        // a password-reset email link - Authentik finishes the recovery flow in
        // a fresh tab, then replays the ORIGINAL tab's pending authorize URL,
        // whose state this tab has never seen. The user is NOT in an error
        // state: they hold a brand-new IdP session. So instead of dead-ending
        // on "Sign-in expired", restart a clean login once - it completes
        // silently against that session and lands them in the app.
        const stale = m.includes("state mismatch") || m.includes("verifier");
        if (stale && !sessionStorage.getItem(RETRY_KEY)) {
          sessionStorage.setItem(RETRY_KEY, "1");
          void beginLogin("/");
          return;
        }
        sessionStorage.removeItem(RETRY_KEY);
        setError(friendlyAuthError(msg));
      });
  }, [adoptSession, router]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f4f3f9] p-6">
        <div className="w-full max-w-md rounded-2xl border border-[#eae7f2] bg-white p-8 text-center shadow-sm">
          <h1 className="mb-2 text-lg font-semibold text-[#1d1a26]">{error.title}</h1>
          <p className="mb-6 text-sm text-[#5b556b]">{error.body}</p>
          <button
            onClick={() => router.replace("/login")}
            className="rounded-lg bg-gradient-to-r from-[#7C3291] to-[#5A72B3] px-5 py-2.5 text-sm font-medium text-white"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f4f3f9]">
      <div className="text-center">
        <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-[#7C3291] border-t-transparent" />
        <p className="text-sm text-[#5b556b]">Signing you in...</p>
      </div>
    </div>
  );
}

/**
 * Turn a raw auth/token/profile error into friendly, brand-consistent copy with
 * a clear recovery path - the user should never see a stack-trace-y string or
 * the word "Authentik".
 */
function friendlyAuthError(msg: string): { title: string; body: string } {
  const m = msg.toLowerCase();
  if (m.includes("no_account") || m.includes("user not found") || m.includes("404")) {
    return {
      title: "Account not set up",
      body: "You signed in, but you don't have access to a GOTCHA workspace yet. Ask your administrator to invite you, then try again.",
    };
  }
  if (m.includes("inactive") || m.includes("disabled")) {
    return { title: "Account disabled", body: "Your account has been disabled. Please contact your workspace administrator." };
  }
  if (m.includes("state mismatch") || m.includes("verifier") || m.includes("restart")) {
    return { title: "Sign-in expired", body: "This sign-in link expired or was already used. Please sign in again." };
  }
  return { title: "We couldn't sign you in", body: "Something went wrong completing sign-in. Please try again." };
}
