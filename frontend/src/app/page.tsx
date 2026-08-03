"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Script from "next/script";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import LandingPage from "@/components/landing/LandingPage";
import { cachedJourneyIncomplete, refreshJourneyIncomplete } from "@/lib/journey-cache";
import { rendersMarketing } from "@/lib/marketing-origin";

// Server-rendered, always-present description of the app's purpose. It lives in
// the initial HTML on every render branch so search crawlers and Google's OAuth
// branding reviewer (which may not run JS and otherwise only sees the loading
// shell) can read what GOTCHA is. `sr-only` keeps it out of the visual design;
// the <noscript> copy gives a real, visible homepage when JavaScript is off.
const PURPOSE_TITLE = "GOTCHA - AI-Powered Customer Communication Platform";
const PURPOSE_TEXT =
  "GOTCHA is an AI-powered customer communication platform for businesses. It unifies every customer channel - WhatsApp, Instagram, Facebook Messenger, email, web chat and phone calls - into one unified inbox, and adds AI Employees and an AI Co-Pilot that automate routine conversations, assist human agents in real time, and turn every conversation into customer intelligence in your CRM. Connect your messaging and email accounts to read, organize and reply to customer messages from a single dashboard.";

function PurposeStatement() {
  return (
    <>
      <div className="sr-only">
        <h1>{PURPOSE_TITLE}</h1>
        <p>{PURPOSE_TEXT}</p>
        <p>
          GOTCHA helps customer support, sales and operations teams respond faster and deliver
          personalized service across every channel. <a href="/early-access">Get early access</a>.
        </p>
      </div>
      <noscript>
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "56px 24px", fontFamily: "Inter, system-ui, sans-serif", color: "#1e1b4b" }}>
          <h1 style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.2, marginBottom: 14 }}>{PURPOSE_TITLE}</h1>
          <p style={{ fontSize: 16, lineHeight: 1.7, color: "#475569", marginBottom: 16 }}>{PURPOSE_TEXT}</p>
          <p style={{ fontSize: 15 }}>
            <a href="/early-access" style={{ color: "#7c5cfc", fontWeight: 600 }}>Get early access</a>
          </p>
        </div>
      </noscript>
    </>
  );
}

export default function Home() {
  const { user, token, isLoading } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  // Suppresses the landing page for the frame between deciding to redirect and
  // the router actually leaving. Without it the application host flashes
  // marketing at a logged-out visitor on its way to /login.
  const [leavingForLogin, setLeavingForLogin] = useState(false);

  useEffect(() => {
    if (isLoading) return;

    // On the APPLICATION host the root is not a marketing page. Someone who
    // opens app.gotcha.co.il while logged out came here to sign in, so send
    // them to the login screen; the landing page belongs to the marketing
    // origin and is served there. With no marketing origin configured (dev)
    // rendersMarketing() is true and this does nothing.
    if (!user) {
      if (typeof window !== "undefined" && !rendersMarketing(window.location.origin)) {
        setLeavingForLogin(true);
        router.replace("/login");
      }
      return;
    }
    // Admins with an unfinished first-steps journey land on Getting Started;
    // everyone else lands on the inbox. The cached flag answers instantly
    // (no fetch-before-redirect lag); only a cold cache waits for the server.
    if (user.role === "ADMIN" && token) {
      const cached = cachedJourneyIncomplete();
      if (cached !== null) {
        router.replace(cached ? "/getting-started" : "/conversations");
        refreshJourneyIncomplete(token); // keep the cache fresh in the background
        return;
      }
      let cancelled = false;
      refreshJourneyIncomplete(token).then((v) => {
        if (!cancelled) router.replace(v ? "/getting-started" : "/conversations");
      });
      return () => { cancelled = true; };
    }
    router.replace("/conversations");
  }, [user, token, isLoading, router]);

  if (isLoading) {
    return (
      <>
        <PurposeStatement />
        <div className="flex items-center justify-center min-h-screen">
          <div className="animate-pulse text-lg text-gray-500">{t("app.loading")}</div>
        </div>
      </>
    );
  }

  if (user || leavingForLogin) {
    return (
      <>
        <PurposeStatement />
        <div className="flex items-center justify-center min-h-screen">
          <div className="animate-pulse text-lg text-gray-500">{t("app.loading")}</div>
        </div>
      </>
    );
  }

  return (
    <>
      <PurposeStatement />
      <LandingPage />
      <Script
        id="chatcenter-widget"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{
          // Same origin as the page it is on, rather than a hard-coded
          // production host. On dev that hard-coding made the script
          // cross-origin, so our own CSP (script-src 'self') blocked it
          // and our own site never showed the widget we ship.
          //
          // Colour and icon are no longer set here either: they live in
          // the widget's configuration now, alongside every other channel,
          // and a copy in this snippet would quietly win over it.
          __html: `
            window.__chatcenter = {
              widgetId: "widget_5a3961c3f5dc11493517ffac",
              apiUrl: window.location.origin,
            };
            var s = document.createElement("script");
            s.src = window.location.origin + "/widget/chatcenter-widget.js";
            s.async = true;
            document.head.appendChild(s);
          `,
        }}
      />
    </>
  );
}
