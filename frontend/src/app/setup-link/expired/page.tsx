"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { requestNewSetupLink } from "@/lib/api";

/**
 * Where a setup link that cannot be redeemed lands.
 *
 * This page exists because of what the old failure looked like. An expired
 * invitation used to hand the person straight to Authentik's recovery flow,
 * which happily rendered "Set your password", accepted a password, and only
 * then refused with "Request has been denied. No user found and can't create
 * new user." Nobody could tell from that screen that the link had simply gone
 * stale, and the wording suggested their account did not exist.
 *
 * So: say what happened, in one sentence, and put the repair on the same
 * screen. The dead token travels in the URL, which is what lets the button work
 * without asking an anonymous visitor for an email address.
 */
export default function SetupLinkExpiredPage() {
  return (
    <Suspense fallback={<Shell><p className="text-sm text-gray-500">Loading…</p></Shell>}>
      <ExpiredContent />
    </Suspense>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-8">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-lg border border-gray-100 p-7 space-y-5">
        {children}
      </div>
    </div>
  );
}

/**
 * One line per reason. Every one of them is written to be true and calm: none
 * of these states means anything is wrong with the person's account.
 */
const REASONS: Record<string, { title: string; body: string; canResend: boolean }> = {
  expired: {
    title: "That link has expired",
    body: "Setup links are good for 48 hours. Ask for a new one and it will be in your inbox in a moment.",
    canResend: true,
  },
  revoked: {
    title: "That link was replaced",
    body: "A newer setup link was sent to you, so this older one stopped working. Check your inbox for the most recent email, or ask for another.",
    canResend: true,
  },
  invalid: {
    title: "That link is not valid",
    body: "It may have been copied incompletely. Try clicking the link in your email again rather than pasting it.",
    canResend: false,
  },
  identity_missing: {
    title: "We could not find your account",
    body: "Ask whoever invited you to send a fresh invitation.",
    canResend: false,
  },
  idp_unavailable: {
    title: "Our sign-in service did not answer",
    body: "Your link is fine. This is on our side, and trying again in a minute usually works.",
    canResend: true,
  },
};

function ExpiredContent() {
  const params = useSearchParams();
  const reason = params?.get("reason") || "expired";
  const token = params?.get("t") || "";
  const copy = REASONS[reason] ?? REASONS.expired;

  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleResend() {
    if (!token) return;
    setSending(true);
    setError("");
    try {
      await requestNewSetupLink(token);
      setSent(true);
    } catch (err: any) {
      setError(err?.message || "Could not send a new link. Please try again in a minute.");
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <Shell>
        <div className="text-center space-y-3">
          <div className="mx-auto w-11 h-11 rounded-full bg-green-50 text-green-600 flex items-center justify-center text-xl">
            &#10003;
          </div>
          <h1 className="text-xl font-bold text-gray-900">Check your inbox</h1>
          <p className="text-sm text-gray-500">
            A new setup link is on its way. It is good for 48 hours, and it replaces every
            earlier link.
          </p>
          <p className="text-xs text-gray-400 pt-2">
            Nothing arrived? Look in spam, then ask whoever invited you to resend it.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="space-y-2">
        <h1 className="text-xl font-bold text-gray-900">{copy.title}</h1>
        <p className="text-sm text-gray-500">{copy.body}</p>
      </div>

      {error && <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm">{error}</div>}

      {copy.canResend && token && (
        <button
          type="button"
          onClick={handleResend}
          disabled={sending}
          className="w-full py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition disabled:opacity-50 shadow-lg shadow-primary-500/25"
        >
          {sending ? "Sending…" : "Email me a new link"}
        </button>
      )}

      <p className="text-center text-xs text-gray-400">
        Already set a password?{" "}
        <a href="/login" className="text-primary-600 hover:text-primary-700">
          Log in
        </a>
      </p>
    </Shell>
  );
}
