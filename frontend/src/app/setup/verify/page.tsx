"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { verifyMagicLink } from "@/lib/api";

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
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-purple-50">
        <div className="text-center">
          <div className="relative mx-auto mb-6 w-16 h-16">
            <div className="absolute inset-0 rounded-full bg-indigo-100 animate-ping opacity-25" />
            <div className="relative w-16 h-16 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
              <svg className="w-8 h-8 text-white animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            </div>
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Verifying your link...</h2>
          <p className="text-gray-500">Please wait while we authenticate you</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-purple-50 px-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-lg border border-gray-100 p-8 text-center">
        <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-5">
          <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">Link Verification Failed</h2>
        <p className="text-gray-500 mb-6">{error}</p>
        <div className="space-y-3">
          <button
            onClick={() => router.push("/login")}
            className="w-full py-3 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-medium rounded-xl transition shadow-lg shadow-indigo-500/25"
          >
            Go to Login
          </button>
          <p className="text-xs text-gray-400">
            Contact your system administrator if you need a new setup link.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function VerifyMagicLinkPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-purple-50">
          <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full" />
        </div>
      }
    >
      <VerifyContent />
    </Suspense>
  );
}
