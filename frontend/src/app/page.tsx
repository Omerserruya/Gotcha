"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Script from "next/script";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import LandingPage from "@/components/landing/LandingPage";

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
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-pulse text-lg text-gray-500">{t("app.loading")}</div>
      </div>
    );
  }

  if (user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-pulse text-lg text-gray-500">{t("app.loading")}</div>
      </div>
    );
  }

  return (
    <>
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
