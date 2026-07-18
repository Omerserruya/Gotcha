"use client";

/**
 * Email-change confirmation landing. The user arrives here from the link sent
 * to their NEW address. Confirming requires being signed in as the same account
 * (defense in depth), so it POSTs the signed token with the session bearer.
 */

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { verifyEmailChange } from "@/lib/api";

function VerifyInner() {
  const { user, token, isLoading, login } = useAuth();
  const { locale } = useI18n();
  const he = locale === "he";
  const L = (en: string, heb: string) => (he ? heb : en);
  const params = useSearchParams();
  const router = useRouter();
  const changeToken = params.get("token") || "";
  const [state, setState] = useState<"working" | "ok" | "error">("working");
  const [msg, setMsg] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (isLoading) return;
    if (!user || !token) { login(`/account/verify-email?token=${encodeURIComponent(changeToken)}`); return; }
    if (!changeToken) { setState("error"); setMsg(L("Missing confirmation token.", "חסר טוקן אישור.")); return; }
    verifyEmailChange(token, changeToken)
      .then((r) => { setState("ok"); setEmail(r.email); })
      .catch((e: any) => {
        setState("error");
        const code = String(e?.message || "");
        setMsg(
          code.includes("wrong_account") ? L("This link belongs to a different account.", "הקישור שייך לחשבון אחר.")
          : code.includes("email_taken") ? L("That email is already in use.", "הדוא\"ל כבר בשימוש.")
          : code.includes("idp_sync") ? L("We couldn't finish the change. Please try again.", "לא הצלחנו להשלים. נסו שוב.")
          : L("This confirmation link is invalid or has expired.", "קישור האישור אינו תקין או שפג תוקפו."),
        );
      });
  }, [isLoading, user, token, changeToken]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4" dir={he ? "rtl" : "ltr"}>
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <Image src="/logo_icon.png" alt="GOTCHA" width={120} height={28} style={{ height: 28, width: "auto" }} className="mx-auto mb-6" priority />
        {state === "working" && (
          <>
            <span className="mx-auto mb-4 block h-8 w-8 animate-spin rounded-full border-2 border-primary-200 border-t-primary-600" />
            <p className="text-sm text-gray-500">{L("Confirming your new email…", "מאשר את הדוא\"ל החדש…")}</p>
          </>
        )}
        {state === "ok" && (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-green-600">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
            </div>
            <h1 className="text-lg font-bold text-gray-900">{L("Email updated", "הדוא\"ל עודכן")}</h1>
            <p className="mt-2 text-sm text-gray-500">{L("Your sign-in email is now", "דוא\"ל הכניסה שלך הוא כעת")} <strong className="text-gray-800">{email}</strong>.</p>
            <Link href="/account" className="mt-6 inline-flex rounded-xl bg-gradient-to-r from-primary-600 to-primary-500 px-5 py-2.5 text-sm font-semibold text-white">{L("Back to account", "חזרה לחשבון")}</Link>
          </>
        )}
        {state === "error" && (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-red-600">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </div>
            <h1 className="text-lg font-bold text-gray-900">{L("Couldn't confirm", "לא הצלחנו לאשר")}</h1>
            <p className="mt-2 text-sm text-gray-500">{msg}</p>
            <button onClick={() => router.push("/account")} className="mt-6 inline-flex rounded-xl border border-gray-200 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50">{L("Back to account", "חזרה לחשבון")}</button>
          </>
        )}
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-gray-50"><span className="h-6 w-6 animate-spin rounded-full border-2 border-primary-200 border-t-primary-600" /></div>}>
      <VerifyInner />
    </Suspense>
  );
}
