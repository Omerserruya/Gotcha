"use client";

/**
 * Landing page for a COMPLETED Authentik flow that ran inside a GOTCHA iframe
 * (MFA / passkey / recovery-code setup). Authentik redirects a finished flow to
 * its `next` URL; we point that at this page so, instead of Authentik's own
 * dashboard appearing inside our popup, a completed flow tells the parent window
 * it is done and the modal / enrolment gate can close or advance.
 */

import { useEffect } from "react";
import { FLOW_DONE_MESSAGE } from "@/lib/oidc";

export default function FlowDonePage() {
  useEffect(() => {
    const payload = { type: FLOW_DONE_MESSAGE };
    // We are same-origin with the parent (both dev.gotcha.co.il), but "*" is
    // safe here - the message carries no secret, only a "flow finished" ping.
    try { window.parent?.postMessage(payload, "*"); } catch { /* not framed */ }
    try { window.opener?.postMessage(payload, "*"); } catch { /* not a popup */ }
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-white p-6">
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
          <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-sm font-medium text-gray-900">You&apos;re all set.</p>
        <p className="mt-1 text-xs text-gray-500">You can close this window.</p>
      </div>
    </div>
  );
}
