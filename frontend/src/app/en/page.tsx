import type { Metadata } from "next";
import LandingPage from "@/components/landing/LandingPage";

export const metadata: Metadata = {
  title: "GOTCHA - AI-Powered Customer Communication",
  description:
    "Unify WhatsApp Business, Instagram DMs, and Facebook Messenger into one AI-powered unified inbox. Automate customer support with smart routing, AI co-pilot suggestions, and real-time analytics. Manage multiple agents across social messaging channels from a single dashboard.",
  alternates: {
    canonical: "/en",
    languages: { en: "/en", he: "/he" },
  },
  openGraph: {
    title: "GOTCHA - AI-Powered Customer Communication",
    description:
      "Unify WhatsApp Business, Instagram DMs, and Messenger into one AI-powered unified inbox. Smart routing, AI co-pilot, and real-time analytics for customer support teams.",
    url: "https://gotcha.co.il/en",
    locale: "en_US",
    type: "website",
    images: [{ url: "/logo.png", width: 512, height: 512, alt: "GOTCHA logo" }],
  },
};

export default function EnglishLanding() {
  return <LandingPage forcedLocale="en" />;
}
