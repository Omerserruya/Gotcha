import type { Metadata } from "next";
import LandingPage from "@/components/landing/LandingPage";

export const metadata: Metadata = {
  title: "GOTCHA — AI-Powered Customer Communication",
  description:
    "Unify WhatsApp, Messenger, and Instagram into one AI-powered inbox. Smart routing, AI co-pilot, and real-time analytics for support teams.",
  alternates: {
    canonical: "/en",
    languages: { en: "/en", he: "/he" },
  },
  openGraph: {
    title: "GOTCHA — AI-Powered Customer Communication",
    description:
      "Unify WhatsApp, Messenger, and Instagram into one AI-powered inbox. Smart routing, AI co-pilot, and real-time analytics.",
    url: "https://gotcha.co.il/en",
    locale: "en_US",
    type: "website",
    images: [{ url: "/logo.png", width: 512, height: 512, alt: "GOTCHA logo" }],
  },
};

export default function EnglishLanding() {
  return <LandingPage forcedLocale="en" />;
}
