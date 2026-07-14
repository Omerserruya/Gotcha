"use client";

// Magic-link verification - the very first screen after the email click, so it
// wears the same light identity as the setup flow it opens (wordmark, violet,
// calm canvas), not a separate look.

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { verifyMagicLink } from "@/lib/api";

function Wordmark() {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/logo_icon.png" alt="GOTCHA" className="h-7 w-auto" />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#fafafa] flex flex-col">
      <header className="px-6 md:px-10 py-6"><Wordmark /></header>
      <main className="flex-1 flex items-center justify-center px-6 pb-24">{children}</main>
    </div>
  );
}

function VerifyContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login } = useAuth();
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState(true);

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) {
      setError("Invalid link - no token provided.");
      setVerifying(false);
      return;
    }

    verifyMagicLink(token)
      .then((res) => {
        login(res.token, res.user, res.refreshToken);
        router.replace("/setup");
      })
      .catch((err) => {
        setError(err.message || "Failed to verify link. It may have expired or already been used.");
        setVerifying(false);
      });
  }, [searchParams, login, router]);

  if (verifying) {
    return (
      <Shell>
        <div className="text-center animate-riseIn">
          <span className="relative inline-flex w-14 h-14 items-center justify-center mb-6">
            <span className="absolute inset-0 rounded-2xl bg-gradient-to-br from-primary-400 to-primary-600 animate-pulseSoft" />
            <span className="relative text-white text-xl">◎</span>
          </span>
          <h2 className="text-2xl font-bold text-gray-900 tracking-tight">Opening your workspace…</h2>
          <p className="text-gray-500 mt-2">One moment while I verify your link.</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="max-w-md w-full text-center animate-riseIn">
        <span className="inline-flex w-14 h-14 rounded-2xl bg-amber-50 border border-amber-100 items-center justify-center mb-6">
          <svg className="w-7 h-7 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </span>
        <h2 className="text-2xl font-bold text-gray-900 tracking-tight">This link didn&apos;t work</h2>
        <p className="text-gray-500 mt-2 leading-relaxed">{error}</p>
        <button
          onClick={() => router.push("/login")}
          className="mt-8 inline-flex items-center justify-center px-8 py-3.5 bg-primary-500 hover:bg-primary-600 text-white text-base font-semibold rounded-2xl transition shadow-lg shadow-primary-500/25"
        >
          Go to login →
        </button>
        <p className="text-xs text-gray-400 mt-4">Contact your system administrator if you need a new setup link.</p>
      </div>
    </Shell>
  );
}

export default function VerifyMagicLinkPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[#fafafa]">
          <div className="animate-spin w-8 h-8 border-4 border-primary-500 border-t-transparent rounded-full" />
        </div>
      }
    >
      <VerifyContent />
    </Suspense>
  );
}
