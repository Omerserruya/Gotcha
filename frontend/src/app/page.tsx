"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Script from "next/script";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import LandingPage from "@/components/landing/LandingPage";

// Server-rendered, always-present description of the app's purpose. It lives in
// the initial HTML on every render branch so search crawlers and Google's OAuth
// branding reviewer (which may not run JS and otherwise only sees the loading
// shell) can read what GOTCHA is. `sr-only` keeps it out of the visual design;
// the <noscript> copy gives a real, visible homepage when JavaScript is off.
const PURPOSE_TITLE = "GOTCHA — AI-Powered Customer Communication Platform";
const PURPOSE_TEXT =
  "GOTCHA is an AI-powered customer communication platform for businesses. It unifies every customer channel — WhatsApp, Instagram, Facebook Messenger, email, web chat and phone calls — into one unified inbox, and adds AI Employees and an AI Co-Pilot that automate routine conversations, assist human agents in real time, and turn every conversation into customer intelligence in your CRM. Connect your messaging and email accounts to read, organize and reply to customer messages from a single dashboard.";

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
  const { user, isLoading } = useAuth();
  const { t } = useI18n();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && user) {
      router.replace("/conversations");
    }
  }, [user, isLoading, router]);

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

  if (user) {
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
          __html: `
            window.__chatcenter = {
              widgetId: "widget_5a3961c3f5dc11493517ffac",
              apiUrl: "https://gotcha.co.il",
              color: "#733fee",
              iconUrl: " https://img.icons8.com/?size=48&id=4cjwkaJ1Zo0u&format=png",
            };
            var s = document.createElement("script");
            s.src = "https://gotcha.co.il/widget/chatcenter-widget.js";
            s.async = true;
            document.head.appendChild(s);
          `,
        }}
      />
    </>
  );
}
